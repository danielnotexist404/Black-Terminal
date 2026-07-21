import type { ExecutionReport, ExecutionRequest, OrderLifecycleState } from "./types";

export type ExecutionEvent =
  | {
      type:
        | "order.created"
        | "order.validated"
        | "order.riskPassed"
        | "order.riskRejected"
        | "order.allocated"
        | "order.submitted"
        | "order.accepted"
        | "order.working"
        | "order.partiallyFilled"
        | "order.filled"
        | "order.cancelled"
        | "order.rejected"
        | "order.expired";
      orderId: string;
      request?: ExecutionRequest;
      report?: ExecutionReport;
      time: number;
      message?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "portfolio.updated" | "position.opened" | "position.closed";
      orderId?: string;
      time: number;
      message?: string;
      metadata?: Record<string, unknown>;
    };

export function lifecycleEventName(state: OrderLifecycleState): ExecutionEvent["type"] {
  if (state === "risk-approved") return "order.riskPassed";
  if (state === "risk-rejected") return "order.riskRejected";
  if (state === "partially-filled") return "order.partiallyFilled";
  return `order.${state}` as ExecutionEvent["type"];
}
