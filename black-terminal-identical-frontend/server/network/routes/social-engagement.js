import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import {
  assertNoBlock, assertSocialMutationAllowed, assertValue, badRequest, canViewPost, cleanText,
  emitSocialNotification, enforceSocialRateLimit, reactionTypes, recordSocialMentions, reportReasons,
  signMediaRows
} from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    if (req.method === "GET") {
      if (req.query?.view === "collections") return listCollections(res, supabase, user);
      return listComments(req, res, supabase, user);
    }
    requireMethod(req, "POST");
    requireFields(req.body, ["operation"]);
    const operation = String(req.body.operation);
    if (operation === "reaction") return react(req, res, supabase, user);
    if (operation === "comment") return comment(req, res, supabase, user);
    if (operation === "edit_comment") return editComment(req, res, supabase, user);
    if (operation === "delete_comment") return deleteComment(req, res, supabase, user);
    if (operation === "comment_reaction") return reactToComment(req, res, supabase, user);
    if (operation === "save") return save(req, res, supabase, user);
    if (operation === "collection") return mutateCollection(req, res, supabase, user);
    if (operation === "repost") return repost(req, res, supabase, user);
    if (operation === "report") return report(req, res, supabase, user);
    if (operation === "hide") return hide(req, res, supabase, user);
    throw badRequest("Unknown engagement operation.");
  } catch (error) {
    return sendError(res, error);
  }
}

async function listComments(req, res, supabase, user) {
  const post = await visiblePost(supabase, user.id, req.query?.postId);
  const cursor = req.query?.cursor ? String(req.query.cursor) : null;
  let query = supabase.from("social_comments").select("id,post_id,parent_comment_id,author_user_id,body,created_at,edited_at").eq("post_id", post.id).is("deleted_at", null).order("created_at").limit(51);
  if (cursor) query = query.gt("created_at", cursor);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  const page = rows.slice(0, 50);
  const authorIds = [...new Set(page.map((comment) => comment.author_user_id))];
  const commentIds = page.map((comment) => comment.id);
  const [profileResult, reactionResult] = await Promise.all([
    authorIds.length
      ? supabase.from("profiles_extended").select("user_id,handle,display_name,avatar_storage_path").in("user_id", authorIds)
      : Promise.resolve({ data: [], error: null }),
    commentIds.length
      ? supabase.from("social_comment_reactions").select("comment_id,user_id,reaction_type").in("comment_id", commentIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  const { data: profiles, error: profileError } = profileResult;
  if (profileError) throw profileError;
  if (reactionResult.error) throw reactionResult.error;
  const signed = await Promise.all((profiles || []).map(async (profile) => {
    const [avatar] = await signMediaRows(supabase, [{ storage_path: profile.avatar_storage_path }]);
    return { ...profile, avatar_signed_url: avatar?.signed_url || null };
  }));
  const profileMap = new Map(signed.map((profile) => [profile.user_id, profile]));
  return res.status(200).json({
    comments: page.map((comment) => {
      const reactions = (reactionResult.data || []).filter((row) => row.comment_id === comment.id);
      return {
        ...comment,
        author: profileMap.get(comment.author_user_id) || null,
        reactions: summarizeCommentReactions(reactions),
        viewerReaction: reactions.find((row) => row.user_id === user.id)?.reaction_type || null
      };
    }),
    nextCursor: rows.length > 50 ? page.at(-1).created_at : null
  });
}

async function react(req, res, supabase, user) {
  requireFields(req.body, ["postId"]);
  await enforceSocialRateLimit(supabase, user.id, "reaction", 80, 3600);
  const post = await visiblePost(supabase, user.id, req.body.postId);
  if (!req.body.reactionType) {
    const { error } = await supabase.from("social_reactions").delete().eq("post_id", post.id).eq("user_id", user.id);
    if (error) throw error;
    return res.status(200).json({ postId: post.id, reaction: null });
  }
  const reactionType = assertValue(reactionTypes, String(req.body.reactionType), "reaction");
  const { data, error } = await supabase.from("social_reactions").upsert({ post_id: post.id, user_id: user.id, reaction_type: reactionType, updated_at: new Date().toISOString() }, { onConflict: "post_id,user_id" }).select("*").single();
  if (error) throw error;
  await emitSocialNotification(supabase, { userId: post.user_id, actorUserId: user.id, eventType: "post_reaction", title: "New Research Reaction", body: `Your post received a ${reactionType} reaction.`, postId: post.id, deepLink: `/network/post/${post.id}` });
  return res.status(200).json({ postId: post.id, reaction: data });
}

async function comment(req, res, supabase, user) {
  requireFields(req.body, ["postId", "body"]);
  await enforceSocialRateLimit(supabase, user.id, "comment", 30, 3600);
  const post = await visiblePost(supabase, user.id, req.body.postId);
  if (!post.comments_enabled) throw badRequest("Comments are disabled for this post.");
  await assertNoBlock(supabase, user.id, post.user_id);
  const body = cleanText(req.body.body, 4000, true);
  const mentions = [...new Set(body.match(/@[a-z0-9_]{3,30}/gi) || [])].slice(0, 11);
  if (mentions.length > 10) throw badRequest("A comment may mention at most 10 professionals.");
  if (mentions.length) await enforceSocialRateLimit(supabase, user.id, "mention", 40, 3600);
  let parentCommentId = req.body.parentCommentId || null;
  if (parentCommentId) {
    const { data: parent, error } = await supabase.from("social_comments").select("id,parent_comment_id,author_user_id").eq("id", parentCommentId).eq("post_id", post.id).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!parent) throw badRequest("Reply target is unavailable.");
    if (parent.parent_comment_id) parentCommentId = parent.parent_comment_id;
  }
  const clientCommentId = cleanText(req.body.clientCommentId, 120);
  const { data, error } = await supabase.from("social_comments").insert({ post_id: post.id, parent_comment_id: parentCommentId, author_user_id: user.id, body, client_comment_id: clientCommentId || null }).select("*").single();
  if (error?.code === "23505" && clientCommentId) {
    const { data: existing, error: existingError } = await supabase.from("social_comments").select("*").eq("author_user_id", user.id).eq("client_comment_id", clientCommentId).single();
    if (existingError) throw existingError;
    return res.status(200).json({ comment: existing, duplicatePrevented: true });
  }
  if (error) throw error;
  if (mentions.length) await recordSocialMentions(supabase, { sourceType: "comment", sourceId: data.id, postId: post.id, actorUserId: user.id, body });
  const targetUserId = parentCommentId
    ? (await supabase.from("social_comments").select("author_user_id").eq("id", parentCommentId).single()).data?.author_user_id
    : post.user_id;
  await emitSocialNotification(supabase, { userId: targetUserId, actorUserId: user.id, eventType: parentCommentId ? "post_reply" : "post_comment", title: parentCommentId ? "New Reply" : "New Comment", body: body.slice(0, 100), postId: post.id, commentId: data.id, deepLink: `/network/post/${post.id}?comment=${data.id}` });
  return res.status(201).json({ comment: data });
}

async function editComment(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "comments");
  requireFields(req.body, ["commentId", "body"]);
  const { data: current, error } = await supabase.from("social_comments").select("*").eq("id", req.body.commentId).eq("author_user_id", user.id).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!current) return res.status(404).json({ error: "Comment not found or not editable." });
  const body = cleanText(req.body.body, 4000, true);
  if (body === current.body) return res.status(200).json({ comment: current, unchanged: true });
  const { error: historyError } = await supabase.from("social_comment_edits").insert({ comment_id: current.id, editor_user_id: user.id, prior_body: current.body });
  if (historyError) throw historyError;
  const { data, error: updateError } = await supabase.from("social_comments").update({ body, edited_at: new Date().toISOString() }).eq("id", current.id).select("*").single();
  if (updateError) throw updateError;
  const { error: mentionDeleteError } = await supabase.from("social_mentions").delete().eq("source_type", "comment").eq("source_id", current.id);
  if (mentionDeleteError) throw mentionDeleteError;
  await recordSocialMentions(supabase, { sourceType: "comment", sourceId: current.id, postId: current.post_id, actorUserId: user.id, body });
  return res.status(200).json({ comment: data });
}

async function deleteComment(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "comments");
  requireFields(req.body, ["commentId"]);
  const { data, error } = await supabase.from("social_comments").update({ deleted_at: new Date().toISOString(), body: "[deleted]" }).eq("id", req.body.commentId).eq("author_user_id", user.id).is("deleted_at", null).select("id").maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: "Comment not found or not deletable." });
  return res.status(200).json({ deleted: true, commentId: data.id });
}

async function reactToComment(req, res, supabase, user) {
  requireFields(req.body, ["commentId"]);
  const { data: target, error: targetError } = await supabase.from("social_comments").select("id,post_id").eq("id", req.body.commentId).is("deleted_at", null).maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw badRequest("Comment is unavailable.");
  await visiblePost(supabase, user.id, target.post_id);
  if (!req.body.reactionType) {
    const { error } = await supabase.from("social_comment_reactions").delete().eq("comment_id", target.id).eq("user_id", user.id);
    if (error) throw error;
    return res.status(200).json({ commentId: target.id, reaction: null });
  }
  const reactionType = assertValue(new Set(["insightful", "useful", "agree"]), String(req.body.reactionType), "comment reaction");
  const { data, error } = await supabase.from("social_comment_reactions").upsert({ comment_id: target.id, user_id: user.id, reaction_type: reactionType }, { onConflict: "comment_id,user_id" }).select("*").single();
  if (error) throw error;
  return res.status(200).json({ commentId: target.id, reaction: data });
}

async function listCollections(res, supabase, user) {
  const { data, error } = await supabase.from("social_saved_collections").select("id,name,is_default,created_at,social_saved_posts(count)").eq("user_id", user.id).order("is_default", { ascending: false }).order("name");
  if (error) throw error;
  return res.status(200).json({ collections: data || [] });
}

async function mutateCollection(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "engagement");
  const action = String(req.body.action || "create");
  if (action === "create") {
    const name = cleanText(req.body.name, 80, true);
    const { data, error } = await supabase.from("social_saved_collections").insert({ user_id: user.id, name }).select("*").single();
    if (error) throw error;
    return res.status(201).json({ collection: data });
  }
  requireFields(req.body, ["collectionId"]);
  if (action === "rename") {
    const name = cleanText(req.body.name, 80, true);
    const { data, error } = await supabase.from("social_saved_collections").update({ name }).eq("id", req.body.collectionId).eq("user_id", user.id).eq("is_default", false).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw badRequest("Collection is unavailable or cannot be renamed.");
    return res.status(200).json({ collection: data });
  }
  if (action === "delete") {
    const { data, error } = await supabase.from("social_saved_collections").delete().eq("id", req.body.collectionId).eq("user_id", user.id).eq("is_default", false).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw badRequest("Collection is unavailable or cannot be deleted.");
    return res.status(200).json({ deleted: true, collectionId: data.id });
  }
  throw badRequest("Unsupported collection action.");
}

async function save(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "engagement");
  requireFields(req.body, ["postId"]);
  const post = await visiblePost(supabase, user.id, req.body.postId);
  if (req.body.saved === false) {
    const { error } = await supabase.from("social_saved_posts").delete().eq("post_id", post.id).eq("user_id", user.id);
    if (error) throw error;
    return res.status(200).json({ postId: post.id, saved: false });
  }
  let collectionId = req.body.collectionId || null;
  if (collectionId) {
    const { data: owned, error: ownedError } = await supabase.from("social_saved_collections").select("id").eq("id", collectionId).eq("user_id", user.id).maybeSingle();
    if (ownedError) throw ownedError;
    if (!owned) throw badRequest("Saved collection is unavailable.");
  }
  if (!collectionId) {
    const { data: collection, error } = await supabase.from("social_saved_collections").upsert({ user_id: user.id, name: "Default", is_default: true }, { onConflict: "user_id,name" }).select("id").single();
    if (error) throw error;
    collectionId = collection.id;
  }
  const { error } = await supabase.from("social_saved_posts").upsert({ user_id: user.id, post_id: post.id, collection_id: collectionId }, { onConflict: "user_id,post_id" });
  if (error) throw error;
  return res.status(200).json({ postId: post.id, saved: true, collectionId });
}

async function repost(req, res, supabase, user) {
  requireFields(req.body, ["postId"]);
  await enforceSocialRateLimit(supabase, user.id, "repost", 20, 3600);
  const post = await visiblePost(supabase, user.id, req.body.postId);
  if (req.body.reposted === false) {
    const { error } = await supabase.from("social_reposts").delete().eq("post_id", post.id).eq("user_id", user.id);
    if (error) throw error;
    return res.status(200).json({ postId: post.id, reposted: false });
  }
  const commentary = cleanText(req.body.commentary, 4000);
  const { data: existing, error: existingError } = await supabase.from("social_reposts").select("*").eq("post_id", post.id).eq("user_id", user.id).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return res.status(200).json({ repost: existing, quotePost: null, duplicatePrevented: true });
  let quotePost = null;
  if (commentary) {
    const { data: created, error: quoteError } = await supabase.from("profile_posts").insert({
      user_id: user.id,
      post_type: "quote_post",
      body: commentary,
      quoted_post_id: post.id,
      visibility: "public",
      status: "published",
      idempotency_key: `quote-${user.id}-${post.id}-${Date.now()}`
    }).select("*").single();
    if (quoteError) throw quoteError;
    quotePost = created;
  }
  const { data, error } = await supabase.from("social_reposts").upsert({ post_id: post.id, user_id: user.id, commentary: commentary || null }, { onConflict: "post_id,user_id" }).select("*").single();
  if (error) throw error;
  await emitSocialNotification(supabase, { userId: post.user_id, actorUserId: user.id, eventType: commentary ? "quote_post" : "post_repost", title: commentary ? "Research Quoted" : "Research Reposted", body: commentary.slice(0, 100), postId: post.id, deepLink: `/network/post/${post.id}` });
  return res.status(200).json({ repost: data, quotePost });
}

function summarizeCommentReactions(rows) {
  return rows.reduce((summary, row) => {
    summary[row.reaction_type] = (summary[row.reaction_type] || 0) + 1;
    return summary;
  }, {});
}

async function report(req, res, supabase, user) {
  requireFields(req.body, ["targetType", "targetId", "reason"]);
  await enforceSocialRateLimit(supabase, user.id, "report", 10, 86400);
  const reason = assertValue(reportReasons, String(req.body.reason), "report reason");
  const targetType = String(req.body.targetType);
  if (!["post", "comment", "profile", "message", "group"].includes(targetType)) throw badRequest("Unsupported report target.");
  const { data, error } = await supabase.from("content_reports").insert({ reporter_user_id: user.id, target_type: targetType, target_id: req.body.targetId, reason, details: cleanText(req.body.details, 2000), status: "pending" }).select("id,status,created_at").single();
  if (error) throw error;
  return res.status(201).json({ report: data });
}

async function hide(req, res, supabase, user) {
  await assertSocialMutationAllowed(supabase, user.id, "engagement");
  requireFields(req.body, ["postId"]);
  const { error } = await supabase.from("social_hidden_posts").upsert({ user_id: user.id, post_id: req.body.postId }, { onConflict: "user_id,post_id" });
  if (error) throw error;
  return res.status(200).json({ hidden: true, postId: req.body.postId });
}

async function visiblePost(supabase, viewerId, postId) {
  const { data, error } = await supabase.from("profile_posts").select("*").eq("id", postId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!data || !(await canViewPost(supabase, viewerId, data))) throw Object.assign(new Error("Post unavailable."), { statusCode: 404 });
  return data;
}
