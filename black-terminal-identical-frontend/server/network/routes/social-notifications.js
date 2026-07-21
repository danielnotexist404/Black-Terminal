import { applyCors, requireFields, requireUser, sendError } from "../../portfolio-api.js";
import { badRequest, ensureNetworkProfile } from "../social-utils.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const { supabase, user } = await requireUser(req);
    await ensureNetworkProfile(supabase, user);
    if (req.method === "GET") {
      const cursor = req.query?.cursor ? String(req.query.cursor) : null;
      let query = supabase.from("notification_events").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(31);
      if (cursor) query = query.lt("created_at", cursor);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      const actorIds = [...new Set(rows.map((item) => item.actor_user_id).filter(Boolean))];
      const { data: actors, error: actorError } = actorIds.length
        ? await supabase.from("profiles_extended").select("user_id,handle,display_name,professional_role").in("user_id", actorIds)
        : { data: [], error: null };
      if (actorError) throw actorError;
      const actorMap = new Map((actors || []).map((actor) => [actor.user_id, actor]));
      const { count } = await supabase.from("notification_events").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("read_at", null);
      const { data: preferences, error: preferenceError } = await supabase.from("notification_preferences").select("*").eq("user_id", user.id).maybeSingle();
      if (preferenceError) throw preferenceError;
      return res.status(200).json({ notifications: rows.slice(0, 30).map((item) => ({ ...item, actor: actorMap.get(item.actor_user_id) || null })), unreadCount: count || 0, preferences, nextCursor: rows.length > 30 ? rows[29].created_at : null });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
    requireFields(req.body, ["operation"]);
    if (req.body.operation === "read") {
      let query = supabase.from("notification_events").update({ read_at: new Date().toISOString() }).eq("user_id", user.id).is("read_at", null);
      if (req.body.notificationId) query = query.eq("id", req.body.notificationId);
      const { error } = await query;
      if (error) throw error;
      return res.status(200).json({ read: true });
    }
    if (req.body.operation === "preferences") {
      const patch = sanitizePreferences(req.body.preferences);
      const { data, error } = await supabase.from("notification_preferences").upsert({ user_id: user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select("*").single();
      if (error) throw error;
      return res.status(200).json({ preferences: data });
    }
    throw badRequest("Unknown notification operation.");
  } catch (error) {
    return sendError(res, error);
  }
}

function sanitizePreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  const patch = {};
  ["follows", "reactions", "comments", "reposts", "messages", "mentions", "group_activity", "indicator_updates"].forEach((key) => {
    if (typeof source[key] === "boolean") patch[key] = source[key];
  });
  if (["off", "daily", "weekly"].includes(source.email_digest)) patch.email_digest = source.email_digest;
  return patch;
}
