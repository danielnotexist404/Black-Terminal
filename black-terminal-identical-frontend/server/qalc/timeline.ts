import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  QalcMarketEvent,
  QalcPaperInventory,
  QalcPaperOrder,
  QalcSymbol,
  QalcTelemetry,
} from "./contracts.ts";
import { writeAtomic } from "./archive.ts";

export type QalcChartEventKind =
  | "CANDIDATE_LONG"
  | "CANDIDATE_SHORT"
  | "REJECTED"
  | "QUOTE_BID"
  | "QUOTE_ASK"
  | "QUOTE_CANCELLED"
  | "QUOTE_EXPIRED"
  | "PARTIAL_FILL"
  | "ENTRY_LONG"
  | "ENTRY_SHORT"
  | "EXIT_LONG"
  | "EXIT_SHORT";

export type QalcChartEvent = {
  schemaVersion: 1;
  id: string;
  engineId: "black-core-qalc";
  strategyId: string;
  runId: string;
  modelVersion: string;
  venue: "BYBIT";
  category: "linear";
  symbol: QalcSymbol;
  kind: QalcChartEventKind;
  eventTime: number;
  receiveTime: number;
  price: number;
  quantity: number;
  side?: "BUY" | "SELL";
  direction?: "LONG" | "SHORT";
  reason: string;
  sourceEventId: string;
  decisionId?: string;
  orderId?: string;
  fillId?: string;
  positionCycleId?: string;
  origin: "RESEARCH" | "REPLAY" | "PAPER" | "SHADOW";
  certificationState: QalcTelemetry["certificationState"];
  metrics: {
    probabilityUp?: number;
    probabilityDown?: number;
    expectedMoveTicks?: number;
    expectedNetEdgeUsdt?: number;
    allInCostUsdt?: number;
    fillProbability?: number;
    toxicity?: number;
    queueAhead?: number;
    queueConfidence?: number;
    feeSource?: string;
  };
};

export type QalcTimelineDocument = {
  schemaVersion: 1;
  updatedAt: number;
  coverage: {
    firstEventAt?: number;
    lastEventAt?: number;
    complete: false;
    source: "RECORDED_QALC_EVENT_TIME";
  };
  events: QalcChartEvent[];
};

type ProjectorOptions = {
  strategyId: string;
  runId: string;
  modelVersion: string;
  symbol: QalcSymbol;
  origin: QalcChartEvent["origin"];
  candidateCooldownMs?: number;
};

export class QalcTimelineProjector {
  private readonly options: ProjectorOptions;
  private readonly seen = new Set<string>();
  private pending: QalcChartEvent[] = [];
  private lastCandidate?: { signature: string; at: number };
  private lastRejected?: { reason: string; at: number };
  private lastOrder?: QalcPaperOrder;
  private lastInventory?: QalcPaperInventory;
  private positionCycleId?: string;
  private certificationState: QalcTelemetry["certificationState"] = "RESEARCH";

  constructor(options: ProjectorOptions, existing: readonly QalcChartEvent[] = []) {
    this.options = options;
    for (const event of existing) this.seen.add(event.id);
  }

  observe(source: QalcMarketEvent, telemetry: QalcTelemetry) {
    this.certificationState = telemetry.certificationState;
    const decision = telemetry.decision;
    const eventTime = source.exchangeTimestamp;
    const receiveTime = source.receiveTimestamp;
    const metrics = () => ({
      probabilityUp: decision?.directional.probabilityUp,
      probabilityDown: decision?.directional.probabilityDown,
      expectedMoveTicks: decision?.directional.expectedMoveTicks,
      expectedNetEdgeUsdt: decision?.costs.expectedNetEdgeUsdt,
      allInCostUsdt: decision?.costs.allInCostUsdt,
      fillProbability: decision?.fill.beforeInvalidation,
      toxicity: decision?.toxicity ?? telemetry.features?.toxicity.score,
      queueAhead: telemetry.activeQuote?.queueAheadEstimated,
      queueConfidence: telemetry.activeQuote?.queueConfidence,
      feeSource: decision?.costs.feeSource,
    });

    if (decision?.action === "QUOTE_BID" || decision?.action === "QUOTE_ASK") {
      const side = decision.action === "QUOTE_BID" ? "BUY" : "SELL";
      const signature = `${side}:${decision.reason}:${roundPrice(decision.quotePrice)}`;
      const cooldown = Math.max(250, this.options.candidateCooldownMs ?? 500);
      if (decision.reason === "SHADOW_CANDIDATE" && (!this.lastCandidate || this.lastCandidate.signature !== signature || receiveTime - this.lastCandidate.at >= cooldown)) {
        const decisionId = identity("decision", this.options.runId, source.id, decision.action, decision.reason);
        this.emit({
          kind: side === "BUY" ? "CANDIDATE_LONG" : "CANDIDATE_SHORT",
          eventTime, receiveTime, price: decision.quotePrice || telemetry.features?.mid || 0,
          quantity: decision.quantity || 0, side, direction: side === "BUY" ? "LONG" : "SHORT",
          reason: decision.reason, sourceEventId: source.id, decisionId, metrics: metrics(),
        });
        this.lastCandidate = { signature, at: receiveTime };
      }
    } else if (decision?.action === "NO_QUOTE" && decision.reason && (
      !this.lastRejected || this.lastRejected.reason !== decision.reason || receiveTime - this.lastRejected.at >= 5_000
    )) {
      this.emit({
        kind: "REJECTED", eventTime, receiveTime, price: telemetry.features?.mid || 0, quantity: 0,
        reason: decision.reason, sourceEventId: source.id,
        decisionId: identity("decision", this.options.runId, source.id, decision.action, decision.reason), metrics: metrics(),
      });
      this.lastRejected = { reason: decision.reason, at: receiveTime };
    }

    const order = telemetry.activeQuote;
    if (order && (!this.lastOrder || order.id !== this.lastOrder.id)) {
      this.emit({
        kind: order.side === "BUY" ? "QUOTE_BID" : "QUOTE_ASK", eventTime, receiveTime,
        price: order.price, quantity: order.quantity, side: order.side,
        direction: order.side === "BUY" ? "LONG" : "SHORT", reason: decision?.reason || "PAPER_POST_ONLY_SUBMITTED",
        sourceEventId: source.id, orderId: order.id, decisionId: decision ? identity("decision", this.options.runId, source.id, decision.action, decision.reason) : undefined,
        metrics: { ...metrics(), queueAhead: order.queueAheadEstimated, queueConfidence: order.queueConfidence },
      });
    }
    if (order && this.lastOrder?.id === order.id && order.state !== this.lastOrder.state && (order.state === "CANCELLED" || order.state === "EXPIRED")) {
      this.emit({
        kind: order.state === "EXPIRED" ? "QUOTE_EXPIRED" : "QUOTE_CANCELLED", eventTime, receiveTime,
        price: order.price, quantity: order.remainingQuantity, side: order.side,
        direction: order.side === "BUY" ? "LONG" : "SHORT", reason: order.cancelReason || order.state,
        sourceEventId: source.id, orderId: order.id, metrics: metrics(),
      });
    }

    const previousExecutions = new Set(this.lastExecutionIds);
    for (const execution of telemetry.executions) {
      if (previousExecutions.has(execution.id)) continue;
      this.lastExecutionIds.push(execution.id);
      if (execution.maker) {
        const firstFill = !this.positionCycleId;
        if (firstFill) this.positionCycleId = identity("cycle", this.options.runId, execution.id);
        this.emit({
          kind: firstFill ? (execution.side === "BUY" ? "ENTRY_LONG" : "ENTRY_SHORT") : "PARTIAL_FILL",
          eventTime: execution.time, receiveTime, price: execution.price, quantity: execution.quantity,
          side: execution.side, direction: execution.side === "BUY" ? "LONG" : "SHORT",
          reason: firstFill ? "PAPER_QUEUE_FILL_ENTRY" : "PAPER_QUEUE_PARTIAL_FILL", sourceEventId: source.id,
          orderId: execution.orderId, fillId: execution.id, positionCycleId: this.positionCycleId, metrics: metrics(),
        });
      } else {
        const closingSide = this.lastInventory?.side || (execution.side === "SELL" ? "LONG" : "SHORT");
        this.emit({
          kind: closingSide === "LONG" ? "EXIT_LONG" : "EXIT_SHORT", eventTime: execution.time, receiveTime,
          price: execution.price, quantity: execution.quantity, side: execution.side, direction: closingSide,
          reason: latestExitReason(telemetry), sourceEventId: source.id, orderId: execution.orderId,
          fillId: execution.id, positionCycleId: this.positionCycleId, metrics: metrics(),
        });
        this.positionCycleId = undefined;
      }
    }
    if (this.lastExecutionIds.length > 2_000) this.lastExecutionIds.splice(0, this.lastExecutionIds.length - 2_000);
    this.lastOrder = order ? { ...order } : undefined;
    this.lastInventory = telemetry.inventory ? { ...telemetry.inventory } : undefined;
  }

  private readonly lastExecutionIds: string[] = [];

  drain() {
    const rows = this.pending;
    this.pending = [];
    return rows;
  }

  pendingEvents() {
    return this.pending.map((event) => ({ ...event, metrics: { ...event.metrics } }));
  }

  acknowledge(ids: readonly string[]) {
    if (!ids.length) return;
    const acknowledged = new Set(ids);
    this.pending = this.pending.filter((event) => !acknowledged.has(event.id));
  }

  private emit(input: Omit<QalcChartEvent, "schemaVersion" | "id" | "engineId" | "strategyId" | "runId" | "modelVersion" | "venue" | "category" | "symbol" | "origin" | "certificationState">) {
    const id = identity("chart", this.options.runId, input.kind, input.sourceEventId, input.orderId || "", input.fillId || "", String(input.eventTime));
    if (this.seen.has(id) || !Number.isFinite(input.price) || input.price <= 0) return;
    this.seen.add(id);
    this.pending.push({
      schemaVersion: 1, id, engineId: "black-core-qalc", strategyId: this.options.strategyId,
      runId: this.options.runId, modelVersion: this.options.modelVersion, venue: "BYBIT", category: "linear",
      symbol: this.options.symbol, origin: this.options.origin, certificationState: this.certificationState, ...input,
    });
  }
}

export class QalcTimelineStore {
  private document: QalcTimelineDocument = emptyTimeline();
  private readonly path: string;
  private readonly maximumEvents: number;
  constructor(path: string, maximumEvents = 25_000) { this.path = path; this.maximumEvents = maximumEvents; }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as QalcTimelineDocument;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.events)) this.document = parsed;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.snapshot();
  }

  async append(events: readonly QalcChartEvent[]) {
    if (!events.length) return false;
    const rows = new Map(this.document.events.map((event) => [event.id, event]));
    for (const event of events) rows.set(event.id, event);
    const ordered = [...rows.values()].sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id)).slice(-this.maximumEvents);
    this.document = {
      schemaVersion: 1, updatedAt: Date.now(),
      coverage: {
        firstEventAt: ordered[0]?.eventTime,
        lastEventAt: ordered.at(-1)?.eventTime,
        complete: false,
        source: "RECORDED_QALC_EVENT_TIME",
      },
      events: ordered,
    };
    await writeAtomic(this.path, JSON.stringify(this.document));
    return true;
  }

  snapshot(): QalcTimelineDocument {
    return { ...this.document, coverage: { ...this.document.coverage }, events: this.document.events.map((event) => ({ ...event, metrics: { ...event.metrics } })) };
  }
}

export function emptyTimeline(): QalcTimelineDocument {
  return { schemaVersion: 1, updatedAt: 0, coverage: { complete: false, source: "RECORDED_QALC_EVENT_TIME" }, events: [] };
}

function identity(...parts: string[]) {
  return `qalc-${createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32)}`;
}
function roundPrice(value?: number) { return Number.isFinite(value) ? Number(value).toFixed(8) : "0"; }
function latestExitReason(telemetry: QalcTelemetry) {
  return [...telemetry.recentAudit].reverse().find((event) => event.type === "PAPER_INVENTORY_CLOSED")?.message || "PAPER_INVENTORY_EXIT";
}
