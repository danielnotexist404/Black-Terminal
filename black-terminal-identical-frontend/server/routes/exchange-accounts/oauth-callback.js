import { getSupabaseAdmin, sendError } from "../../portfolio-api.js";
import { exchangeBybitAuthorizationCode, hashOAuthState, publicAppUrl } from "../../exchanges/bybit-oauth.js";
import { establishExchangeAccount } from "../../exchanges/exchange-account-service.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") throw Object.assign(new Error("Method Not Allowed"), { statusCode: 405 });
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) throw Object.assign(new Error("OAuth callback is missing code or state."), { statusCode: 400, code: "OAUTH_CALLBACK_INVALID" });
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const stateHash = hashOAuthState(state);
    const { data: oauthState, error } = await supabase.from("broker_oauth_states")
      .update({ consumed_at: now }).eq("state_hash", stateHash).is("consumed_at", null).gt("expires_at", now).select("*").single();
    if (error || !oauthState) throw Object.assign(new Error("OAuth state is invalid, expired, or already consumed."), { statusCode: 400, code: "OAUTH_STATE_INVALID" });
    const authorization = await exchangeBybitAuthorizationCode(code);
    const result = await establishExchangeAccount({
      supabase, user: { id: oauthState.user_id }, authorization,
      input: { exchange: "bybit", accountName: oauthState.account_name, apiKey: authorization.apiKey, apiSecret: authorization.apiSecret }
    });
    const destination = publicAppUrl(oauthState.return_path);
    destination.searchParams.set("brokerOAuth", "success");
    destination.searchParams.set("accountId", result.account.id);
    res.statusCode = 303;
    res.setHeader("Location", destination.toString());
    return res.end();
  } catch (error) {
    try {
      const destination = publicAppUrl("/");
      destination.searchParams.set("brokerOAuth", "error");
      destination.searchParams.set("code", error?.code || "OAUTH_FAILED");
      res.statusCode = 303;
      res.setHeader("Location", destination.toString());
      return res.end();
    } catch {
      return sendError(res, error);
    }
  }
}
