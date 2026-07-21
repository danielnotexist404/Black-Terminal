import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import {
  assertSocialMutationAllowed, assertValue, badRequest, canViewPost, cleanText, emitSocialNotification,
  enforceSocialRateLimit, ensureNetworkProfile, postVisibilities, recordSocialMentions, signMediaRows,
  socialPostTypes, validateStoredImage
} from "../social-utils.js";

const PAGE_SIZE = 20;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    if (req.method === "GET") return listPosts(req, res, supabase, user);
    if (req.method === "POST") return createPost(req, res, supabase, user);
    if (req.method === "PATCH") return editPost(req, res, supabase, user);
    if (req.method === "DELETE") return deletePost(req, res, supabase, user);
    requireMethod(req, "GET");
  } catch (error) {
    return sendError(res, error);
  }
}

async function listPosts(req, res, supabase, user) {
  if (req.query?.postId) {
    const { data: post, error } = await supabase.from("profile_posts").select("*").eq("id", String(req.query.postId)).is("deleted_at", null).eq("status", "published").maybeSingle();
    if (error) throw error;
    if (!post || !(await canViewPost(supabase, user.id, post))) return res.status(404).json({ error: "Post unavailable." });
    return res.status(200).json({ post: (await hydratePosts(supabase, user.id, [post]))[0] });
  }
  const mode = String(req.query?.mode || "for_you");
  const cursor = req.query?.cursor ? String(req.query.cursor) : null;
  let followingIds = null;
  let query = supabase.from("profile_posts").select("*").is("deleted_at", null).eq("status", "published").order("created_at", { ascending: false }).limit(80);
  if (cursor) query = query.lt("created_at", cursor);
  if (req.query?.postType) query = query.eq("post_type", req.query.postType);
  if (mode === "research") query = query.in("post_type", ["macro_research", "quantitative_research", "technical_analysis", "orderflow_analysis", "risk_commentary"]);
  if (mode === "market_analysis") query = query.in("post_type", ["market_research", "technical_analysis", "orderflow_analysis", "market_opinion", "trade_idea"]);
  if (mode === "indicators") query = query.eq("post_type", "indicator_release");
  if (mode === "strategies") query = query.eq("post_type", "strategy_note");
  if (mode === "investment_groups") query = query.in("post_type", ["group_announcement", "group_update"]);
  if (mode === "profile" && req.query?.handle) {
    const { data: profile } = await supabase.from("profiles_extended").select("user_id").eq("handle", String(req.query.handle).toLowerCase()).maybeSingle();
    if (!profile) return res.status(200).json({ posts: [], nextCursor: null });
    query = query.eq("user_id", profile.user_id);
  }
  if (mode === "group" && req.query?.groupId) query = query.eq("investment_group_id", req.query.groupId);
  if (mode === "following") {
    const { data: follows, error } = await supabase.from("user_follows").select("followed_user_id").eq("follower_user_id", user.id);
    if (error) throw error;
    followingIds = (follows || []).map((item) => item.followed_user_id);
    if (!followingIds.length) return res.status(200).json({ posts: [], nextCursor: null });
    query = query.in("user_id", followingIds);
  }
  if (mode === "saved") {
    const { data: saved, error } = await supabase.from("social_saved_posts").select("post_id").eq("user_id", user.id).order("created_at", { ascending: false }).limit(80);
    if (error) throw error;
    const ids = (saved || []).map((item) => item.post_id);
    if (!ids.length) return res.status(200).json({ posts: [], nextCursor: null });
    query = query.in("id", ids);
  }

  const { data, error } = await query;
  if (error) throw error;
  const [mutes, hidden] = await Promise.all([
    supabase.from("user_mutes").select("muted_user_id").eq("user_id", user.id),
    supabase.from("social_hidden_posts").select("post_id").eq("user_id", user.id)
  ]);
  if (mutes.error) throw mutes.error;
  if (hidden.error) throw hidden.error;
  const mutedUsers = new Set((mutes.data || []).map((item) => item.muted_user_id));
  const hiddenPosts = new Set((hidden.data || []).map((item) => item.post_id));
  const visible = [];
  for (const post of data || []) {
    if (mutedUsers.has(post.user_id) || hiddenPosts.has(post.id)) continue;
    if (await canViewPost(supabase, user.id, post)) visible.push(post);
  }
  if (["for_you", "following"].includes(mode)) {
    let repostQuery = supabase.from("social_reposts").select("post_id,user_id,commentary,created_at").order("created_at", { ascending: false }).limit(60);
    if (cursor) repostQuery = repostQuery.lt("created_at", cursor);
    if (mode === "following") repostQuery = repostQuery.in("user_id", followingIds || []);
    const { data: repostRows, error: repostError } = await repostQuery;
    if (repostError) throw repostError;
    const allowedRows = (repostRows || []).filter((row) => !mutedUsers.has(row.user_id) && !hiddenPosts.has(row.post_id));
    const repostPostIds = [...new Set(allowedRows.map((row) => row.post_id))];
    if (repostPostIds.length) {
      const { data: originals, error: originalsError } = await supabase.from("profile_posts").select("*").in("id", repostPostIds).is("deleted_at", null).eq("status", "published");
      if (originalsError) throw originalsError;
      for (const original of originals || []) {
        if (visible.some((post) => post.id === original.id)) continue;
        if (!(await canViewPost(supabase, user.id, original))) continue;
        const context = allowedRows.find((row) => row.post_id === original.id);
        visible.push({ ...original, feed_context: { type: "repost", user_id: context.user_id, commentary: context.commentary, created_at: context.created_at } });
      }
    }
  }
  visible.sort((left, right) => new Date(right.feed_context?.created_at || right.created_at).getTime() - new Date(left.feed_context?.created_at || left.created_at).getTime());
  const page = visible.slice(0, PAGE_SIZE);
  const hydrated = await hydratePosts(supabase, user.id, page);
  return res.status(200).json({ posts: hydrated, nextCursor: page.length === PAGE_SIZE ? (page.at(-1).feed_context?.created_at || page.at(-1).created_at) : null });
}

async function createPost(req, res, supabase, user) {
  await enforceSocialRateLimit(supabase, user.id, "post", 12, 3600);
  const postType = assertValue(socialPostTypes, String(req.body.postType || "status"), "post type");
  const visibility = assertValue(postVisibilities, String(req.body.visibility || "public"), "post visibility");
  const body = cleanText(req.body.body, 20000, true);
  const mentions = [...new Set(body.match(/@[a-z0-9_]{3,30}/gi) || [])].slice(0, 11);
  if (mentions.length > 10) throw badRequest("A post may mention at most 10 professionals.");
  if (mentions.length) await enforceSocialRateLimit(supabase, user.id, "mention", 40, 3600);
  const title = cleanText(req.body.title, 240);
  const groupId = req.body.investmentGroupId || null;
  if (visibility === "group") {
    if (!groupId) throw badRequest("Investment Group visibility requires a group.");
    await assertGroupMembership(supabase, user.id, groupId);
  }
  const idempotencyKey = cleanText(req.body.idempotencyKey, 120) || `post-${user.id}-${Date.now()}`;
  const symbols = cleanList(req.body.symbols, 12, (value) => value.toUpperCase().replace(/[^A-Z0-9._/-]/g, "").slice(0, 24));
  const requestedMedia = Array.isArray(req.body.media) ? req.body.media.slice(0, 8) : [];
  requestedMedia.forEach((item) => assertOwnedPostMedia(item.storagePath, user.id));
  const media = await Promise.all(requestedMedia.map(async (item) => ({ ...item, ...(await validateStoredImage(supabase, item.storagePath, item.mimeType)) })));
  const requestedAttachments = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 6) : [];
  const attachments = await validatePublishedAttachments(supabase, requestedAttachments);

  const { data: post, error } = await supabase.from("profile_posts").insert({
    user_id: user.id,
    investment_group_id: groupId,
    post_type: postType,
    title: title || null,
    summary: cleanText(req.body.summary, 600) || null,
    body,
    asset_class: cleanText(req.body.assetClass, 60) || null,
    directional_bias: cleanText(req.body.directionalBias, 24) || null,
    timeframe: cleanText(req.body.timeframe, 24) || null,
    visibility,
    comments_enabled: req.body.commentsEnabled !== false,
    risk_disclaimer: cleanText(req.body.riskDisclaimer, 1000),
    status: cleanText(req.body.status, 32) || "published",
    parent_post_id: req.body.parentPostId || null,
    quoted_post_id: req.body.quotedPostId || null,
    idempotency_key: idempotencyKey,
    metadata: safeMetadata(req.body.metadata)
  }).select("*").single();
  if (error?.code === "23505") {
    const { data: existing } = await supabase.from("profile_posts").select("*").eq("user_id", user.id).eq("idempotency_key", idempotencyKey).single();
    return res.status(200).json({ post: (await hydratePosts(supabase, user.id, [existing]))[0], duplicatePrevented: true });
  }
  if (error) throw error;

  const inserts = [];
  if (symbols.length) inserts.push(supabase.from("social_post_symbols").insert(symbols.map((symbol) => ({ post_id: post.id, symbol }))));
  if (media.length) inserts.push(supabase.from("social_post_media").insert(media.map((item, index) => ({
    post_id: post.id,
    owner_user_id: user.id,
    storage_path: item.storagePath,
    media_type: item.mediaType || "image",
    mime_type: item.mimeType,
    byte_size: Number(item.byteSize),
    width: Number(item.width) || null,
    height: Number(item.height) || null,
    alt_text: cleanText(item.altText, 300),
    metadata: { caption: cleanText(item.caption, 500), ...(item.mediaType === "chart_snapshot" ? { chart_snapshot: safeSnapshotMetadata(item.snapshotMetadata) } : {}) },
    sort_order: index
  }))));
  if (attachments.length) inserts.push(supabase.from("social_post_attachments").insert(attachments.map((item) => ({
    post_id: post.id,
    attachment_type: item.type,
    indicator_id: item.type === "indicator" ? item.referenceId : null,
    strategy_id: item.type === "strategy" ? item.referenceId : null,
    title: item.title,
    public_metadata: item.metadata
  }))));
  const results = await Promise.all(inserts);
  results.forEach((result) => { if (result.error) throw result.error; });
  if (mentions.length) await recordSocialMentions(supabase, { sourceType: "post", sourceId: post.id, postId: post.id, actorUserId: user.id, body });

  const { data: followers } = await supabase.from("user_follows").select("follower_user_id").eq("followed_user_id", user.id).limit(500);
  await Promise.all((followers || []).map((follower) => emitSocialNotification(supabase, {
    userId: follower.follower_user_id,
    actorUserId: user.id,
    eventType: postType.includes("research") ? "research_publication" : "post_created",
    title: postType.includes("research") ? "New Professional Research" : "New Professional Post",
    body: title || body.slice(0, 100),
    postId: post.id,
    deepLink: `/network/post/${post.id}`
  })));
  return res.status(201).json({ post: (await hydratePosts(supabase, user.id, [post]))[0] });
}

async function editPost(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "posting");
  const postId = String(req.body.postId || "");
  const { data: current, error } = await supabase.from("profile_posts").select("*").eq("id", postId).eq("user_id", user.id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!current) return res.status(404).json({ error: "Post not found or not editable." });
  await supabase.from("social_post_edits").insert({ post_id: current.id, editor_user_id: user.id, prior_title: current.title, prior_body: current.body, prior_metadata: current.metadata });
  const patch = {
    title: req.body.title === undefined ? current.title : cleanText(req.body.title, 240) || null,
    body: req.body.body === undefined ? current.body : cleanText(req.body.body, 20000, true),
    status: req.body.status === undefined ? current.status : cleanText(req.body.status, 32),
    risk_disclaimer: req.body.riskDisclaimer === undefined ? current.risk_disclaimer : cleanText(req.body.riskDisclaimer, 1000),
    metadata: req.body.metadata === undefined ? current.metadata : safeMetadata(req.body.metadata),
    edited_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const { data, error: updateError } = await supabase.from("profile_posts").update(patch).eq("id", postId).select("*").single();
  if (updateError) throw updateError;
  const priorLifecycle = current.metadata?.lifecycle;
  const nextLifecycle = data.metadata?.lifecycle;
  if (current.post_type === "trade_idea" && nextLifecycle && nextLifecycle !== priorLifecycle) {
    const { error: eventError } = await supabase.from("social_post_attachments").insert({
      post_id: current.id,
      attachment_type: "trade_idea_update",
      title: `Trade idea updated: ${String(nextLifecycle).replaceAll("_", " ")}`,
      public_metadata: { from: priorLifecycle || null, to: nextLifecycle, recorded_at: new Date().toISOString() }
    });
    if (eventError) throw eventError;
  }
  if (req.body.body !== undefined) {
    const { error: mentionDeleteError } = await supabase.from("social_mentions").delete().eq("source_type", "post").eq("source_id", current.id);
    if (mentionDeleteError) throw mentionDeleteError;
    await recordSocialMentions(supabase, { sourceType: "post", sourceId: current.id, postId: current.id, actorUserId: user.id, body: data.body });
  }
  return res.status(200).json({ post: (await hydratePosts(supabase, user.id, [data]))[0] });
}

async function deletePost(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "posting");
  const postId = String(req.body?.postId || req.query?.postId || "");
  const { data, error } = await supabase.from("profile_posts").update({ deleted_at: new Date().toISOString(), status: "deleted", updated_at: new Date().toISOString() }).eq("id", postId).eq("user_id", user.id).is("deleted_at", null).select("id").maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Post not found or not deletable." });
  return res.status(200).json({ deleted: true, postId });
}

export async function hydratePosts(supabase, viewerId, posts) {
  if (!posts.length) return [];
  const postIds = posts.map((post) => post.id);
  const quotedIds = [...new Set(posts.map((post) => post.quoted_post_id).filter(Boolean))];
  const commentPreview = await supabase.from("social_comments").select("id,post_id,parent_comment_id,author_user_id,body,created_at,edited_at").in("post_id", postIds).is("deleted_at", null).order("created_at").limit(400);
  if (commentPreview.error) throw commentPreview.error;
  const quotedResult = quotedIds.length
    ? await supabase.from("profile_posts").select("id,user_id,post_type,title,body,visibility,investment_group_id,created_at,deleted_at,status").in("id", quotedIds).is("deleted_at", null).eq("status", "published")
    : { data: [], error: null };
  if (quotedResult.error) throw quotedResult.error;
  const visibleQuotes = [];
  for (const quote of quotedResult.data || []) if (await canViewPost(supabase, viewerId, quote)) visibleQuotes.push(quote);
  const authorIds = [...new Set([...posts.map((post) => post.user_id), ...(commentPreview.data || []).map((comment) => comment.author_user_id), ...visibleQuotes.map((quote) => quote.user_id)])];
  const [profiles, symbols, media, attachments, reactions, reposts, saved, commentCounts] = await Promise.all([
    supabase.from("profiles_extended").select("user_id,handle,display_name,avatar_storage_path,professional_role,verified_role").in("user_id", authorIds),
    supabase.from("social_post_symbols").select("post_id,symbol").in("post_id", postIds),
    supabase.from("social_post_media").select("*").in("post_id", postIds).order("sort_order"),
    supabase.from("social_post_attachments").select("*").in("post_id", postIds),
    supabase.from("social_reactions").select("post_id,user_id,reaction_type").in("post_id", postIds),
    supabase.from("social_reposts").select("post_id,user_id").in("post_id", postIds),
    supabase.from("social_saved_posts").select("post_id").eq("user_id", viewerId).in("post_id", postIds),
    Promise.all(postIds.map(async (postId) => {
      const { count, error } = await supabase.from("social_comments").select("id", { count: "exact", head: true }).eq("post_id", postId).is("deleted_at", null);
      if (error) throw error;
      return [postId, count || 0];
    }))
  ]);
  for (const result of [profiles, symbols, media, attachments, reactions, reposts, saved]) if (result.error) throw result.error;
  const signedMedia = await signMediaRows(supabase, media.data || []);
  const signedAuthors = await Promise.all((profiles.data || []).map(async (profile) => {
    const [avatar] = await signMediaRows(supabase, [{ storage_path: profile.avatar_storage_path }]);
    return { ...profile, avatar_signed_url: avatar?.signed_url || null };
  }));
  const profileMap = new Map(signedAuthors.map((profile) => [profile.user_id, profile]));
  const reactionRows = reactions.data || [];
  const commentCountMap = new Map(commentCounts);
  return posts.map((post) => ({
    ...post,
    author: profileMap.get(post.user_id) || null,
    symbols: (symbols.data || []).filter((row) => row.post_id === post.id).map((row) => row.symbol),
    media: signedMedia.filter((row) => row.post_id === post.id),
    attachments: (attachments.data || []).filter((row) => row.post_id === post.id),
    reactions: summarizeReactions(reactionRows.filter((row) => row.post_id === post.id)),
    viewerReaction: reactionRows.find((row) => row.post_id === post.id && row.user_id === viewerId)?.reaction_type || null,
    comments: (commentPreview.data || []).filter((row) => row.post_id === post.id).slice(0, 6).map((comment) => ({ ...comment, author: profileMap.get(comment.author_user_id) || null })),
    commentCount: commentCountMap.get(post.id) || 0,
    repostCount: (reposts.data || []).filter((row) => row.post_id === post.id).length,
    viewerReposted: (reposts.data || []).some((row) => row.post_id === post.id && row.user_id === viewerId),
    saved: (saved.data || []).some((row) => row.post_id === post.id),
    quotedPost: (() => {
      const quote = visibleQuotes.find((item) => item.id === post.quoted_post_id);
      return quote ? { ...quote, author: profileMap.get(quote.user_id) || null } : null;
    })()
  }));
}

async function assertGroupMembership(supabase, userId, groupId) {
  const { data, error } = await supabase.from("investment_group_members").select("id").eq("group_id", groupId).eq("user_id", userId).eq("status", "active").maybeSingle();
  if (error) throw error;
  if (!data) throw badRequest("Active Investment Group membership is required.");
}

function summarizeReactions(rows) {
  const summary = {};
  rows.forEach((row) => { summary[row.reaction_type] = (summary[row.reaction_type] || 0) + 1; });
  return summary;
}

function cleanList(value, limit, transform) {
  return Array.isArray(value) ? [...new Set(value.map((item) => transform(String(item))).filter(Boolean))].slice(0, limit) : [];
}

function assertOwnedPostMedia(path, userId) {
  if (!String(path || "").startsWith(`posts/${userId}/`)) throw badRequest("Post media path is not owned by the current user.");
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function safeSnapshotMetadata(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    symbol: cleanText(source.symbol, 30) || null,
    timeframe: cleanText(source.timeframe, 24) || null,
    exchange: cleanText(source.exchange, 40) || null,
    captured_at: /^\d{4}-\d{2}-\d{2}T/.test(String(source.capturedAt || "")) ? String(source.capturedAt).slice(0, 35) : null,
    indicators: cleanList(source.indicators, 20, (item) => cleanText(item, 80))
  };
}

async function validatePublishedAttachments(supabase, requested) {
  const indicators = requested.filter((item) => item.type === "indicator" && item.referenceId);
  const strategies = requested.filter((item) => item.type === "strategy" && item.referenceId);
  if (indicators.length + strategies.length !== requested.length) throw badRequest("Only published indicators and strategies may be attached.");
  const [indicatorResult, strategyResult] = await Promise.all([
    indicators.length ? supabase.from("published_indicators").select("id,name,description,version,visibility,metadata").in("id", indicators.map((item) => item.referenceId)).eq("visibility", "public") : Promise.resolve({ data: [], error: null }),
    strategies.length ? supabase.from("published_strategies").select("id,name,description,market,timeframe,risk_profile,visibility").in("id", strategies.map((item) => item.referenceId)).eq("visibility", "public") : Promise.resolve({ data: [], error: null })
  ]);
  if (indicatorResult.error) throw indicatorResult.error;
  if (strategyResult.error) throw strategyResult.error;
  const indicatorMap = new Map((indicatorResult.data || []).map((item) => [item.id, item]));
  const strategyMap = new Map((strategyResult.data || []).map((item) => [item.id, item]));
  return requested.map((item) => {
    const asset = item.type === "indicator" ? indicatorMap.get(item.referenceId) : strategyMap.get(item.referenceId);
    if (!asset) throw badRequest("A selected attachment is not publicly published or permission-approved.");
    const metadata = item.type === "indicator"
      ? { version: asset.version, category: asset.metadata?.category || null, description: asset.description }
      : { market: asset.market, timeframe: asset.timeframe, riskProfile: asset.risk_profile, description: asset.description };
    return { type: item.type, referenceId: asset.id, title: cleanText(asset.name, 160, true), metadata };
  });
}
