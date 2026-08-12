import { applyCors, requireFields, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { createBybitAuthorizationRequest, safeOAuthReturnPath } from "../../exchanges/bybit-oauth.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "POST");
    requireFields(req.body, ["provider", "accountName"]);
    if (String(req.body.provider).toLowerCase() !== "bybit") throw Object.assign(new Error("OAuth authorization is not available for this provider."), { statusCode: 501, code: "AUTHORIZATION_METHOD_UNSUPPORTED" });
    const { supabase, user } = await requireUser(req);
    const authorization = createBybitAuthorizationRequest();
    const { error } = await supabase.from("broker_oauth_states").insert({
      user_id: user.id, provider: "bybit", state_hash: authorization.stateHash,
      account_name: String(req.body.accountName).trim(), execution_environment: "MAINNET_LIVE",
      endpoint_profile: "GLOBAL", return_path: safeOAuthReturnPath(req.body.returnPath),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
    });
    if (error) throw error;
    await supabase.from("execution_audit_logs").insert({ user_id: user.id, account_id: null, event_type: "broker_authorization_started", severity: "info", message: "Bybit OAuth authorization started.", metadata: { provider: "bybit", endpointProfile: "GLOBAL" } });
    return res.status(200).json({ authorizationUrl: authorization.authorizationUrl, expiresInSeconds: 600 });
  } catch (error) {
    return sendError(res, error);
  }
}
