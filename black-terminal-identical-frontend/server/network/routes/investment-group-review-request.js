import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { assertCanManageGroup } from "../permissions.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    const groupId = req.query.groupId;
    requireFields(req.body, ["requestId", "action"]);
    await assertCanManageGroup(supabase, user, groupId);

    const status = req.body.action === "approve" ? "approved" : "declined";
    const { data: request, error } = await supabase
      .from("investment_group_join_requests")
      .update({
        status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", req.body.requestId)
      .eq("group_id", groupId)
      .select("*")
      .single();

    if (error) throw error;

    if (status === "approved") {
      await supabase.from("investment_group_members").upsert({
        group_id: groupId,
        user_id: request.user_id,
        role: "member",
        status: "active",
        joined_at: new Date().toISOString()
      }, { onConflict: "group_id,user_id" });
    }

    await supabase.from("notification_events").insert({
      user_id: request.user_id,
      event_type: status === "approved" ? "join_request_approved" : "join_request_declined",
      title: status === "approved" ? "Join Request Approved" : "Join Request Declined",
      body: `Your investment group request was ${status}.`,
      metadata: { groupId, requestId: request.id }
    });

    return res.status(200).json({ request });
  } catch (error) {
    return sendError(res, error);
  }
}
