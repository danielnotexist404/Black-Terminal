import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { establishExchangeAccount } from "../../exchanges/exchange-account-service.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["exchange", "accountName", "apiKey", "apiSecret"]);
    return res.status(200).json(await establishExchangeAccount({ supabase, user, input: req.body }));
  } catch (error) {
    return sendError(res, error);
  }
}
