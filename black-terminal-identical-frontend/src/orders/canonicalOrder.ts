import type { OrderUpdate } from "../execution/types";

export type CanonicalOrderDiagnostics = {
  rawRecords: number;
  uniqueOrders: number;
  duplicatesSuppressed: number;
  staleUpdatesSuppressed: number;
};

export function canonicalOrderKey(order: OrderUpdate) {
  const connectionId = order.connectionId || order.accountId;
  const venue = order.exchange || "unknown";
  const category = order.category || "unknown";
  const venueOrderId = order.venueOrderId || order.orderId;
  return `${order.network || "mainnet"}:${connectionId}:${venue}:${category}:${venueOrderId}`;
}

export function orderVersion(order: OrderUpdate) {
  return Number(order.venueUpdatedTime || order.updatedTime || order.time || order.createdTime || 0);
}

export function shouldReplaceCanonicalOrder(current: OrderUpdate | undefined, incoming: OrderUpdate) {
  if (!current) return true;
  const incomingVersion = orderVersion(incoming);
  const currentVersion = orderVersion(current);
  if (incomingVersion !== currentVersion) return incomingVersion > currentVersion;
  return lifecycleRank(incoming.status) >= lifecycleRank(current.status);
}

export function deduplicateCanonicalOrders(orders: OrderUpdate[]) {
  const canonical = new Map<string, OrderUpdate>();
  let duplicatesSuppressed = 0;
  let staleUpdatesSuppressed = 0;
  for (const order of orders) {
    const key = canonicalOrderKey(order);
    const current = canonical.get(key);
    if (current) duplicatesSuppressed += 1;
    if (shouldReplaceCanonicalOrder(current, order)) canonical.set(key, order);
    else if (current) staleUpdatesSuppressed += 1;
  }
  return {
    orders: Array.from(canonical.values()),
    diagnostics: {
      rawRecords: orders.length,
      uniqueOrders: canonical.size,
      duplicatesSuppressed,
      staleUpdatesSuppressed
    } satisfies CanonicalOrderDiagnostics
  };
}

export function reconcileCanonicalOrderSnapshot(currentOrders: OrderUpdate[], incomingOrders: OrderUpdate[], authoritative: boolean) {
  const deduplicated = deduplicateCanonicalOrders(incomingOrders);
  const next = new Map<string, OrderUpdate>();
  if (!authoritative) {
    for (const current of currentOrders) next.set(canonicalOrderKey(current), current);
  }
  let duplicatesSuppressed = deduplicated.diagnostics.duplicatesSuppressed;
  let staleUpdatesSuppressed = deduplicated.diagnostics.staleUpdatesSuppressed;
  for (const order of deduplicated.orders) {
    const key = canonicalOrderKey(order);
    const current = next.get(key);
    if (current) duplicatesSuppressed += 1;
    if (shouldReplaceCanonicalOrder(current, order)) next.set(key, { ...order, canonicalKey: key });
    else if (current) staleUpdatesSuppressed += 1;
  }
  return {
    orders: Array.from(next.values()),
    diagnostics: {
      rawRecords: incomingOrders.length,
      uniqueOrders: next.size,
      duplicatesSuppressed,
      staleUpdatesSuppressed
    } satisfies CanonicalOrderDiagnostics
  };
}

export function retainOrdersForAccounts(orders: OrderUpdate[], accountIds: string[]) {
  const activeAccounts = new Set(accountIds);
  return orders.filter((order) => activeAccounts.has(order.accountId));
}

function lifecycleRank(status: OrderUpdate["status"]) {
  return {
    pending: 0,
    accepted: 1,
    working: 2,
    "partially-filled": 3,
    filled: 4,
    cancelled: 4,
    rejected: 4,
    expired: 4
  }[status] ?? 0;
}
