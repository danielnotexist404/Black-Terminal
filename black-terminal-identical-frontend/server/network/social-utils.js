import crypto from "node:crypto";

export const socialPostTypes = new Set([
  "status", "market_research", "macro_research", "quantitative_research", "technical_analysis",
  "orderflow_analysis", "risk_commentary", "trade_idea", "market_opinion", "indicator_release",
  "strategy_note", "educational_note", "group_announcement", "group_update", "quote_post"
]);

export const postVisibilities = new Set(["public", "followers", "group", "private"]);
export const reactionTypes = new Set(["insightful", "bullish", "bearish", "useful", "high_conviction", "well_researched"]);
export const reportReasons = new Set([
  "spam", "harassment", "impersonation", "misleading_performance_claims", "scam",
  "market_manipulation", "copyright_violation", "sensitive_information", "other",
  "misleading_financial_claim", "copyright", "private_information"
]);

export async function ensureNetworkProfile(supabase, user) {
  const { data: existing, error: selectError } = await supabase
    .from("profiles_extended")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing;

  const username = String(user.user_metadata?.username || user.user_metadata?.display_name || user.email?.split("@")[0] || `trader-${user.id.slice(0, 8)}`);
  const handle = sanitizeHandle(username) || `trader_${user.id.slice(0, 8)}`;
  const { data, error } = await supabase
    .from("profiles_extended")
    .insert({
      user_id: user.id,
      handle,
      display_name: user.user_metadata?.display_name || username,
      professional_role: user.app_metadata?.role === "admin" ? "Administrator" : "Trader"
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export function sanitizeHandle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
}

export async function assertNoBlock(supabase, userA, userB) {
  if (!userA || !userB || userA === userB) return;
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocker_user_id")
    .or(`and(blocker_user_id.eq.${userA},blocked_user_id.eq.${userB}),and(blocker_user_id.eq.${userB},blocked_user_id.eq.${userA})`)
    .limit(1);
  if (error) throw error;
  if (data?.length) throw forbidden("This interaction is unavailable because one account has blocked the other.");
}

export async function canViewPost(supabase, viewerId, post) {
  if (!post || post.deleted_at) return false;
  if (post.user_id === viewerId) return true;
  try {
    await assertNoBlock(supabase, viewerId, post.user_id);
  } catch {
    return false;
  }
  if (post.visibility === "public") return true;
  if (post.visibility === "followers") {
    const { data } = await supabase.from("user_follows").select("follower_user_id").eq("follower_user_id", viewerId).eq("followed_user_id", post.user_id).maybeSingle();
    return Boolean(data);
  }
  if (post.visibility === "group" && post.investment_group_id) {
    const { data } = await supabase.from("investment_group_members").select("id").eq("group_id", post.investment_group_id).eq("user_id", viewerId).eq("status", "active").maybeSingle();
    return Boolean(data);
  }
  return false;
}

export async function enforceSocialRateLimit(supabase, userId, action, limit, windowSeconds) {
  await assertSocialMutationAllowed(supabase, userId, socialScopeForAction(action));
  const { error } = await supabase.rpc("social_consume_rate_limit", {
    target_user: userId,
    target_action: action,
    allowed_count: limit,
    window_seconds: windowSeconds
  });
  if (error?.code === "P0001" || /rate limit/i.test(error?.message || "")) {
    const rateError = new Error(`Rate limit reached for ${action}. Try again shortly.`);
    rateError.statusCode = 429;
    throw rateError;
  }
  if (error) throw error;
}

export async function assertSocialMutationAllowed(supabase, userId, scope = "engagement") {
  const now = new Date();
  const { data, error } = await supabase
    .from("social_account_restrictions")
    .select("action,scope,reason,starts_at,expires_at")
    .eq("user_id", userId)
    .is("lifted_at", null)
    .lte("starts_at", now.toISOString())
    .order("starts_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  const active = (data || []).find((item) => (
    (!item.expires_at || new Date(item.expires_at).getTime() > now.getTime())
    && (item.action === "suspend" || item.scope === "all" || item.scope === scope)
  ));
  if (!active) return;
  const until = active.expires_at ? ` until ${new Date(active.expires_at).toISOString()}` : "";
  throw forbidden(`Professional Network access is ${active.action === "suspend" ? "suspended" : "restricted"}${until}.`);
}

export async function recordSocialMentions(supabase, input) {
  const handles = [...new Set((String(input.body || "").match(/@[a-z0-9_]{3,30}/gi) || []).map((value) => value.slice(1).toLowerCase()))].slice(0, 10);
  if (!handles.length) return [];
  const { data: profiles, error } = await supabase
    .from("profiles_extended")
    .select("user_id,handle")
    .in("handle", handles)
    .is("deleted_at", null);
  if (error) throw error;
  const recipients = [];
  for (const profile of profiles || []) {
    if (profile.user_id === input.actorUserId) continue;
    try { await assertNoBlock(supabase, input.actorUserId, profile.user_id); } catch { continue; }
    const { data: privacy, error: privacyError } = await supabase
      .from("profile_privacy_settings")
      .select(input.sourceType === "comment" ? "allow_comment_mentions" : "allow_post_mentions")
      .eq("user_id", profile.user_id)
      .maybeSingle();
    if (privacyError) throw privacyError;
    const allowed = input.sourceType === "comment" ? privacy?.allow_comment_mentions : privacy?.allow_post_mentions;
    if (allowed === false) continue;
    const { error: mentionError } = await supabase.from("social_mentions").upsert({
      source_type: input.sourceType,
      source_id: input.sourceId,
      post_id: input.postId,
      actor_user_id: input.actorUserId,
      mentioned_user_id: profile.user_id
    }, { onConflict: "source_type,source_id,mentioned_user_id", ignoreDuplicates: true });
    if (mentionError) throw mentionError;
    await emitSocialNotification(supabase, {
      userId: profile.user_id,
      actorUserId: input.actorUserId,
      eventType: "mention",
      title: input.sourceType === "comment" ? "Mentioned In A Comment" : "Mentioned In Research",
      body: String(input.body || "").slice(0, 100),
      postId: input.postId,
      commentId: input.sourceType === "comment" ? input.sourceId : null,
      deepLink: `/network/post/${input.postId}${input.sourceType === "comment" ? `?comment=${input.sourceId}` : ""}`
    });
    recipients.push(profile.user_id);
  }
  return recipients;
}

function socialScopeForAction(action) {
  if (["post", "repost", "asset_publish"].includes(action)) return "posting";
  if (["comment", "mention"].includes(action)) return "comments";
  if (["message", "message_start"].includes(action)) return "messaging";
  if (action === "media_upload") return "media";
  return "engagement";
}

export async function signMediaRows(supabase, rows = [], expiresIn = 3600) {
  return Promise.all(rows.map(async (row) => {
    if (!row.storage_path) return { ...row, signed_url: null };
    const { data } = await supabase.storage.from("professional-media").createSignedUrl(row.storage_path, expiresIn);
    return { ...row, signed_url: data?.signedUrl || null };
  }));
}

export async function validateStoredImage(supabase, storagePath, expectedMime, maxBytes = 15728640) {
  const mimeType = String(expectedMime || "").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) throw badRequest("Unsupported image content type.");
  const path = String(storagePath || "");
  const slash = path.lastIndexOf("/");
  if (slash < 1) throw badRequest("Invalid media storage path.");
  const folder = path.slice(0, slash);
  const fileName = path.slice(slash + 1);
  const { data: objects, error: listError } = await supabase.storage.from("professional-media").list(folder, { limit: 20, search: fileName });
  if (listError) throw listError;
  const object = (objects || []).find((item) => item.name === fileName);
  if (!object) throw badRequest("Uploaded media object is unavailable.");
  const storedMime = String(object.metadata?.mimetype || object.metadata?.contentType || "").toLowerCase();
  const byteSize = Number(object.metadata?.size || 0);
  if (storedMime && storedMime !== mimeType) throw badRequest("Uploaded media content type does not match its declaration.");
  if (!Number.isFinite(byteSize) || byteSize < 1 || byteSize > maxBytes) throw badRequest("Uploaded media size is invalid.");
  const { data: signed, error: signedError } = await supabase.storage.from("professional-media").createSignedUrl(path, 60);
  if (signedError || !signed?.signedUrl) throw signedError || badRequest("Uploaded media cannot be inspected.");
  const response = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-31" }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw badRequest("Uploaded media cannot be inspected.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!matchesImageSignature(bytes, mimeType)) throw badRequest("Uploaded file signature does not match an approved image format.");
  return { mimeType, byteSize };
}

function matchesImageSignature(bytes, mimeType) {
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mimeType === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

export async function emitSocialNotification(supabase, input) {
  if (!input.userId || input.userId === input.actorUserId) return;
  const preferenceKey = notificationPreferenceKey(input.eventType);
  if (preferenceKey) {
    const { data: preferences, error: preferenceError } = await supabase.from("notification_preferences").select(preferenceKey).eq("user_id", input.userId).maybeSingle();
    if (preferenceError) throw preferenceError;
    if (preferences?.[preferenceKey] === false) return;
  }
  const groupingKey = notificationGroupingKey(input);
  const now = new Date().toISOString();
  if (groupingKey) {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: grouped, error: groupedError } = await supabase.from("notification_events").select("id,group_count,metadata").eq("user_id", input.userId).eq("grouping_key", groupingKey).is("read_at", null).gte("last_event_at", cutoff).order("last_event_at", { ascending: false }).limit(1).maybeSingle();
    if (groupedError) throw groupedError;
    if (grouped) {
      const actors = [...new Set([...(Array.isArray(grouped.metadata?.actor_user_ids) ? grouped.metadata.actor_user_ids : []), input.actorUserId].filter(Boolean))].slice(-12);
      const { error: updateError } = await supabase.from("notification_events").update({
        title: input.title,
        body: input.body || "",
        actor_user_id: input.actorUserId || null,
        comment_id: input.commentId || null,
        group_count: Number(grouped.group_count || 1) + 1,
        last_event_at: now,
        metadata: { ...(grouped.metadata || {}), ...(input.metadata || {}), actor_user_ids: actors }
      }).eq("id", grouped.id);
      if (updateError) throw updateError;
      return;
    }
  }
  const { error } = await supabase.from("notification_events").insert({
    user_id: input.userId,
    event_type: input.eventType,
    title: input.title,
    body: input.body || "",
    actor_user_id: input.actorUserId || null,
    post_id: input.postId || null,
    comment_id: input.commentId || null,
    conversation_id: input.conversationId || null,
    deep_link: input.deepLink || null,
    grouping_key: groupingKey,
    group_count: 1,
    last_event_at: now,
    metadata: { ...(input.metadata || {}), actor_user_ids: input.actorUserId ? [input.actorUserId] : [] }
  });
  if (error) throw error;
}

function notificationGroupingKey(input) {
  if (["post_reaction", "post_comment", "post_reply", "post_repost", "quote_post"].includes(input.eventType) && input.postId) return `${input.eventType}:${input.postId}`;
  if (["new_follower", "follow_request"].includes(input.eventType)) return input.eventType;
  if (String(input.eventType).startsWith("group_") && input.groupId) return `${input.eventType}:${input.groupId}`;
  return null;
}

function notificationPreferenceKey(eventType) {
  if (["new_follower", "follow_request"].includes(eventType)) return "follows";
  if (eventType === "post_reaction") return "reactions";
  if (["post_comment", "post_reply"].includes(eventType)) return "comments";
  if (["post_repost", "quote_post"].includes(eventType)) return "reposts";
  if (["direct_message", "message_request"].includes(eventType)) return "messages";
  if (eventType === "mention") return "mentions";
  if (String(eventType).startsWith("group_")) return "group_activity";
  if (String(eventType).startsWith("indicator_")) return "indicator_updates";
  return null;
}

export function randomKey(prefix = "social") {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function assertValue(set, value, label) {
  if (!set.has(value)) throw badRequest(`Unsupported ${label}: ${value}`);
  return value;
}

export function cleanText(value, maxLength, required = false) {
  const text = String(value || "").trim();
  if (required && !text) throw badRequest("Required text is missing.");
  return text.slice(0, maxLength);
}

export function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}

export function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}
