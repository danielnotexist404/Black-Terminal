const BYBIT_POSITION_INDEXES = new Set([0, 1, 2]);

export function bybitPositionKey(position) {
  const network = normalize(position?.network || "mainnet");
  const category = normalize(position?.category || "linear");
  const marketKind = normalize(position?.marketKind || position?.market_kind || "perpetual");
  const symbol = normalizeSymbol(position?.symbol);
  const positionIdx = normalizePositionIdx(position?.positionIdx ?? position?.position_idx);
  const direction = normalizeDirection(position?.direction || position?.side, positionIdx);
  return `bybit:${network}:${category}:${marketKind}:${symbol}:${positionIdx}:${direction}`;
}

export function canonicalizeBybitPositions(positions, accountId) {
  const byKey = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    const quantity = Number(position?.quantity ?? position?.size ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const canonicalKey = bybitPositionKey(position);
    const normalized = {
      ...position,
      accountId,
      exchange: "bybit",
      network: "mainnet",
      category: normalize(position?.category || position?.marketKind || "linear"),
      marketKind: normalize(position?.marketKind || "perpetual"),
      symbol: normalizeSymbol(position?.symbol),
      positionIdx: normalizePositionIdx(position?.positionIdx),
      direction: normalizeDirection(position?.direction || position?.side, position?.positionIdx),
      quantity,
      canonicalKey
    };
    const current = byKey.get(canonicalKey);
    if (!current || Number(normalized.updatedAt || 0) >= Number(current.updatedAt || 0)) byKey.set(canonicalKey, normalized);
  }
  return Array.from(byKey.values());
}

function normalizePositionIdx(value) {
  const parsed = Number(value);
  return BYBIT_POSITION_INDEXES.has(parsed) ? parsed : 0;
}

function normalizeDirection(value, positionIdx = 0) {
  const normalized = normalize(value);
  if (normalized === "short" || normalized === "sell" || Number(positionIdx) === 2) return "short";
  return "long";
}

function normalizeSymbol(value) { return String(value || "").trim().toUpperCase(); }
function normalize(value) { return String(value || "").trim().toLowerCase(); }
