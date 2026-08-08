import { BCLIF_DEFAULT_NODE_ID, BCLIF_OBJECT_BUCKET, type BclifCollectorEnvironment } from "../contracts.ts";
import { BCLIF_MODEL_VERSION, BCLIF_SOURCE_VERSION } from "../../../src/modules/liquidation-field/core/types.ts";

export interface BclifRuntimeConfig {
  nodeId: string;
  environment: BclifCollectorEnvironment;
  region: string;
  deploymentCommit: string;
  imageDigest: string;
  modelVersion: string;
  sourceVersion: string;
  symbols: string[];
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  objectBucket: string;
  healthBindAddress: string;
  healthPort: number;
  frameCadenceMs: number;
  tileColumnCadenceMs: number;
  bookFrameCadenceMs: number;
  checkpointIntervalMs: number;
  heartbeatIntervalMs: number;
  oiPollIntervalMs: number;
  contextPollIntervalMs: number;
  maxClockDriftMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  eventChunkMaxBytes: number;
  eventChunkMaxAgeMs: number;
  dedupWindowMs: number;
  spoolDirectory: string;
  spoolMaxBytes: number;
  logLevel: string;
}

export function validateBclifRuntime(env: NodeJS.ProcessEnv = process.env): BclifRuntimeConfig {
  const errors: string[] = [];
  const nodeId = required(env.BCLIF_NODE_ID, "BCLIF_NODE_ID", errors) || BCLIF_DEFAULT_NODE_ID;
  if (![BCLIF_DEFAULT_NODE_ID, "IMM_NODE_01"].includes(nodeId)) {
    errors.push("BCLIF_NODE_ID must be LIQUIDATION_INTELLIGENCE_NODE_01 or IMM_NODE_01.");
  }
  const environment = String(env.BCLIF_ENVIRONMENT || "DEVELOPMENT").toUpperCase() as BclifCollectorEnvironment;
  if (!["PRODUCTION", "STAGING", "DEVELOPMENT"].includes(environment)) errors.push("BCLIF_ENVIRONMENT is invalid.");
  const region = required(env.BCLIF_REGION, "BCLIF_REGION", errors) || "local";
  const deploymentCommit = required(env.BCLIF_DEPLOYMENT_COMMIT, "BCLIF_DEPLOYMENT_COMMIT", errors) || "unknown";
  if (!/^[a-f0-9]{7,40}$/i.test(deploymentCommit)) {
    errors.push("BCLIF_DEPLOYMENT_COMMIT must be a 7-40 character immutable Git commit in every environment.");
  }
  const imageDigest = required(env.BCLIF_IMAGE_DIGEST, "BCLIF_IMAGE_DIGEST", errors) || "unknown";
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) {
    errors.push("BCLIF_IMAGE_DIGEST must be an immutable sha256 digest in every environment.");
  }
  const supabaseUrl = required(env.SUPABASE_URL || env.VITE_SUPABASE_URL, "SUPABASE_URL", errors);
  const supabaseServiceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", errors);
  const symbols = parseSymbols(env.BCLIF_SYMBOLS || "BTCUSDT", errors);
  const healthBindAddress = String(env.BCLIF_HEALTH_BIND_ADDRESS || "0.0.0.0").trim();
  if (!["0.0.0.0", "127.0.0.1", "::1"].includes(healthBindAddress)) errors.push("BCLIF_HEALTH_BIND_ADDRESS is not allowed.");
  const config: BclifRuntimeConfig = {
    nodeId,
    environment,
    region,
    deploymentCommit,
    imageDigest,
    modelVersion: String(env.BCLIF_MODEL_VERSION || BCLIF_MODEL_VERSION),
    sourceVersion: String(env.BCLIF_SOURCE_VERSION || BCLIF_SOURCE_VERSION),
    symbols,
    supabaseUrl,
    supabaseServiceRoleKey,
    objectBucket: String(env.BCLIF_OBJECT_BUCKET || BCLIF_OBJECT_BUCKET),
    healthBindAddress,
    healthPort: boundedInteger(env.BCLIF_HEALTH_PORT || env.PORT, 8091, 1, 65_535, "BCLIF_HEALTH_PORT", errors),
    frameCadenceMs: boundedInteger(env.BCLIF_FRAME_CADENCE_MS, 5_000, 1_000, 60_000, "BCLIF_FRAME_CADENCE_MS", errors),
    tileColumnCadenceMs: boundedInteger(env.BCLIF_TILE_COLUMN_CADENCE_MS, 60_000, 5_000, 900_000, "BCLIF_TILE_COLUMN_CADENCE_MS", errors),
    bookFrameCadenceMs: boundedInteger(env.BCLIF_BOOK_FRAME_CADENCE_MS, 5_000, 1_000, 60_000, "BCLIF_BOOK_FRAME_CADENCE_MS", errors),
    checkpointIntervalMs: boundedInteger(env.BCLIF_CHECKPOINT_INTERVAL_MS, 300_000, 30_000, 3_600_000, "BCLIF_CHECKPOINT_INTERVAL_MS", errors),
    heartbeatIntervalMs: boundedInteger(env.BCLIF_HEARTBEAT_INTERVAL_MS, 10_000, 2_000, 60_000, "BCLIF_HEARTBEAT_INTERVAL_MS", errors),
    oiPollIntervalMs: boundedInteger(env.BCLIF_OI_POLL_INTERVAL_MS, 300_000, 60_000, 3_600_000, "BCLIF_OI_POLL_INTERVAL_MS", errors),
    contextPollIntervalMs: boundedInteger(env.BCLIF_CONTEXT_POLL_INTERVAL_MS, 60_000, 10_000, 900_000, "BCLIF_CONTEXT_POLL_INTERVAL_MS", errors),
    maxClockDriftMs: boundedInteger(env.BCLIF_MAX_CLOCK_DRIFT_MS, 3_000, 250, 30_000, "BCLIF_MAX_CLOCK_DRIFT_MS", errors),
    reconnectBaseMs: boundedInteger(env.BCLIF_RECONNECT_BASE_MS, 750, 100, 30_000, "BCLIF_RECONNECT_BASE_MS", errors),
    reconnectMaxMs: boundedInteger(env.BCLIF_RECONNECT_MAX_MS, 30_000, 1_000, 300_000, "BCLIF_RECONNECT_MAX_MS", errors),
    eventChunkMaxBytes: boundedInteger(env.BCLIF_EVENT_CHUNK_MAX_BYTES, 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024, "BCLIF_EVENT_CHUNK_MAX_BYTES", errors),
    eventChunkMaxAgeMs: boundedInteger(env.BCLIF_EVENT_CHUNK_MAX_AGE_MS, 60_000, 5_000, 900_000, "BCLIF_EVENT_CHUNK_MAX_AGE_MS", errors),
    dedupWindowMs: boundedInteger(env.BCLIF_DEDUP_WINDOW_MS, 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000, "BCLIF_DEDUP_WINDOW_MS", errors),
    spoolDirectory: String(env.BCLIF_SPOOL_DIRECTORY || "/var/lib/bclif-spool"),
    spoolMaxBytes: boundedInteger(env.BCLIF_SPOOL_MAX_BYTES, 512 * 1024 * 1024, 16 * 1024 * 1024, 8 * 1024 * 1024 * 1024, "BCLIF_SPOOL_MAX_BYTES", errors),
    logLevel: String(env.BCLIF_LOG_LEVEL || "INFO").toUpperCase()
  };
  if (config.tileColumnCadenceMs % config.frameCadenceMs !== 0) errors.push("BCLIF_TILE_COLUMN_CADENCE_MS must be an exact multiple of BCLIF_FRAME_CADENCE_MS.");
  if ((6 * 60 * 60 * 1_000) % config.tileColumnCadenceMs !== 0 || (6 * 60 * 60 * 1_000) / config.tileColumnCadenceMs > 4_096) {
    errors.push("BCLIF_TILE_COLUMN_CADENCE_MS must divide six hours exactly and produce at most 4,096 base-tile columns.");
  }
  if (config.eventChunkMaxBytes * config.symbols.length > config.spoolMaxBytes) errors.push("BCLIF_SPOOL_MAX_BYTES must reserve at least one event chunk per configured symbol.");
  if (config.modelVersion !== BCLIF_MODEL_VERSION) errors.push(`Unsupported BCLIF_MODEL_VERSION; expected ${BCLIF_MODEL_VERSION}.`);
  if (config.sourceVersion !== BCLIF_SOURCE_VERSION) errors.push(`Unsupported BCLIF_SOURCE_VERSION; expected ${BCLIF_SOURCE_VERSION}.`);
  if (config.objectBucket !== BCLIF_OBJECT_BUCKET) errors.push(`BCLIF_OBJECT_BUCKET must be ${BCLIF_OBJECT_BUCKET}.`);
  if (errors.length) {
    throw Object.assign(new Error(`BCLIF runtime is not ready: ${errors.join(" ")}`), {
      code: "BCLIF_RUNTIME_INVALID",
      reasons: errors
    });
  }
  return config;
}

export function parseSymbols(raw: string, errors: string[] = []) {
  const symbols = String(raw)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(symbols)];
  if (!unique.length) errors.push("BCLIF_SYMBOLS must contain at least one symbol.");
  if (unique.length > 25) errors.push("BCLIF_SYMBOLS may contain at most 25 symbols.");
  for (const symbol of unique) {
    if (!/^[A-Z0-9]{3,30}$/.test(symbol)) errors.push(`Invalid BCLIF symbol ${symbol}.`);
  }
  return unique;
}

function required(value: unknown, label: string, errors: string[]) {
  const normalized = String(value || "").trim();
  if (!normalized) errors.push(`${label} is required.`);
  return normalized;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string, errors: string[]) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${label} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return parsed;
}
