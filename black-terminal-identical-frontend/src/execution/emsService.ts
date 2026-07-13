import { blackCoreEventBus } from "../core/blackCore";
import type { PortfolioAccount } from "../portfolio/types";
import { evaluateOrderRisk } from "../risk/riskEngine";
import { blackCoreBrokerRouter } from "./brokerRouter";
import { auditExecutionReport, auditExecutionRequest } from "./executionAudit";
import { blackCoreOmsService } from "./omsService";
import { blackCorePositionManager } from "../positions/positionManager";
import type { ExecutionMatrixPreviewRow, ExecutionReport, ExecutionRequest, OrderRequest } from "./types";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";

export type ExecutionSubmissionContext = {
  account: PortfolioAccount;
  allocationRows?: ExecutionMatrixPreviewRow[];
};

export class EmsService {
  async submit(request: ExecutionRequest, context: ExecutionSubmissionContext): Promise<ExecutionReport> {
    const startedAt = Date.now();
    const finishRoundTrip = blackCorePerformanceMonitor.startSpan("execution.round_trip_ms", { exchange: request.exchange });

    blackCoreOmsService.transition(request.internalOrderId, "validated");
    const finishRisk = blackCorePerformanceMonitor.startSpan("execution.risk_ms", { exchange: request.exchange });
    const risk = evaluateOrderRisk(this.toOrderRequest(request), context.account, context.account.riskControls, request.referencePrice || request.limitPrice || request.stopPrice || 1);
    finishRisk();

    if (risk.status === "blocked") {
      blackCoreOmsService.transition(request.internalOrderId, "risk-rejected", { reasons: risk.reasons });
      const report = this.buildReport(request, "rejected", "risk-rejected", startedAt, risk.reasons.join(" "));
      blackCoreOmsService.applyReport(report);
      auditExecutionReport(report, request, { riskDecision: "blocked" });
      finishRoundTrip();
      return report;
    }

    blackCoreOmsService.transition(request.internalOrderId, "risk-approved");
    auditExecutionRequest(request, "risk-approved", { riskDecision: "approved" });

    if (request.destinations.includes("allocation-engine")) {
      blackCoreOmsService.transition(request.internalOrderId, "allocated", { rows: context.allocationRows?.length ?? 0 });
    }

    blackCoreOmsService.transition(request.internalOrderId, "submitted");
    const finishRouter = blackCorePerformanceMonitor.startSpan("execution.router_ms", { exchange: request.exchange });
    const route = blackCoreBrokerRouter.resolve(request);
    finishRouter();

    const finishVenue = blackCorePerformanceMonitor.startSpan("execution.venue_ms", { exchange: request.exchange });
    try {
      const update = await route.adapter.placeOrder(this.toOrderRequest(request));
      finishVenue();
      const report = this.buildReport(
        request,
        update.status,
        this.lifecycleFromOrderStatus(update.status),
        startedAt,
        update.reason,
        update.orderId,
        update.clientOrderId,
        update.filledQuantity,
        update.averageFillPrice
      );
      blackCoreOmsService.applyReport(report);
      blackCorePositionManager.ingestExecutionReport(report, request);
      auditExecutionReport(report, request, { riskDecision: "approved", allocationDecision: request.destinations.includes("allocation-engine") ? "enabled" : "not-requested" });
      blackCoreEventBus.publish("execution.event", {
        type: "portfolio.updated",
        orderId: request.internalOrderId,
        time: Date.now()
      });
      finishRoundTrip();
      return report;
    } catch (error) {
      finishVenue();
      const message = error instanceof Error ? error.message : String(error);
      const report = this.buildReport(request, "rejected", "rejected", startedAt, message);
      blackCoreOmsService.applyReport(report);
      auditExecutionReport(report, request, { riskDecision: "approved", errors: [message] });
      finishRoundTrip();
      return report;
    }
  }

  preview(request: ExecutionRequest, account: PortfolioAccount): ExecutionMatrixPreviewRow {
    const referencePrice = request.referencePrice || request.limitPrice || request.stopPrice || 1;
    const risk = evaluateOrderRisk(this.toOrderRequest(request), account, account.riskControls, referencePrice);
    const exposure = request.sizingMethod === "usd" ? request.quantity : request.quantity * referencePrice;

    return {
      accountId: account.id,
      accountName: account.accountName,
      exchange: account.exchange,
      allocationMethod: request.destinations.includes("allocation-engine") ? "personal + allocation" : "personal",
      calculatedQuantity: request.quantity,
      estimatedMargin: exposure / Math.max(1, request.leverage || account.leverage || 1),
      estimatedFees: exposure * 0.0004,
      estimatedExposure: exposure,
      riskStatus: risk.status === "approved" ? "approved" : "blocked",
      validationStatus: request.quantity > 0 ? "valid" : "invalid",
      executionStatus: "created",
      reasons: risk.reasons
    };
  }

  private toOrderRequest(request: ExecutionRequest): OrderRequest {
    return {
      accountId: request.accountId,
      exchange: request.exchange,
      symbol: request.symbol,
      marketKind: request.marketKind,
      side: request.side,
      type: request.orderType,
      quantity: request.quantity,
      sizingMethod: request.sizingMethod,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
      referencePrice: request.referencePrice,
      leverage: request.leverage,
      marginMode: request.marginMode,
      takeProfit: request.takeProfit,
      stopLoss: request.stopLoss,
      reduceOnly: request.reduceOnly,
      postOnly: request.postOnly,
      timeInForce: request.timeInForce,
      triggerBy: request.triggerBy,
      tpTriggerBy: request.tpTriggerBy,
      slTriggerBy: request.slTriggerBy,
      tpslMode: request.tpslMode,
      positionIdx: request.positionIdx,
      slippageTolerancePercent: request.slippageTolerancePercent,
      strategyParameters: request.strategyParameters,
      clientOrderId: request.internalOrderId,
      internalOrderId: request.internalOrderId,
      source: request.source,
      destinations: request.destinations
    };
  }

  private buildReport(
    request: ExecutionRequest,
    status: ExecutionReport["status"],
    lifecycleState: ExecutionReport["lifecycleState"],
    startedAt: number,
    reason?: string,
    exchangeOrderId?: string,
    clientOrderId?: string,
    filledQuantity = 0,
    averageFillPrice?: number
  ): ExecutionReport {
    return {
      internalOrderId: request.internalOrderId,
      accountId: request.accountId,
      exchange: request.exchange,
      orderId: exchangeOrderId || request.internalOrderId,
      clientOrderId,
      symbol: request.symbol,
      status,
      filledQuantity,
      averageFillPrice,
      reason,
      time: Date.now(),
      lifecycleState,
      latencyMs: Date.now() - startedAt,
      destination: request.destinations[0],
      diagnosticContext: { source: request.source, destinations: request.destinations }
    };
  }

  private lifecycleFromOrderStatus(status: ExecutionReport["status"]): ExecutionReport["lifecycleState"] {
    if (status === "pending") return "submitted";
    return status;
  }
}

export const blackCoreEmsService = new EmsService();
