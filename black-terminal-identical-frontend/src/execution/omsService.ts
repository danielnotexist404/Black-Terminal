import { createId } from "../core/ids";
import { blackCoreEventBus } from "../core/blackCore";
import { blackCoreOrderSyncService } from "../orders/orderSyncService";
import { assertOrderTransition } from "./orderLifecycle";
import { lifecycleEventName } from "./executionEvents";
import type { ExecutionReport, ExecutionRequest, OrderLifecycleState, OrderUpdate } from "./types";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";

const maxOmsOrders = 2000;
const maxReportsPerOrder = 50;
const terminalStates = new Set<OrderLifecycleState>(["filled", "cancelled", "rejected", "expired", "risk-rejected"]);

export type OmsOrderRecord = {
  request: ExecutionRequest;
  state: OrderLifecycleState;
  reports: ExecutionReport[];
  createdAt: number;
  updatedAt: number;
};

export class OmsService {
  private orders = new Map<string, OmsOrderRecord>();

  createOrder(draft: Omit<ExecutionRequest, "internalOrderId" | "timestamp"> & { internalOrderId?: string; timestamp?: number }) {
    const finish = blackCorePerformanceMonitor.startSpan("execution.oms_ms", { stage: "create" });
    const request: ExecutionRequest = {
      ...draft,
      internalOrderId: draft.internalOrderId ?? createId("ord"),
      timestamp: draft.timestamp ?? Date.now()
    };
    const record: OmsOrderRecord = {
      request,
      state: "created",
      reports: [],
      createdAt: request.timestamp,
      updatedAt: request.timestamp
    };
    this.orders.set(request.internalOrderId, record);
    blackCoreEventBus.publish("execution.event", {
      type: "order.created",
      orderId: request.internalOrderId,
      request,
      time: Date.now()
    });
    this.pruneOrders();
    finish();
    return request;
  }

  transition(orderId: string, nextState: OrderLifecycleState, metadata?: Record<string, unknown>) {
    const finish = blackCorePerformanceMonitor.startSpan("execution.oms_ms", { stage: "transition" });
    const record = this.requireOrder(orderId);
    assertOrderTransition(record.state, nextState);
    record.state = nextState;
    record.updatedAt = Date.now();
    blackCoreEventBus.publish("execution.event", {
      type: lifecycleEventName(nextState),
      orderId,
      request: record.request,
      time: record.updatedAt,
      metadata
    });
    finish();
    return record;
  }

  applyReport(report: ExecutionReport) {
    const record = this.requireOrder(report.internalOrderId);
    if (record.state !== report.lifecycleState) {
      this.transition(report.internalOrderId, report.lifecycleState, report.diagnosticContext);
    }
    record.reports = [report, ...record.reports].slice(0, maxReportsPerOrder);
    record.updatedAt = Date.now();
    blackCoreOrderSyncService.upsert(report as OrderUpdate);
    blackCoreEventBus.publish("execution.event", {
      type: lifecycleEventName(report.lifecycleState),
      orderId: report.internalOrderId,
      report,
      time: record.updatedAt
    });
    return record;
  }

  getOrder(orderId: string) {
    return this.orders.get(orderId) ?? null;
  }

  listOrders() {
    return Array.from(this.orders.values());
  }

  private requireOrder(orderId: string) {
    const record = this.orders.get(orderId);
    if (!record) throw new Error(`OMS order not found: ${orderId}`);
    return record;
  }

  private pruneOrders() {
    if (this.orders.size <= maxOmsOrders) return;
    const removable = [...this.orders.entries()]
      .filter(([, record]) => terminalStates.has(record.state))
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [orderId] of removable) {
      if (this.orders.size <= maxOmsOrders) break;
      this.orders.delete(orderId);
    }
  }
}

export const blackCoreOmsService = new OmsService();
