import { applyCors, requireFields, requireUser, sendError } from "../../portfolio-api.js";
import {
  assertNoBlock, badRequest, canViewPost, cleanText, emitSocialNotification, enforceSocialRateLimit,
  ensureNetworkProfile, forbidden, notFound, signMediaRows, validateStoredImage
} from "../social-utils.js";

const PAGE_SIZE = 40;
const MESSAGE_TYPES = new Set(["text", "image", "post", "profile", "indicator", "strategy", "group"]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    if (req.method === "GET") return readMessaging(req, res, supabase, user);
    if (req.method === "POST") return mutateMessaging(req, res, supabase, user);
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return sendError(res, error);
  }
}

async function readMessaging(req, res, supabase, user) {
  const conversationId = req.query?.conversationId ? String(req.query.conversationId) : null;
  if (conversationId) {
    await assertConversationMember(supabase, conversationId, user.id);
    const cursor = req.query?.cursor ? String(req.query.cursor) : null;
    let query = supabase.from("messages").select("*").eq("conversation_id", conversationId).is("deleted_at", null).order("created_at", { ascending: false }).limit(PAGE_SIZE + 1);
    if (cursor) query = query.lt("created_at", cursor);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    const messageIds = page.slice(0, PAGE_SIZE).map((message) => message.id);
    const { data: media, error: mediaError } = messageIds.length
      ? await supabase.from("message_attachments").select("*").in("message_id", messageIds)
      : { data: [], error: null };
    if (mediaError) throw mediaError;
    const signed = await signMediaRows(supabase, media || []);
    return res.status(200).json({
      messages: page.slice(0, PAGE_SIZE).reverse().map((message) => ({
        ...message,
        attachments: signed.filter((item) => item.message_id === message.id)
      })),
      nextCursor: page.length > PAGE_SIZE ? page[PAGE_SIZE - 1].created_at : null
    });
  }

  const { data: memberships, error } = await supabase.from("conversation_members").select("conversation_id,role,archived_at,muted_until,joined_at").eq("user_id", user.id).is("left_at", null);
  if (error) throw error;
  const ids = (memberships || []).map((item) => item.conversation_id);
  if (!ids.length) return res.status(200).json({ conversations: [] });
  const [conversations, allMembers, reads, requests, latestMessages] = await Promise.all([
    supabase.from("conversations").select("*").in("id", ids).order("last_message_at", { ascending: false, nullsFirst: false }),
    supabase.from("conversation_members").select("conversation_id,user_id,role").in("conversation_id", ids).is("left_at", null),
    supabase.from("message_reads").select("conversation_id,last_read_message_id,read_at").eq("user_id", user.id).in("conversation_id", ids),
    supabase.from("message_requests").select("*").in("conversation_id", ids),
    supabase.from("messages").select("id,conversation_id,sender_user_id,body,message_type,created_at").in("conversation_id", ids).is("deleted_at", null).order("created_at", { ascending: false }).limit(Math.min(ids.length * 8, 500))
  ]);
  for (const result of [conversations, allMembers, reads, requests, latestMessages]) if (result.error) throw result.error;
  const memberRows = allMembers.data || [];
  const otherIds = [...new Set(memberRows.filter((member) => member.user_id !== user.id).map((member) => member.user_id))];
  const { data: profiles, error: profileError } = otherIds.length
    ? await supabase.from("profiles_extended").select("user_id,handle,display_name,avatar_storage_path,professional_role").in("user_id", otherIds)
    : { data: [], error: null };
  if (profileError) throw profileError;
  const profileMap = new Map((profiles || []).map((profile) => [profile.user_id, profile]));
  const membershipMap = new Map((memberships || []).map((membership) => [membership.conversation_id, membership]));
  return res.status(200).json({
    conversations: (conversations.data || []).map((conversation) => {
      const members = memberRows.filter((member) => member.conversation_id === conversation.id);
      const otherProfiles = members.filter((member) => member.user_id !== user.id).map((member) => profileMap.get(member.user_id)).filter(Boolean);
      const lastMessage = (latestMessages.data || []).find((message) => message.conversation_id === conversation.id) || null;
      return {
        ...conversation,
        membership: membershipMap.get(conversation.id),
        participants: otherProfiles,
        request: (requests.data || []).find((request) => request.conversation_id === conversation.id) || null,
        lastMessage,
        read: (reads.data || []).find((read) => read.conversation_id === conversation.id) || null
      };
    })
  });
}

async function mutateMessaging(req, res, supabase, user) {
  requireFields(req.body, ["operation"]);
  const operation = String(req.body.operation);
  if (operation === "start") return startConversation(req, res, supabase, user);
  if (operation === "send") return sendMessage(req, res, supabase, user);
  if (operation === "review_request") return reviewRequest(req, res, supabase, user);
  if (operation === "read") return markRead(req, res, supabase, user);
  if (operation === "archive" || operation === "mute") return updateMembership(req, res, supabase, user, operation);
  if (operation === "delete_message") return deleteMessage(req, res, supabase, user);
  throw badRequest("Unknown messaging operation.");
}

async function startConversation(req, res, supabase, user) {
  requireFields(req.body, ["targetUserId"]);
  const targetUserId = String(req.body.targetUserId);
  if (targetUserId === user.id) throw badRequest("Choose another professional to start a conversation.");
  await enforceSocialRateLimit(supabase, user.id, "message_start", 20, 86400);
  await assertNoBlock(supabase, user.id, targetUserId);
  const { data: target, error: targetError } = await supabase.from("profiles_extended").select("user_id,message_policy").eq("user_id", targetUserId).is("deleted_at", null).maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw notFound("Professional profile unavailable.");
  if (target.message_policy === "nobody") throw forbidden("This professional is not accepting messages.");

  const { data: follows } = await supabase.from("user_follows").select("follower_user_id").eq("follower_user_id", user.id).eq("followed_user_id", targetUserId).maybeSingle();
  const requiresRequest = target.message_policy === "followers" && !follows;
  const { data: started, error } = await supabase.rpc("social_start_direct_conversation", {
    actor_user: user.id,
    target_user: targetUserId,
    requires_request: requiresRequest
  }).single();
  if (error) throw error;
  if (started.created && started.request_pending) {
    await emitSocialNotification(supabase, { userId: targetUserId, actorUserId: user.id, eventType: "message_request", title: "Professional Message Request", body: "A professional requested a private conversation.", conversationId: started.conversation_id, deepLink: `/network/messages/${started.conversation_id}` });
  }
  return res.status(started.created ? 201 : 200).json({
    conversationId: started.conversation_id,
    existing: !started.created,
    requestPending: started.request_pending
  });
}

async function sendMessage(req, res, supabase, user) {
  requireFields(req.body, ["conversationId", "messageType", "clientMessageId"]);
  const conversationId = String(req.body.conversationId);
  await assertConversationMember(supabase, conversationId, user.id);
  await enforceSocialRateLimit(supabase, user.id, "message", 120, 3600);
  const messageType = String(req.body.messageType);
  if (!MESSAGE_TYPES.has(messageType)) throw badRequest("Unsupported message type.");
  const body = cleanText(req.body.body, 8000, messageType === "text");
  const { data: request, error: requestError } = await supabase.from("message_requests").select("*").eq("conversation_id", conversationId).maybeSingle();
  if (requestError) throw requestError;
  if (request?.status === "declined" || request?.status === "blocked") throw forbidden("This message request is not active.");
  if (request?.status === "pending" && request.sender_user_id !== user.id) throw forbidden("Accept this message request before replying.");
  if (request?.status === "pending") {
    const { count } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("sender_user_id", user.id);
    if ((count || 0) >= 1) throw forbidden("Wait for this professional to accept your message request.");
  }
  const requestedMedia = Array.isArray(req.body.media) ? req.body.media.slice(0, 4) : [];
  requestedMedia.forEach((item) => {
    if (!String(item.storagePath || "").startsWith(`messages/${conversationId}/`)) throw badRequest("Message media path does not belong to this conversation.");
  });
  const media = await Promise.all(requestedMedia.map(async (item) => ({ ...item, ...(await validateStoredImage(supabase, item.storagePath, item.mimeType, 10485760)) })));
  const sharedObject = await validateSharedObject(supabase, conversationId, user.id, messageType, req.body.sharedObjectType, req.body.sharedObjectId);
  const { data: message, error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    sender_user_id: user.id,
    body,
    message_type: messageType,
    shared_object_type: sharedObject?.type || null,
    shared_object_id: sharedObject?.id || null,
    client_message_id: cleanText(req.body.clientMessageId, 120, true)
  }).select("*").single();
  if (error?.code === "23505") {
    const { data: existing } = await supabase.from("messages").select("*").eq("sender_user_id", user.id).eq("client_message_id", req.body.clientMessageId).single();
    return res.status(200).json({ message: existing, duplicatePrevented: true });
  }
  if (error) throw error;
  if (media.length) {
    const { error: mediaError } = await supabase.from("message_attachments").insert(media.map((item) => ({
      message_id: message.id,
      owner_user_id: user.id,
      storage_path: item.storagePath,
      mime_type: item.mimeType,
      byte_size: Number(item.byteSize),
      width: Number(item.width) || null,
      height: Number(item.height) || null
    })));
    if (mediaError) throw mediaError;
  }
  await supabase.from("conversations").update({ last_message_at: message.created_at }).eq("id", conversationId);
  const { data: recipients } = await supabase.from("conversation_members").select("user_id").eq("conversation_id", conversationId).neq("user_id", user.id).is("left_at", null);
  await Promise.all((recipients || []).map((recipient) => emitSocialNotification(supabase, {
    userId: recipient.user_id,
    actorUserId: user.id,
    eventType: "direct_message",
    title: "New Professional Message",
    body: messageType === "text" ? body.slice(0, 100) : "Shared professional content",
    conversationId,
    deepLink: `/network/messages/${conversationId}`
  })));
  return res.status(201).json({ message });
}

async function reviewRequest(req, res, supabase, user) {
  requireFields(req.body, ["conversationId", "decision"]);
  const status = req.body.decision === "accept" ? "accepted" : "declined";
  const { data, error } = await supabase.from("message_requests").update({ status, reviewed_at: new Date().toISOString() }).eq("conversation_id", req.body.conversationId).eq("recipient_user_id", user.id).eq("status", "pending").select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound("Pending message request unavailable.");
  return res.status(200).json({ request: data });
}

async function markRead(req, res, supabase, user) {
  requireFields(req.body, ["conversationId", "messageId"]);
  await assertConversationMember(supabase, req.body.conversationId, user.id);
  const { data, error } = await supabase.from("message_reads").upsert({ conversation_id: req.body.conversationId, user_id: user.id, last_read_message_id: req.body.messageId, read_at: new Date().toISOString() }, { onConflict: "conversation_id,user_id" }).select("*").single();
  if (error) throw error;
  return res.status(200).json({ read: data });
}

async function updateMembership(req, res, supabase, user, operation) {
  requireFields(req.body, ["conversationId"]);
  const patch = operation === "archive"
    ? { archived_at: req.body.enabled === false ? null : new Date().toISOString() }
    : { muted_until: req.body.enabled === false ? null : new Date(Date.now() + Math.min(Number(req.body.durationMinutes) || 1440, 525600) * 60000).toISOString() };
  const { data, error } = await supabase.from("conversation_members").update(patch).eq("conversation_id", req.body.conversationId).eq("user_id", user.id).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound("Conversation unavailable.");
  return res.status(200).json({ membership: data });
}

async function deleteMessage(req, res, supabase, user) {
  requireFields(req.body, ["messageId"]);
  const { data, error } = await supabase.from("messages").update({ deleted_at: new Date().toISOString(), body: "" }).eq("id", req.body.messageId).eq("sender_user_id", user.id).is("deleted_at", null).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound("Message unavailable or not deletable.");
  return res.status(200).json({ deleted: true, messageId: data.id });
}

async function assertConversationMember(supabase, conversationId, userId) {
  const { data, error } = await supabase.from("conversation_members").select("conversation_id").eq("conversation_id", conversationId).eq("user_id", userId).is("left_at", null).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound("Conversation unavailable.");
}

async function validateSharedObject(supabase, conversationId, senderUserId, messageType, requestedType, requestedId) {
  if (messageType === "text" || messageType === "image") {
    if (requestedType || requestedId) throw badRequest("Text and image messages cannot carry an unvalidated shared object.");
    return null;
  }
  const type = String(requestedType || messageType);
  const id = String(requestedId || "");
  if (!id || type !== messageType) throw badRequest("Shared object type and identifier are required.");
  const { data: members, error: memberError } = await supabase.from("conversation_members").select("user_id").eq("conversation_id", conversationId).is("left_at", null);
  if (memberError) throw memberError;
  const recipients = (members || []).map((item) => item.user_id);
  if (!recipients.includes(senderUserId)) throw notFound("Conversation unavailable.");

  if (type === "post") {
    const { data: post, error } = await supabase.from("profile_posts").select("*").eq("id", id).is("deleted_at", null).eq("status", "published").maybeSingle();
    if (error) throw error;
    if (!post) throw notFound("Shared post is unavailable.");
    for (const viewerId of recipients) if (!(await canViewPost(supabase, viewerId, post))) throw forbidden("Every conversation member must be authorized to view the shared post.");
    return { type, id: post.id };
  }
  if (type === "profile") {
    const { data: profile, error } = await supabase.from("profiles_extended").select("user_id,profile_visibility,deleted_at").eq("user_id", id).maybeSingle();
    if (error) throw error;
    if (!profile || profile.deleted_at) throw notFound("Shared profile is unavailable.");
    for (const viewerId of recipients) {
      if (viewerId === profile.user_id) continue;
      await assertNoBlock(supabase, viewerId, profile.user_id);
      if (profile.profile_visibility === "private") throw forbidden("Private profiles cannot be shared to this conversation.");
      if (profile.profile_visibility === "followers") {
        const { data: follows } = await supabase.from("user_follows").select("follower_user_id").eq("follower_user_id", viewerId).eq("followed_user_id", profile.user_id).maybeSingle();
        if (!follows) throw forbidden("Every conversation member must be authorized to view the shared profile.");
      }
    }
    return { type, id: profile.user_id };
  }
  if (type === "indicator" || type === "strategy") {
    const table = type === "indicator" ? "published_indicators" : "published_strategies";
    const { data, error } = await supabase.from(table).select("id,visibility").eq("id", id).eq("visibility", "public").maybeSingle();
    if (error) throw error;
    if (!data) throw forbidden(`Only public ${type} records may be shared.`);
    return { type, id: data.id };
  }
  if (type === "group") {
    const { data: group, error } = await supabase.from("investment_groups").select("id,visibility").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!group) throw notFound("Shared Investment Group is unavailable.");
    if (group.visibility !== "public") {
      const { data: groupMembers, error: groupMemberError } = await supabase.from("investment_group_members").select("user_id").eq("group_id", id).eq("status", "active").in("user_id", recipients);
      if (groupMemberError) throw groupMemberError;
      if ((groupMembers || []).length !== new Set(recipients).size) throw forbidden("Every conversation member must belong to the shared Investment Group.");
    }
    return { type, id: group.id };
  }
  throw badRequest("Unsupported shared object type.");
}
