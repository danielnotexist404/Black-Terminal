export const MARKET_DEPTH_COMPRESSION_VERSION = 1;

export const depthResolutions = {
  raw: { label: "raw", ms: 0, retentionTier: "raw-hours" },
  "1s": { label: "1s", ms: 1000, retentionTier: "seconds-days" },
  "10s": { label: "10s", ms: 10000, retentionTier: "tens-weeks" },
  "1m": { label: "1m", ms: 60000, retentionTier: "minutes-months" }
};

export const liquidityWallStatuses = [
  "ACTIVE",
  "GROWING",
  "WEAKENING",
  "MIGRATING",
  "PULLED",
  "ABSORBED",
  "BROKEN",
  "SPOOF_SUSPECTED"
];

export const liquidityEventTypes = [
  "WALL_APPEARED",
  "WALL_STRENGTHENED",
  "WALL_WEAKENED",
  "WALL_MIGRATED",
  "WALL_PULLED",
  "WALL_ABSORBED",
  "LIQUIDITY_VACUUM",
  "POC_MIGRATED",
  "ICEBERG_DETECTED",
  "STACKING_DETECTED",
  "PULLING_DETECTED"
];

export function normalizeVenue(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeMarketKind(value) {
  const clean = String(value || "perpetual").trim().toLowerCase();
  if (clean === "perp") return "perpetual";
  if (clean === "future") return "futures";
  return clean;
}

export function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

export function horizonToMs(horizon) {
  switch (String(horizon || "").toLowerCase()) {
    case "15m": return 15 * 60 * 1000;
    case "1h": return 60 * 60 * 1000;
    case "2h": return 2 * 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "12h": return 12 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "3d": return 3 * 24 * 60 * 60 * 1000;
    case "1w": return 7 * 24 * 60 * 60 * 1000;
    case "1m":
    case "1mo":
      return 31 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

export function selectResolutionForReplay({ horizon, rangePct }) {
  const ms = horizonToMs(horizon);
  const pct = Number(rangePct);
  if (ms <= 60 * 60 * 1000 && (!Number.isFinite(pct) || pct <= 2)) return "1s";
  if (ms <= 3 * 24 * 60 * 60 * 1000 && (!Number.isFinite(pct) || pct <= 10)) return "10s";
  return "1m";
}

export function floorTime(timestampMs, resolution) {
  const config = depthResolutions[resolution] || depthResolutions["1s"];
  if (!config.ms) return timestampMs;
  return Math.floor(timestampMs / config.ms) * config.ms;
}
