import crypto from "node:crypto";

export const BCLIF_BUCKET_ID = "bclif-field-chunks";
export const BCLIF_INDICATOR_KEY = "liquidationHeatmap";
export const BCLIF_MAX_TILE_BYTES = 50 * 1024 * 1024;
export const BCLIF_MAX_QUERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const BCLIF_LIVE_QUERY_DRIFT_MS = 5 * 60 * 1000;
export const BCLIF_LIVE_HEARTBEAT_MS = 120_000;
export const BCLIF_SUPPORTED_MODEL_VERSION = "BCLIF_MODEL_V4_CAUSAL";
export const BCLIF_SUPPORTED_SOURCE_VERSION = "BYBIT_V5_PUBLIC_2026_08";
export const BCLIF_SUPPORTED_SCHEMA_VERSION = 2;
export const BCLIF_SUPPORTED_TILE_VERSION = 1;
export const BCLIF_SUPPORTED_COMPRESSION = "gzip-v1";
export const BCLIF_SUPPORTED_MODEL_AUTHORITY = "PERSISTENT_NODE";
export const BCLIF_HORIZONS = Object.freeze(["6H", "12H", "1D", "3D", "1W", "3W", "1M", "CUSTOM"]);
export const BCLIF_ACTIONS = Object.freeze(["status", "health", "coverage", "manifest", "tile", "diagnostics"]);

const SYMBOL_PATTERN = /^[A-Z0-9_-]{2,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^sha256:([a-f0-9]{64})$/;
const TILE_PATH_PATTERN = /^v([1-9][0-9]*)\/BYBIT\/linear_perpetual\/([A-Z0-9_-]{2,40})\/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)\/([0-9]{10,16})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{64})\.bclif$/;

export function parseBclifAction(value) {
  const action = String(value || "").replace(/\.js$/, "").trim().toLowerCase();
  if (!BCLIF_ACTIONS.includes(action)) throw bclifHttpError(404, "Unknown liquidation-intelligence route.", "BCLIF_ROUTE_NOT_FOUND");
  return action;
}

export function parseBclifScope(query = {}, options = {}) {
  const venue = String(query.venue || "BYBIT").trim().toUpperCase();
  const marketKind = String(query.marketKind || query.market_kind || "linear_perpetual").trim().toLowerCase();
  const symbol = String(query.symbol || "BTCUSDT").trim().toUpperCase();
  const horizon = String(query.horizon || "1D").trim().toUpperCase();
  const rawMode = String(query.mode || "").trim().toUpperCase();
  const mode = rawMode || null;
  if (venue !== "BYBIT") throw bclifHttpError(400, "BCLIF currently supports BYBIT only.", "INVALID_VENUE");
  if (marketKind !== "linear_perpetual") throw bclifHttpError(400, "Unsupported BCLIF market kind.", "INVALID_MARKET_KIND");
  if (!SYMBOL_PATTERN.test(symbol)) throw bclifHttpError(400, "Invalid BCLIF symbol.", "INVALID_SYMBOL");
  if (!BCLIF_HORIZONS.includes(horizon)) throw bclifHttpError(400, "Invalid BCLIF horizon.", "INVALID_HORIZON");
  if (mode !== null && mode !== "LIVE" && mode !== "REPLAY") throw bclifHttpError(400, "Invalid BCLIF request mode.", "INVALID_REQUEST_MODE");
  if (options.requireMode && mode === null) throw bclifHttpError(400, "BCLIF request mode is required.", "INVALID_REQUEST_MODE");

  const from = parseOptionalTimestamp(query.from ?? query.start);
  const to = parseOptionalTimestamp(query.to ?? query.end);
  if ((from === null) !== (to === null)) throw bclifHttpError(400, "Both range boundaries are required.", "INVALID_TIME_RANGE");
  if (from !== null && (to <= from || to - from > BCLIF_MAX_QUERY_WINDOW_MS)) {
    throw bclifHttpError(400, "BCLIF time range is invalid or exceeds 90 days.", "INVALID_TIME_RANGE");
  }
  if (to !== null && to > Date.now() + 5 * 60_000) throw bclifHttpError(400, "BCLIF range cannot extend into the future.", "INVALID_TIME_RANGE");
  if (mode === "LIVE" && to !== null && Math.abs(Date.now() - to) > BCLIF_LIVE_QUERY_DRIFT_MS) {
    throw bclifHttpError(400, "A live BCLIF range must terminate near the current collector edge.", "INVALID_TIME_RANGE");
  }
  if (options.requireRange && from === null) throw bclifHttpError(400, "A bounded BCLIF time range is required.", "INVALID_TIME_RANGE");
  return { venue, marketKind, symbol, horizon, mode, from, to };
}

export function parseTileId(value) {
  const tileId = String(value || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(tileId)) throw bclifHttpError(400, "Invalid BCLIF tile identifier.", "INVALID_TILE_ID");
  return tileId;
}

export function parseTileChecksum(value) {
  const checksum = String(value || "").trim().toLowerCase();
  if (!CHECKSUM_PATTERN.test(checksum)) throw bclifHttpError(400, "Invalid BCLIF tile checksum.", "INVALID_TILE_CHECKSUM");
  return checksum;
}

export function validateTileObjectPath(path, expected = {}) {
  const clean = String(path || "");
  const match = TILE_PATH_PATTERN.exec(clean);
  if (!match) throw bclifHttpError(422, "BCLIF tile path failed its storage contract.", "INVALID_TILE_PATH");
  const [, schemaVersion, symbol, horizon, startMs, tileId, checksumHex] = match;
  if (expected.schemaVersion !== undefined && Number(schemaVersion) !== Number(expected.schemaVersion)) throw pathMismatch();
  if (expected.symbol && symbol !== String(expected.symbol).toUpperCase()) throw pathMismatch();
  if (expected.horizon && horizon !== expected.horizon) throw pathMismatch();
  if (expected.startMs !== undefined && Number(startMs) !== Number(expected.startMs)) throw pathMismatch();
  if (expected.tileId && tileId !== String(expected.tileId).toLowerCase()) throw pathMismatch();
  if (expected.checksum && `sha256:${checksumHex}` !== String(expected.checksum).toLowerCase()) throw pathMismatch();
  return clean;
}

export function verifyTileChecksum(bytes, expectedChecksum) {
  const match = CHECKSUM_PATTERN.exec(String(expectedChecksum || "").toLowerCase());
  if (!match) throw bclifHttpError(422, "BCLIF tile checksum metadata is invalid.", "INVALID_TILE_CHECKSUM");
  const actual = crypto.createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(match[1], "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw bclifHttpError(422, "BCLIF tile checksum verification failed.", "TILE_CHECKSUM_MISMATCH");
  }
  return true;
}

export function sanitizeTileMetadata(row) {
  return {
    tileId: row.id,
    horizon: row.horizon,
    startTime: Date.parse(row.chunk_start),
    endTime: Date.parse(row.chunk_end),
    minPrice: finiteNumber(row.price_min),
    maxPrice: finiteNumber(row.price_max),
    timeStepMs: finiteNumber(row.time_step_ms),
    priceStep: finiteNumber(row.price_step),
    columns: finiteNumber(row.columns),
    rows: finiteNumber(row.rows),
    modelVersion: row.model_version,
    schemaVersion: finiteNumber(row.schema_version),
    tileVersion: finiteNumber(row.tile_version),
    compression: row.compression,
    checksum: row.checksum,
    compressedBytes: finiteNumber(row.compressed_bytes),
    sourceCutoffTimestamp: Date.parse(row.source_cutoff_at),
    coverageQuality: row.coverage_quality,
    modelAuthority: row.model_authority,
    channelManifest: safeObject(row.channel_manifest),
    scaleMetadata: safeObject(row.scale_metadata),
    publicationState: row.publication_state,
    publishedAt: row.published_at
  };
}

export function isDeferredBclifInfrastructureError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["42P01", "42703", "PGRST204", "PGRST205"].includes(code)) return true;
  const message = String(error?.message || "").toLowerCase();
  return /schema cache|relation .* does not exist|column .* does not exist|could not find the table/.test(message);
}

export function normalizeBclifRouteError(error) {
  if (error?.statusCode) return error;
  const message = String(error?.message || "");
  if (/Missing SUPABASE_URL\/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY|supabase(?:Url| URL).*?(?:required|missing|invalid)|service.role.*?(?:required|missing)/i.test(message)) {
    return bclifHttpError(503, "BCLIF persistence control plane is unavailable.", "PERSISTENCE_CONTROL_PLANE_UNAVAILABLE", { retryable: true });
  }
  return error;
}

export function bclifDeferredPayload(scope = null) {
  return {
    status: "ok",
    deploymentState: "NOT_DEPLOYED",
    collectorState: "NOT_DEPLOYED",
    modelAuthority: "BROWSER_FALLBACK",
    persistence: false,
    sourceMode: "UNAVAILABLE",
    scope: scope ? publicScope(scope) : null,
    history: "BUILDS ONLY WHILE THIS CHART IS OPEN",
    tiles: [],
    generatedAt: new Date().toISOString()
  };
}

export function publicScope(scope) {
  return {
    venue: scope.venue,
    marketKind: scope.marketKind,
    symbol: scope.symbol,
    horizon: scope.horizon,
    mode: scope.mode,
    requestedStart: scope.from,
    requestedEnd: scope.to
  };
}

export function bclifHttpError(statusCode, message, code, publicDetails) {
  return Object.assign(new Error(message), { statusCode, code, publicDetails });
}

function parseOptionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" || /^\d{10,16}$/.test(String(value)) ? Number(value) : NaN;
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) throw bclifHttpError(400, "Invalid BCLIF timestamp.", "INVALID_TIMESTAMP");
  return parsed;
}

function pathMismatch() {
  return bclifHttpError(422, "BCLIF tile path does not match immutable metadata.", "TILE_PATH_METADATA_MISMATCH");
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
