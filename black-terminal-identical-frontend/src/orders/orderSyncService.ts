import type { OrderUpdate } from "../execution/types";

export type OrderBucket = "open" | "working" | "filled" | "cancelled" | "rejected" | "partial";

export class OrderSyncService {
  private orders = new Map<string, OrderUpdate>();

  upsert(order: OrderUpdate) {
    this.orders.set(order.orderId, order);
  }

  list(bucket?: OrderBucket) {
    const orders = Array.from(this.orders.values());
    if (!bucket) return orders;
    return orders.filter((order) => {
      if (bucket === "open") return ["pending", "accepted"].includes(order.status);
      if (bucket === "working") return order.status === "accepted";
      if (bucket === "filled") return order.status === "filled";
      if (bucket === "cancelled") return order.status === "cancelled";
      if (bucket === "rejected") return order.status === "rejected";
      return order.status === "partially-filled";
    });
  }
}

export const blackCoreOrderSyncService = new OrderSyncService();
