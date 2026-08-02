import { assertProviderEndpoint } from "./provider-allowlist.js";
import { BYBIT_EXECUTION_ENVIRONMENTS, normalizeBybitExecutionEnvironment, resolveBybitEndpointSet } from "../exchanges/bybit-endpoints.js";

export function validateBlackCloudRuntime(env = process.env) {
  const errors = [];
  required(env.SUPABASE_URL || env.VITE_SUPABASE_URL, "SUPABASE_URL", errors);
  required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", errors);
  required(env.BLACK_CLOUD_INTENT_SIGNING_KEY, "BLACK_CLOUD_INTENT_SIGNING_KEY", errors);
  if (env.BLACK_CLOUD_INTENT_SIGNING_KEY && Buffer.byteLength(env.BLACK_CLOUD_INTENT_SIGNING_KEY) < 32) errors.push("BLACK_CLOUD_INTENT_SIGNING_KEY must contain at least 32 bytes.");
  const masterKeyVersion = positiveInteger(env.BLACK_CLOUD_MASTER_KEY_VERSION, 1);
  const encodedMasterKey = env[`BLACK_CLOUD_SECRET_MASTER_KEY_V${masterKeyVersion}`]
    || env.BLACK_CLOUD_SECRET_MASTER_KEY
    || env.EXCHANGE_CREDENTIAL_MASTER_KEY;
  required(encodedMasterKey, `BLACK_CLOUD_SECRET_MASTER_KEY_V${masterKeyVersion} (or the legacy master-key variable)`, errors);
  if (encodedMasterKey && Buffer.from(encodedMasterKey, "base64").length !== 32) errors.push("The credential master key must decode to exactly 32 bytes.");
  for (const flag of ["BLACK_CLOUD_EXECUTION_ENABLED", "INVESTMENT_GROUP_EXECUTION_ENABLED", "BYBIT_CLOUD_EXECUTION_ENABLED"]) {
    if (env[flag] !== "true") errors.push(`${flag} must be true.`);
  }
  let executionEnvironment;
  let endpointSet;
  try {
    executionEnvironment = normalizeBybitExecutionEnvironment(env.BLACK_CLOUD_EXECUTION_ENVIRONMENT || env.BYBIT_EXECUTION_ENVIRONMENT || env.BLACK_CLOUD_NETWORK);
    endpointSet = resolveBybitEndpointSet({ executionEnvironment, endpointProfile: env.BYBIT_ENDPOINT_PROFILE || "GLOBAL" });
  } catch (error) {
    errors.push(error.message);
  }
  if (executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE && env.BLACK_CLOUD_MAINNET_ENABLED !== "true") errors.push("BLACK_CLOUD_MAINNET_ENABLED must be true for MAINNET_LIVE.");
  if (executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO && env.BYBIT_DEMO_ENABLED !== "true") errors.push("BYBIT_DEMO_ENABLED must be true for DEMO.");
  if (env.BYBIT_BASE_URL || env.BYBIT_PRIVATE_WS_URL) errors.push("Legacy Bybit endpoint overrides are forbidden. Use BLACK_CLOUD_EXECUTION_ENVIRONMENT and BYBIT_ENDPOINT_PROFILE.");
  if (endpointSet) {
    for (const [endpoint, protocol] of [[endpointSet.rest, "https"], [endpointSet.privateWebSocket, "wss"]]) {
      try { assertProviderEndpoint({ provider: "bybit", environment: executionEnvironment, endpoint, protocol }); }
      catch (error) { errors.push(error.message); }
    }
  }
  if (errors.length) throw Object.assign(new Error(`Black Cloud runtime is not ready: ${errors.join(" ")}`), { code: "BLACK_CLOUD_RUNTIME_INVALID", reasons: errors });
  return {
    executionEnvironment,
    network: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet",
    mainnet: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE,
    endpointProfile: endpointSet.region,
    websocketOrderEntrySupported: endpointSet.websocketOrderEntrySupported,
    masterKeyVersion
  };
}

function required(value, label, errors) {
  if (!String(value || "").trim()) errors.push(`${label} is required.`);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
