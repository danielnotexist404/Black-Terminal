import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { establishExchangeAccount } from "../../exchanges/exchange-account-service.js";
import { BYBIT_EXECUTION_ENVIRONMENTS } from "../../exchanges/bybit-endpoints.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    const { supabase, user } = await requireUser(req);
    requireFields(req.body, ["exchange", "accountName", "apiKey", "apiSecret"]);
    if (String(req.body.exchange).toLowerCase() !== "bybit") {
      const error = new Error("Bybit Demo Trading is the only demo execution adapter available.");
      error.statusCode = 400;
      throw error;
    }
    return res.status(200).json(await establishExchangeAccount({
      supabase,
      user,
      input: req.body,
      executionEnvironment: BYBIT_EXECUTION_ENVIRONMENTS.DEMO
    }));
  } catch (error) {
    return sendError(res, error);
  }
}
