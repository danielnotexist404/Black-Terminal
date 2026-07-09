import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertCanManageGroup } from "../permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { supabase, user } = await requireUser(req);
    const groupId = req.query.groupId;

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("investment_group_messages")
        .select("*")
        .eq("group_id", groupId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return res.status(200).json({ messages: data || [] });
    }

    requireMethod(req, "POST");
    requireFields(req.body, ["channel", "body"]);

    const { data: member } = await supabase
      .from("investment_group_members")
      .select("role,status")
      .eq("group_id", groupId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (req.body.channel === "announcements") {
      await assertCanManageGroup(supabase, user, groupId);
    } else if (!member || member.status !== "active") {
      const error = new Error("Trading Room access requires group membership.");
      error.statusCode = 403;
      throw error;
    }

    const { data, error } = await supabase
      .from("investment_group_messages")
      .insert({
        group_id: groupId,
        channel: req.body.channel,
        user_id: user.id,
        body: req.body.body,
        metadata: req.body.metadata || {}
      })
      .select("*")
      .single();

    if (error) throw error;
    return res.status(200).json({ message: data });
  } catch (error) {
    return sendError(res, error);
  }
}
