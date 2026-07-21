import { applyCors, requireFields, requireUser, sendError } from "../../portfolio-api.js";
import { assertNetworkCapability } from "../permissions.js";
import { badRequest, cleanText, emitSocialNotification, notFound } from "../social-utils.js";

const actions = new Set(["none", "hide", "remove", "warn", "restrict", "suspend"]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    assertNetworkCapability(user, "admin.override");
    if (req.method === "GET") {
      const status = ["pending", "reviewing", "resolved", "dismissed"].includes(req.query?.status) ? req.query.status : "pending";
      const { data, error } = await supabase.from("content_reports").select("*").eq("status", status).order("created_at").limit(100);
      if (error) throw error;
      return res.status(200).json({ reports: data || [] });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
    requireFields(req.body, ["reportId", "action", "reason"]);
    const action = String(req.body.action);
    if (!actions.has(action)) throw badRequest("Unsupported moderation action.");
    const reason = cleanText(req.body.reason, 1000, true);
    const { data: report, error } = await supabase.from("content_reports").select("*").eq("id", req.body.reportId).maybeSingle();
    if (error) throw error;
    if (!report) throw notFound("Moderation report unavailable.");
    if (action === "remove" || action === "hide") await applyContentAction(supabase, report, action);
    const targetUserId = await resolveTargetUserId(supabase, report);
    let restriction = null;
    if (action === "restrict" || action === "suspend") {
      if (!targetUserId) throw badRequest("This report target cannot be assigned an account restriction.");
      const durationDays = Math.max(1, Math.min(Number(req.body.durationDays) || (action === "suspend" ? 30 : 7), 365));
      const scope = action === "suspend" ? "all" : ["all", "posting", "comments", "engagement", "messaging", "media"].includes(req.body.scope) ? req.body.scope : "all";
      const { data, error: restrictionError } = await supabase.from("social_account_restrictions").insert({
        user_id: targetUserId,
        action,
        scope,
        reason,
        created_by: user.id,
        expires_at: new Date(Date.now() + durationDays * 86400000).toISOString(),
        metadata: { report_id: report.id }
      }).select("*").single();
      if (restrictionError) throw restrictionError;
      restriction = data;
    }
    if ((action === "warn" || action === "restrict" || action === "suspend") && targetUserId) {
      await emitSocialNotification(supabase, {
        userId: targetUserId,
        actorUserId: null,
        eventType: "moderation_notice",
        title: action === "warn" ? "Professional Network Warning" : `Professional Network ${action === "suspend" ? "Suspension" : "Restriction"}`,
        body: reason,
        deepLink: "/network/notifications",
        metadata: { report_id: report.id, action, restriction_id: restriction?.id || null }
      });
    }
    const { data: record, error: recordError } = await supabase.from("moderation_actions").insert({ report_id: report.id, moderator_user_id: user.id, target_type: report.target_type, target_id: report.target_id, action, reason, metadata: { restriction_id: restriction?.id || null } }).select("*").single();
    if (recordError) throw recordError;
    const resolution = action === "none" ? "dismissed" : "resolved";
    const { error: updateError } = await supabase.from("content_reports").update({ status: resolution, assigned_to: user.id, resolved_at: new Date().toISOString() }).eq("id", report.id);
    if (updateError) throw updateError;
    return res.status(200).json({ moderationAction: record, restriction, reportStatus: resolution });
  } catch (error) {
    return sendError(res, error);
  }
}

async function applyContentAction(supabase, report, action) {
  const now = new Date().toISOString();
  if (report.target_type === "post") {
    const { data: current, error: selectError } = await supabase.from("profile_posts").select("metadata").eq("id", report.target_id).maybeSingle();
    if (selectError) throw selectError;
    const patch = action === "remove"
      ? { deleted_at: now, status: "deleted", metadata: { ...(current?.metadata || {}), moderation_visibility: action } }
      : { status: "archived", metadata: { ...(current?.metadata || {}), moderation_visibility: action } };
    const { error } = await supabase.from("profile_posts").update(patch).eq("id", report.target_id);
    if (error) throw error;
  } else if (report.target_type === "comment") {
    const { error } = await supabase.from("social_comments").update({ deleted_at: now, body: "[removed by moderation]" }).eq("id", report.target_id);
    if (error) throw error;
  } else if (report.target_type === "message") {
    const { error } = await supabase.from("messages").update({ deleted_at: now, body: "" }).eq("id", report.target_id);
    if (error) throw error;
  }
}

async function resolveTargetUserId(supabase, report) {
  if (report.target_type === "profile") return report.target_id;
  const lookup = {
    post: ["profile_posts", "user_id"],
    comment: ["social_comments", "author_user_id"],
    message: ["messages", "sender_user_id"],
    group: ["investment_groups", "owner_user_id"]
  }[report.target_type];
  if (!lookup) return null;
  const [table, column] = lookup;
  const { data, error } = await supabase.from(table).select(column).eq("id", report.target_id).maybeSingle();
  if (error) throw error;
  return data?.[column] || null;
}
