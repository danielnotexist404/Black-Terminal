import { assertProviderEndpoint } from "./provider-allowlist.js";
import { BYBIT_EXECUTION_ENVIRONMENTS, normalizeBybitExecutionEnvironment, resolveBybitEndpointSet } from "../exchanges/bybit-endpoints.js";

export function validateBlackCloudRuntime(env = process.env) {
  const errors = [];
  required(env.BLACK_CLOUD_NODE_ID, "BLACK_CLOUD_NODE_ID", errors);
  if (env.BLACK_CLOUD_NODE_ID && env.BLACK_CLOUD_NODE_ID !== "BLACK_CLOUD_NODE_01") errors.push("BLACK_CLOUD_NODE_ID must be BLACK_CLOUD_NODE_01 for the first production node.");
  required(env.BLACK_CLOUD_WORKER_REGION, "BLACK_CLOUD_WORKER_REGION", errors);
  required(env.BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT, "BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT", errors);
  if (env.BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT && env.BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT !== "PRODUCTION") errors.push("BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT must be PRODUCTION.");
  required(env.BLACK_CLOUD_DEPLOYMENT_COMMIT, "BLACK_CLOUD_DEPLOYMENT_COMMIT", errors);
  if (env.BLACK_CLOUD_DEPLOYMENT_COMMIT && !/^[a-f0-9]{7,40}$/i.test(env.BLACK_CLOUD_DEPLOYMENT_COMMIT)) errors.push("BLACK_CLOUD_DEPLOYMENT_COMMIT must be a 7-40 character Git commit.");
  required(env.BLACK_CLOUD_IMAGE_DIGEST, "BLACK_CLOUD_IMAGE_DIGEST", errors);
  if (env.BLACK_CLOUD_IMAGE_DIGEST && !/^sha256:[a-f0-9]{64}$/i.test(env.BLACK_CLOUD_IMAGE_DIGEST)) errors.push("BLACK_CLOUD_IMAGE_DIGEST must be a sha256 digest.");
  required(env.SUPABASE_URL || env.VITE_SUPABASE_URL, "SUPABASE_URL", errors);
  required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", errors);
  required(env.BLACK_CLOUD_INTENT_SIGNING_KEY, "BLACK_CLOUD_INTENT_SIGNING_KEY", errors);
  if (env.BLACK_CLOUD_INTENT_SIGNING_KEY && Buffer.byteLength(env.BLACK_CLOUD_INTENT_SIGNING_KEY) < 32) errors.push("BLACK_CLOUD_INTENT_SIGNING_KEY must contain at least 32 bytes.");
  const masterKeyVersion = positiveInteger(env.BLACK_CLOUD_MASTER_KEY_VERSION, 1);
  const encodedMasterKey = env[`BLACK_CLOUD_SECRET_MASTER_KEY_V${masterKeyVersion}`]
    || env.BLACK_CLOUD_SECRET_MASTER_KEY
    || env.EXCHANGE_CREDENTIAL_MASTER_KEY;
  required(encodedMasterKey, `BLACK_CLOUD_SECRET_MASTER_KEY_V${masterKeyVersion} (or the legacy master-key variable)`, errors);
  if (encodedMasterKey && (!/^[A-Za-z0-9+/]{43}=$/.test(encodedMasterKey) || Buffer.from(encodedMasterKey, "base64").length !== 32)) errors.push("The credential master key must be canonical base64 that decodes to exactly 32 bytes.");
  for (const flag of ["BLACK_CLOUD_EXECUTION_ENABLED", "BYBIT_CLOUD_EXECUTION_ENABLED"]) {
    if (env[flag] !== "true") errors.push(`${flag} must be true.`);
  }
  if (env.INVESTMENT_GROUP_EXECUTION_ENABLED !== "true" && env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED !== "true") {
    errors.push("At least one bounded execution subsystem must be enabled.");
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
  if (executionEnvironment !== BYBIT_EXECUTION_ENVIRONMENTS.DEMO && env.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED === "true") errors.push("STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED requires a DEMO-isolated worker.");
  if (env.BYBIT_BASE_URL || env.BYBIT_PRIVATE_WS_URL) errors.push("Legacy Bybit endpoint overrides are forbidden. Use BLACK_CLOUD_EXECUTION_ENVIRONMENT and BYBIT_ENDPOINT_PROFILE.");
  if (endpointSet) {
    for (const [endpoint, protocol] of [[endpointSet.rest, "https"], [endpointSet.privateWebSocket, "wss"]]) {
      try { assertProviderEndpoint({ provider: "bybit", environment: executionEnvironment, endpoint, protocol }); }
      catch (error) { errors.push(error.message); }
    }
  }
  const maxClockDriftMs = boundedInteger(env.BLACK_CLOUD_MAX_CLOCK_DRIFT_MS, 3_000, 500, 30_000, "BLACK_CLOUD_MAX_CLOCK_DRIFT_MS", errors);
  const nodeHeartbeatIntervalMs = boundedInteger(env.BLACK_CLOUD_NODE_HEARTBEAT_INTERVAL_MS, 10_000, 2_000, 60_000, "BLACK_CLOUD_NODE_HEARTBEAT_INTERVAL_MS", errors);
  const healthPort = boundedInteger(env.BLACK_CLOUD_HEALTH_PORT, 8080, 1, 65_535, "BLACK_CLOUD_HEALTH_PORT", errors);
  const metricsPort = boundedInteger(env.BLACK_CLOUD_METRICS_PORT, healthPort, 1, 65_535, "BLACK_CLOUD_METRICS_PORT", errors);
  const healthBindAddress = String(env.BLACK_CLOUD_HEALTH_BIND_ADDRESS || "0.0.0.0").trim();
  const metricsBindAddress = String(env.BLACK_CLOUD_METRICS_BIND_ADDRESS || healthBindAddress).trim();
  for (const [label, value] of [["BLACK_CLOUD_HEALTH_BIND_ADDRESS", healthBindAddress], ["BLACK_CLOUD_METRICS_BIND_ADDRESS", metricsBindAddress]]) {
    if (!new Set(["0.0.0.0", "127.0.0.1", "::1"]).has(value)) errors.push(`${label} must bind to an explicitly supported local/container address.`);
  }
  if (metricsPort !== healthPort || metricsBindAddress !== healthBindAddress) errors.push("Health and metrics must share the same loopback-published container listener in the single-VPS profile.");
  if (errors.length) throw Object.assign(new Error(`Black Cloud runtime is not ready: ${errors.join(" ")}`), { code: "BLACK_CLOUD_RUNTIME_INVALID", reasons: errors });
  return {
    nodeId: env.BLACK_CLOUD_NODE_ID,
    deploymentEnvironment: env.BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT,
    deploymentCommit: env.BLACK_CLOUD_DEPLOYMENT_COMMIT,
    imageDigest: env.BLACK_CLOUD_IMAGE_DIGEST,
    region: env.BLACK_CLOUD_WORKER_REGION,
    executionEnvironment,
    network: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.DEMO ? "demo" : "mainnet",
    mainnet: executionEnvironment === BYBIT_EXECUTION_ENVIRONMENTS.MAINNET_LIVE,
    endpointProfile: endpointSet.region,
    websocketOrderEntrySupported: endpointSet.websocketOrderEntrySupported,
    masterKeyVersion,
    maxClockDriftMs,
    nodeHeartbeatIntervalMs,
    healthBindAddress,
    healthPort,
    metricsBindAddress,
    metricsPort
  };
}

function required(value, label, errors) {
  if (!String(value || "").trim()) errors.push(`${label} is required.`);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum, label, errors) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${label} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return parsed;
}
