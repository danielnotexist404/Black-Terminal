import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertCanManageGroup, assertCanModerateGroup } from "../permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    const groupId = req.query.groupId;
    requireFields(req.body, ["operation"]);

    if (req.body.operation === "delete_message") {
      requireFields(req.body, ["messageId", "reason"]);
      const authority = await assertCanModerateGroup(supabase, user, groupId);
      const reason = moderationReason(req.body.reason);
      const { data: message, error: messageError } = await supabase
        .from("investment_group_messages")
        .select("id,user_id,channel,body")
        .eq("id", req.body.messageId)
        .eq("group_id", groupId)
        .single();
      if (messageError || !message) throw messageError || notFound("Trading Room message not found.");
      const targetRole = await memberRole(supabase, groupId, message.user_id);
      if (authority.role === "manager" && targetRole === "owner") throw forbidden("A group admin cannot remove the owner's messages.");

      const { error: deleteError } = await supabase.from("investment_group_messages").delete().eq("id", message.id);
      if (deleteError) throw deleteError;
      await recordModeration(supabase, {
        groupId,
        action: "message_deleted",
        actorUserId: user.id,
        targetUserId: message.user_id,
        messageId: message.id,
        reason,
        metadata: { channel: message.channel, bodyExcerpt: String(message.body || "").slice(0, 160) }
      });
      await notify(supabase, message.user_id, "group_message_removed", "Trading Room Message Removed", `A group message was removed. Reason: ${reason}`, { groupId, messageId: message.id });
      return res.status(200).json({ ok: true, report: { operation: "delete_message", groupId, messageId: message.id, status: "completed" } });
    }

    if (req.body.operation === "remove_member") {
      requireFields(req.body, ["memberId", "reason"]);
      const authority = await assertCanModerateGroup(supabase, user, groupId);
      const reason = moderationReason(req.body.reason);
      const { data: member, error: memberError } = await supabase
        .from("investment_group_members")
        .select("id,user_id,role,status")
        .eq("id", req.body.memberId)
        .eq("group_id", groupId)
        .single();
      if (memberError || !member || member.status !== "active") throw memberError || notFound("Active group member not found.");
      if (member.role === "owner") throw forbidden("Group ownership cannot be removed.");
      if (authority.role === "manager" && member.role === "manager") throw forbidden("A group admin cannot remove another group admin.");

      const { error: removeError } = await supabase.from("investment_group_members").update({ status: "removed" }).eq("id", member.id);
      if (removeError) throw removeError;
      await recordModeration(supabase, { groupId, action: "member_removed", actorUserId: user.id, targetUserId: member.user_id, reason, metadata: { previousRole: member.role } });
      await notify(supabase, member.user_id, "group_member_removed", "Investment Group Membership Removed", `Your group membership was removed. Reason: ${reason}`, { groupId });
      return res.status(200).json({ ok: true, report: { operation: "remove_member", groupId, memberId: member.id, status: "completed" } });
    }

    if (req.body.operation === "set_member_role") {
      requireFields(req.body, ["memberId", "role"]);
      await assertCanManageGroup(supabase, user, groupId);
      if (!["manager", "member"].includes(req.body.role)) throw badRequest("Role must be manager or member.");
      const { data: member, error: memberError } = await supabase
        .from("investment_group_members")
        .select("id,user_id,role,status")
        .eq("id", req.body.memberId)
        .eq("group_id", groupId)
        .single();
      if (memberError || !member || member.status !== "active") throw memberError || notFound("Active group member not found.");
      if (member.role === "owner") throw forbidden("The owner role cannot be changed.");
      const previousRole = member.role;
      const { error: roleError } = await supabase.from("investment_group_members").update({ role: req.body.role }).eq("id", member.id);
      if (roleError) throw roleError;
      await recordModeration(supabase, { groupId, action: "role_changed", actorUserId: user.id, targetUserId: member.user_id, reason: `Role changed from ${previousRole} to ${req.body.role}.`, metadata: { previousRole, nextRole: req.body.role } });
      await notify(supabase, member.user_id, "group_role_changed", "Investment Group Role Changed", `Your group role is now ${req.body.role}.`, { groupId, role: req.body.role });
      return res.status(200).json({ ok: true, report: { operation: "set_member_role", groupId, memberId: member.id, role: req.body.role, status: "completed" } });
    }

    if (req.body.operation === "set_public_sections") {
      requireFields(req.body, ["publicSections"]);
      await assertCanManageGroup(supabase, user, groupId);
      const allowed = new Set(["performance", "drawdown", "positions", "research", "members", "trading_room", "risk"]);
      const publicSections = Array.isArray(req.body.publicSections) ? [...new Set(req.body.publicSections.filter((section) => allowed.has(section)))] : [];
      const { error } = await supabase.from("investment_groups").update({ public_sections: publicSections, updated_at: new Date().toISOString() }).eq("id", groupId);
      if (error) throw error;
      return res.status(200).json({ ok: true, report: { operation: "set_public_sections", groupId, publicSections, status: "completed" } });
    }

    throw badRequest("Unknown moderation operation.");
  } catch (error) {
    return sendError(res, error);
  }
}

function moderationReason(value) {
  const reason = String(value || "").trim();
  if (reason.length < 5) throw badRequest("A specific moderation reason of at least 5 characters is required.");
  return reason.slice(0, 500);
}

async function memberRole(supabase, groupId, userId) {
  const { data } = await supabase.from("investment_group_members").select("role").eq("group_id", groupId).eq("user_id", userId).maybeSingle();
  return data?.role || "member";
}

async function recordModeration(supabase, input) {
  const { error } = await supabase.from("investment_group_moderation_events").insert({
    group_id: input.groupId,
    action: input.action,
    actor_user_id: input.actorUserId,
    target_user_id: input.targetUserId || null,
    message_id: input.messageId || null,
    reason: input.reason,
    metadata: input.metadata || {}
  });
  if (error) throw error;
}

async function notify(supabase, userId, eventType, title, body, metadata) {
  const { error } = await supabase.from("notification_events").insert({ user_id: userId, event_type: eventType, title, body, metadata });
  if (error) throw error;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}
