import type { OrderLifecycleState } from "./types";

const allowedTransitions: Record<OrderLifecycleState, OrderLifecycleState[]> = {
  created: ["validated", "rejected", "archived"],
  validated: ["risk-approved", "risk-rejected", "rejected"],
  "risk-approved": ["allocated", "submitted", "rejected"],
  "risk-rejected": ["rejected", "archived"],
  allocated: ["submitted", "rejected"],
  submitted: ["accepted", "working", "rejected", "expired"],
  accepted: ["working", "partially-filled", "filled", "cancelled", "expired", "rejected"],
  working: ["partially-filled", "filled", "cancelled", "expired", "rejected"],
  "partially-filled": ["filled", "cancelled", "expired", "rejected"],
  filled: ["archived"],
  cancelled: ["archived"],
  rejected: ["archived"],
  expired: ["archived"],
  archived: []
};

export function canTransitionOrder(from: OrderLifecycleState, to: OrderLifecycleState) {
  return allowedTransitions[from]?.includes(to) ?? false;
}

export function assertOrderTransition(from: OrderLifecycleState, to: OrderLifecycleState) {
  if (!canTransitionOrder(from, to)) {
    throw new Error(`Invalid order lifecycle transition: ${from} -> ${to}`);
  }
}
