import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../server/portfolio-api.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    requireMethod(req, "POST");

    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["orderId"]);

    const { data: existingOrder, error: lookupError } = await supabase
      .from("execution_orders")
      .select("*")
      .eq("id", req.body.orderId)
      .eq("user_id", user.id)
      .single();

    if (lookupError || !existingOrder) {
      const error = new Error("Order not found.");
      error.statusCode = 404;
      throw error;
    }

    const { data: order, error } = await supabase
      .from("execution_orders")
      .update({
        status: "cancelled",
        rejection_reason: existingOrder.status === "pending" ? null : existingOrder.rejection_reason
      })
      .eq("id", existingOrder.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) throw error;

    await supabase.from("execution_audit_logs").insert({
      user_id: user.id,
      account_id: order.account_id,
      order_id: order.id,
      event_type: "order_cancelled",
      severity: "info",
      message: `Order ${order.id} was cancelled.`,
      metadata: { previousStatus: existingOrder.status }
    });

    return res.status(200).json({ order });
  } catch (error) {
    return sendError(res, error);
  }
}
