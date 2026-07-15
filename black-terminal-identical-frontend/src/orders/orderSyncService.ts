import type { OrderUpdate } from "../execution/types";
import type { PortfolioSnapshot } from "../portfolio/types";

export type OrderBucket = "open" | "working" | "filled" | "cancelled" | "rejected" | "partial";

export class OrderSyncService {
  private orders = new Map<string, OrderUpdate>();
  private listeners = new Set<(orders: OrderUpdate[]) => void>();

  upsert(order: OrderUpdate) {
    this.orders.set(orderIdentity(order), order);
    this.emit();
  }

  replaceAccountSnapshots(orders: OrderUpdate[], health: PortfolioSnapshot["orderSync"] = {}) {
    const incomingByAccount = new Map<string, OrderUpdate[]>();
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
      for (const order of incomingByAccount.get(accountId) || []) {
        this.orders.set(orderIdentity(order), order);
      }
    }
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

  private emit() {
    const active = this.list("open");
    for (const listener of this.listeners) listener(active);
  }
}

function orderIdentity(order: OrderUpdate) {
  return `${order.accountId}:${order.network || "mainnet"}:${order.category || "unknown"}:${order.venueOrderId || order.orderId}`;
}

export const blackCoreOrderSyncService = new OrderSyncService();
