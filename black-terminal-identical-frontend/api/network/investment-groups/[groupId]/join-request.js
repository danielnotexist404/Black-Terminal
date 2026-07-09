import { applyCors, requireMethod, requireUser, sendError } from "../../../../server/portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    const groupId = req.query.groupId;

    const { data: group, error: groupError } = await supabase
      .from("investment_groups")
      .select("*")
      .eq("id", groupId)
      .single();
    if (groupError || !group) throw groupError || Object.assign(new Error("Investment group not found."), { statusCode: 404 });
    if (group.password_hash && group.password_hash !== req.body.passwordHash) {
      const error = new Error("Investment group password check failed.");
      error.statusCode = 403;
      throw error;
    }

    const { data, error } = await supabase
      .from("investment_group_join_requests")
      .insert({
        group_id: groupId,
        user_id: user.id,
        message: req.body.message || "",
        status: "pending"
      })
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("notification_events").insert({
      user_id: group.owner_user_id,
      event_type: "investment_group_join_request",
      title: "Investment Group Join Request",
      body: "A user requested access to your investment group.",
      metadata: { groupId, requestId: data.id }
    });

    return res.status(200).json({ request: data });
  } catch (error) {
    return sendError(res, error);
  }
}
