import type { OrderUpdate } from "../execution/types";
import type { PortfolioSnapshot } from "../portfolio/types";
import { canonicalOrderKey, deduplicateCanonicalOrders, shouldReplaceCanonicalOrder } from "./canonicalOrder";

export type OrderBucket = "open" | "working" | "filled" | "cancelled" | "rejected" | "partial";

export class OrderSyncService {
  private orders = new Map<string, OrderUpdate>();
  private listeners = new Set<(orders: OrderUpdate[]) => void>();
  private diagnostics = { rawRecords: 0, uniqueOrders: 0, duplicatesSuppressed: 0, staleUpdatesSuppressed: 0 };

  upsert(order: OrderUpdate) {
    const key = canonicalOrderKey(order);
    const current = this.orders.get(key);
    this.diagnostics.rawRecords += 1;
    if (current) this.diagnostics.duplicatesSuppressed += 1;
    if (shouldReplaceCanonicalOrder(current, order)) this.orders.set(key, { ...order, canonicalKey: key });
    else this.diagnostics.staleUpdatesSuppressed += 1;
    this.emit();
  }

  replaceAccountSnapshots(orders: OrderUpdate[], health: PortfolioSnapshot["orderSync"] = {}) {
    const incomingByAccount = new Map<string, OrderUpdate[]>();
    const nextDiagnostics = { rawRecords: 0, uniqueOrders: 0, duplicatesSuppressed: 0, staleUpdatesSuppressed: 0 };
    for (const order of orders) {
      const accountOrders = incomingByAccount.get(order.accountId) || [];
      accountOrders.push(order);
      incomingByAccount.set(order.accountId, accountOrders);
    }

    const accountIds = new Set([...Object.keys(health || {}), ...incomingByAccount.keys()]);
    for (const accountId of accountIds) {
      const accountHealth = health?.[accountId];
      if (accountHealth && !accountHealth.verified && (incomingByAccount.get(accountId)?.length || 0) === 0) continue;
      for (const [key, order] of this.orders) {
        if (order.accountId === accountId) this.orders.delete(key);
      }
      const deduplicated = deduplicateCanonicalOrders(incomingByAccount.get(accountId) || []);
      nextDiagnostics.rawRecords += deduplicated.diagnostics.rawRecords;
      nextDiagnostics.uniqueOrders += deduplicated.diagnostics.uniqueOrders;
      nextDiagnostics.duplicatesSuppressed += deduplicated.diagnostics.duplicatesSuppressed;
      nextDiagnostics.staleUpdatesSuppressed += deduplicated.diagnostics.staleUpdatesSuppressed;
      for (const order of deduplicated.orders) {
        const key = canonicalOrderKey(order);
        this.orders.set(key, { ...order, canonicalKey: key });
      }
    }
    this.diagnostics = nextDiagnostics;
    this.emit();
    return this.list("open");
  }

  subscribe(listener: (orders: OrderUpdate[]) => void) {
    this.listeners.add(listener);
    listener(this.list("open"));
    return () => { this.listeners.delete(listener); };
  }

  list(bucket?: OrderBucket) {
    const orders = Array.from(this.orders.values());
    if (!bucket) return orders;
    return orders.filter((order) => {
      if (bucket === "open") return ["pending", "accepted", "working", "partially-filled"].includes(order.status);
      if (bucket === "working") return ["accepted", "working"].includes(order.status);
      if (bucket === "filled") return order.status === "filled";
      if (bucket === "cancelled") return order.status === "cancelled";
      if (bucket === "rejected") return order.status === "rejected";
      return order.status === "partially-filled";
    });
  }

  getDiagnostics() {
    return { ...this.diagnostics, uniqueOrders: this.orders.size };
  }

  private emit() {
    const active = this.list("open");
    for (const listener of this.listeners) listener(active);
  }
}

export const blackCoreOrderSyncService = new OrderSyncService();
