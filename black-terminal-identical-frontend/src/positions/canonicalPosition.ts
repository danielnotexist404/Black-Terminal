import type { PortfolioPosition } from "./types";

export type CanonicalPositionDiagnostics = {
  duplicatesDiscarded: number;
  staleUpdatesDiscarded: number;
};

export function canonicalPositionKey(position: PortfolioPosition) {
  const network = normalize(position.network || "mainnet");
  const account = normalize(position.accountId);
  const exchange = normalize(position.exchange || "unknown");
  const category = normalize(position.category || position.marketKind || "linear");
  const symbol = normalize(position.symbol);
  const positionIdx = Number.isInteger(position.positionIdx) ? position.positionIdx : 0;
  const direction = normalize(position.direction);
  return `${network}:${account}:${exchange}:${category}:${symbol}:${positionIdx}:${direction}`;
}

export function positionVersion(position: PortfolioPosition) {
  const updatedAt = Number(position.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  return Number(position.openedAt) || 0;
}

export function shouldReplaceCanonicalPosition(current: PortfolioPosition, incoming: PortfolioPosition) {
  const currentVersion = positionVersion(current);
  const incomingVersion = positionVersion(incoming);
  if (incomingVersion !== currentVersion) return incomingVersion > currentVersion;
  return positionFingerprint(incoming) !== positionFingerprint(current);
}

export function deduplicateCanonicalPositions(positions: PortfolioPosition[]) {
  const byKey = new Map<string, PortfolioPosition>();
  let duplicatesDiscarded = 0;
  let staleUpdatesDiscarded = 0;
  for (const position of positions) {
    if (!Number.isFinite(position.quantity) || position.quantity <= 0) continue;
    const key = canonicalPositionKey(position);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, position);
      continue;
    }
    duplicatesDiscarded += 1;
    if (shouldReplaceCanonicalPosition(current, position)) byKey.set(key, position);
    else staleUpdatesDiscarded += 1;
  }
  return {
    positions: Array.from(byKey.values()),
    diagnostics: { duplicatesDiscarded, staleUpdatesDiscarded } satisfies CanonicalPositionDiagnostics
  };
}

export function reconcileAuthoritativePositions(current: PortfolioPosition[], incoming: PortfolioPosition[]) {
  const currentByKey = new Map(current.map((position) => [canonicalPositionKey(position), position]));
  const deduplicated = deduplicateCanonicalPositions(incoming);
  const positions = deduplicated.positions.map((position) => {
    const key = canonicalPositionKey(position);
    const existing = currentByKey.get(key);
    if (!existing) return position;
    if (!shouldReplaceCanonicalPosition(existing, position)) return existing;
    return { ...existing, ...position, id: existing.id };
  });
  return { positions, diagnostics: deduplicated.diagnostics };
}

function positionFingerprint(position: PortfolioPosition) {
  return [
    position.quantity,
    position.averagePrice,
    position.currentPrice,
    position.unrealizedPnl,
    position.realizedPnl,
    position.margin,
    position.leverage,
    position.liquidationPrice ?? "",
    position.stopLoss ?? "",
    position.takeProfit ?? ""
  ].join("|");
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}
