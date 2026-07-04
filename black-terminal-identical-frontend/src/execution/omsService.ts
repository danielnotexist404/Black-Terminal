import { createId } from "../core/ids";
import { blackCoreEventBus } from "../core/blackCore";
import { blackCoreOrderSyncService } from "../orders/orderSyncService";
import { assertOrderTransition } from "./orderLifecycle";
import { lifecycleEventName } from "./executionEvents";
import type { ExecutionReport, ExecutionRequest, OrderLifecycleState, OrderUpdate } from "./types";

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
    return request;
  }

  transition(orderId: string, nextState: OrderLifecycleState, metadata?: Record<string, unknown>) {
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
    return record;
  }

  applyReport(report: ExecutionReport) {
    const record = this.requireOrder(report.internalOrderId);
    if (record.state !== report.lifecycleState) {
      this.transition(report.internalOrderId, report.lifecycleState, report.diagnosticContext);
    }
    record.reports = [report, ...record.reports];
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
}

export const blackCoreOmsService = new OmsService();
