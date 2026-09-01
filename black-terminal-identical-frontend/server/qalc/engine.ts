import type { QalcAuditEvent, QalcConfig, QalcDecision, QalcFeeSchedule, QalcMarketEvent, QalcPaperInventory, QalcRuntimeState, QalcTelemetry } from "./contracts.ts";
import { defaultQalcConfig } from "./contracts.ts";
import { QalcClockMonitor } from "./clock.ts";
import { QalcFeatureEngine } from "./features.ts";
import { adverseSelectionTicks, costModel, directionModel, fillModel } from "./models.ts";
import { QalcOrderBook } from "./order-book.ts";
import { QalcPaperBroker } from "./paper-broker.ts";
import { QalcRiskEngine } from "./risk.ts";
import { QalcEventSequencer } from "./sequencer.ts";

export class QalcEngine {
  readonly config: QalcConfig;
  readonly book: QalcOrderBook;
  readonly clock = new QalcClockMonitor();
  private readonly sequencer = new QalcEventSequencer();
  private readonly features: QalcFeatureEngine;
  private readonly risk: QalcRiskEngine;
  private readonly paper: QalcPaperBroker;
  private feeSchedule: QalcFeeSchedule = { makerRate: 0, takerRate: 0, source: "UNAVAILABLE", version: "unavailable" };
  private state: QalcRuntimeState = "INITIALIZING";
  private inventory?: QalcPaperInventory;
  private latestDecision?: QalcDecision;
  private audits: QalcAuditEvent[] = [];
  private counters: Record<string, number> = {};
  private actionTimes: number[] = [];
  private directionConfirmations: Array<"BUY" | "SELL"> = [];
  private tickSize: number;
  private quantityStep: number;
  private lastTradeAt = 0;
  private timingSamples: Record<string, number[]> = {};

  constructor(config: Partial<QalcConfig> = {}, instrument: { tickSize?: number; quantityStep?: number } = {}) {
    this.config = defaultQalcConfig(config);
    if (this.config.liveExecutionEnabled || this.config.groupFanoutEnabled) throw new Error("QALC_LIVE_EXECUTION_PROHIBITED");
    this.tickSize = instrument.tickSize || 0;
    this.quantityStep = instrument.quantityStep || 0;
    this.book = new QalcOrderBook(this.config.symbol);
    this.features = new QalcFeatureEngine(this.tickSize);
    this.risk = new QalcRiskEngine(this.config);
    this.paper = new QalcPaperBroker(this.config, () => this.feeSchedule);
    this.audit("ENGINE_INITIALIZED", "INFO", `QALC initialized in ${this.config.mode} mode; live execution and group fanout are disabled.`);
  }

  setFeeSchedule(schedule: QalcFeeSchedule) {
    if (!Number.isFinite(schedule.makerRate) || !Number.isFinite(schedule.takerRate) || schedule.makerRate < 0 || schedule.takerRate < 0) throw new Error("INVALID_FEE_SCHEDULE");
    this.feeSchedule = { ...schedule };
  }

  observeClock(serverTimeMs: number, requestSentAt: number, responseReceivedAt: number) { return this.clock.observe(serverTimeMs, requestSentAt, responseReceivedAt); }

  process(event: QalcMarketEvent) {
    const eventStarted = performance.now();
    const sequence = this.sequencer.accept(event);
    if (!sequence.accepted) { this.increment(sequence.duplicate ? "duplicate_events" : "rejected_events"); this.recordTiming("eventProcessing", performance.now() - eventStarted); return this.telemetry(event.receiveTimestamp); }
    this.increment("accepted_events");
    this.paper.onTime(event.receiveTimestamp);
    if (event.eventType === "BOOK_SNAPSHOT" || event.eventType === "BOOK_DELTA") {
      const bookStarted = performance.now();
      const mutation = this.book.apply(event);
      this.recordTiming("orderBook", performance.now() - bookStarted);
      if (!mutation.accepted) {
        if (!mutation.duplicate) { this.state = "BOOK_GAP"; this.audit("BOOK_MUTATION_REJECTED", "ERROR", mutation.reason || "Book mutation rejected."); }
        this.recordTiming("eventProcessing", performance.now() - eventStarted);
        return this.telemetry(event.receiveTimestamp);
      }
      const view = this.book.view(event.receiveTimestamp);
      this.paper.onBookMutation(mutation);
      const featureStarted = performance.now();
      this.features.observeBook(event, mutation, view);
      this.recordTiming("featureUpdate", performance.now() - featureStarted);
      this.markInventory(view.bids[0] && view.asks[0] ? (view.bids[0].price + view.asks[0].price) / 2 : 0);
    } else if (event.eventType === "TRADE") {
      this.lastTradeAt = event.receiveTimestamp;
      const featureStarted = performance.now();
      this.features.observeTrade(event);
      this.recordTiming("featureUpdate", performance.now() - featureStarted);
      const execution = this.paper.onTrade(event);
      if (execution) { this.inventory = this.risk.applyExecution(this.inventory, execution); this.increment("paper_fills"); this.audit("PAPER_FILL", "INFO", "Conservative queue simulation produced a Paper fill.", { orderId: execution.orderId, quantity: execution.quantity }); }
    } else if (event.eventType === "INSTRUMENT") {
      const instrument = event.payload as { tickSize?: number; quantityStep?: number };
      if (Number(instrument.tickSize) > 0) { this.tickSize = Number(instrument.tickSize); this.features.updateTickSize(this.tickSize); }
      if (Number(instrument.quantityStep) > 0) this.quantityStep = Number(instrument.quantityStep);
    }
    const decisionStarted = performance.now();
    this.evaluate(event.receiveTimestamp);
    this.recordTiming("paperDecision", performance.now() - decisionStarted);
    this.recordTiming("eventProcessing", performance.now() - eventStarted);
    return this.telemetry(event.receiveTimestamp);
  }

  telemetry(now = Date.now()): QalcTelemetry {
    const book = this.book.view(now);
    const features = this.features.snapshot(book, now);
    const clock = this.clock.status(now);
    return {
      engineId: "black-core-qalc", modelVersion: this.config.modelVersion,
      certificationState: "RESEARCH", runtimeState: this.state, book,
      clock: { state: clock.state, offsetMs: clock.offsetMs, driftMsPerMinute: clock.driftMsPerMinute, sampledAt: clock.sampledAt },
      features, decision: this.latestDecision, activeQuote: this.paper.order(), inventory: this.inventory ? { ...this.inventory } : undefined,
      risk: this.risk.state(), executions: this.paper.executionHistory().slice(-100), recentAudit: this.audits.slice(-100),
      counters: { ...this.counters }, performance: Object.fromEntries(Object.entries(this.timingSamples).map(([key, values]) => [key, timingStats(values)])), updatedAt: now,
    };
  }

  private evaluate(now: number) {
    const view = this.book.view(now);
    const features = this.features.snapshot(view, now);
    if (view.state !== "LIVE" || view.ageMs > 2_000) return this.block("DATA_STALE", "BOOK_NOT_LIVE_OR_STALE", now, features);
    if (!this.lastTradeAt || now - this.lastTradeAt > 3_000) return this.block("DATA_STALE", "PUBLIC_TRADE_STREAM_STALE", now, features);
    if (!this.clock.mayQuote(now)) return this.block("CLOCK_UNSAFE", "CLOCK_NOT_SAFE", now, features);
    if (!features?.warm) return this.block("WARMING_FEATURES", "FEATURE_WARMUP", now, features);
    if (this.feeSchedule.source === "UNAVAILABLE") return this.block("RISK_SUSPENDED", "FEE_SCHEDULE_REQUIRED", now, features);
    if (this.risk.state().suspended) return this.block("RISK_SUSPENDED", this.risk.state().reason || "RISK_SUSPENDED", now, features);
    if (this.inventory) return this.manageInventory(now, view, features);
    const active = this.paper.order();
    if (active && !["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(active.state)) {
      const directional = directionModel(features, this.config);
      const sideProbability = active.side === "BUY" ? directional.probabilityUp : directional.probabilityDown;
      const fill = fillModel(features, active.queueAheadEstimated, active.side, this.config);
      const expectedMove = active.side === "BUY" ? directional.expectedMoveTicks : -directional.expectedMoveTicks;
      const costs = costModel({ quotePrice: active.price, quantity: active.remainingQuantity, tickSize: this.tickSize, expectedMoveTicks: expectedMove, adverseSelectionTicks: adverseSelectionTicks(features, active.side), fees: this.feeSchedule, config: this.config });
      const cancelReason = features.toxicity.score > this.config.maximumToxicity ? "TOXICITY_GATE"
        : features.spreadRegime === "DISLOCATED" ? "SPREAD_DISLOCATED"
          : active.queueConfidence < 0.2 ? "QUEUE_CONFIDENCE_DETERIORATED"
            : sideProbability < 0.52 ? "DIRECTION_EDGE_INVALIDATED"
              : costs.expectedNetEdgeUsdt <= 0 ? "NET_EDGE_INVALIDATED" : undefined;
      if (cancelReason && this.paper.requestCancel(now, cancelReason)) {
        this.recordAction(now);
        this.setDecision({ time: now, action: "CANCEL", reason: cancelReason, directional, fill, costs, toxicity: features.toxicity.score });
      }
      this.state = active.state === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "QUOTE_ACTIVE";
      return;
    }
    const directional = directionModel(features, this.config);
    const side = directional.probabilityUp >= 0.58 ? "BUY" : directional.probabilityDown >= 0.58 ? "SELL" : undefined;
    if (!side) return this.noQuote(now, features, directional, "DIRECTION_CONFIDENCE_TOO_LOW");
    this.directionConfirmations.push(side);
    this.directionConfirmations = this.directionConfirmations.slice(-this.config.confirmationCount);
    if (this.directionConfirmations.length < this.config.confirmationCount || this.directionConfirmations.some((value) => value !== side)) return this.noQuote(now, features, directional, "AWAITING_DIRECTION_CONFIRMATION");
    const quotePrice = side === "BUY" ? view.bids[0].price : view.asks[0].price;
    const queueAhead = side === "BUY" ? view.bids[0].quantity : view.asks[0].quantity;
    const fill = fillModel(features, queueAhead, side, this.config);
    const adverse = adverseSelectionTicks(features, side);
    const expectedMove = side === "BUY" ? directional.expectedMoveTicks : -directional.expectedMoveTicks;
    const quantity = this.risk.size(quotePrice, this.tickSize, this.quantityStep);
    const costs = costModel({ quotePrice, quantity, tickSize: this.tickSize, expectedMoveTicks: expectedMove, adverseSelectionTicks: adverse, fees: this.feeSchedule, config: this.config });
    const direction = side === "BUY" ? 1 : -1;
    const projectedMoveTicks = Math.max(1, Math.abs(expectedMove));
    const decisionBase = {
      time: now, directional, fill, costs, toxicity: features.toxicity.score, quotePrice, quantity,
      projectedTargetPrice: quotePrice + direction * projectedMoveTicks * this.tickSize,
      invalidationPrice: quotePrice - direction * this.config.hardStopTicks * this.tickSize,
      expiresAt: now + this.config.predictionHorizonMs,
    };
    if (features.toxicity.score > this.config.maximumToxicity) return this.setDecision({ ...decisionBase, action: "NO_QUOTE", reason: "TOXICITY_GATE" });
    if (fill.beforeInvalidation < this.config.minimumFillProbability) return this.setDecision({ ...decisionBase, action: "NO_QUOTE", reason: "FILL_PROBABILITY_GATE" });
    if (costs.expectedNetEdgeUsdt <= 0 || costs.grossEdgeUsdt < costs.allInCostUsdt * this.config.minimumNetEdgeMultiplier) return this.setDecision({ ...decisionBase, action: "NO_QUOTE", reason: "NET_EDGE_GATE" });
    if (!this.actionAllowed(now)) return this.setDecision({ ...decisionBase, action: "NO_QUOTE", reason: "QUOTE_ACTION_RATE_LIMIT" });
    if (this.config.mode === "SHADOW" || this.config.mode === "RESEARCH" || this.config.mode === "REPLAY") {
      this.state = "QUOTE_CANDIDATE";
      return this.setDecision({ ...decisionBase, action: side === "BUY" ? "QUOTE_BID" : "QUOTE_ASK", reason: "SHADOW_CANDIDATE", quotePrice, quantity });
    }
    const submitted = this.paper.submit({ side, price: quotePrice, quantity, now, book: view });
    this.recordAction(now);
    if (!submitted.accepted) return this.setDecision({ ...decisionBase, action: "NO_QUOTE", reason: submitted.reason });
    this.state = "QUOTE_PENDING";
    return this.setDecision({ ...decisionBase, action: side === "BUY" ? "QUOTE_BID" : "QUOTE_ASK", reason: "PAPER_POST_ONLY_SUBMITTED", quotePrice, quantity });
  }

  private manageInventory(now: number, book: ReturnType<QalcOrderBook["view"]>, features: NonNullable<QalcTelemetry["features"]>) {
    if (!this.inventory) return;
    const mark = features.mid;
    this.markInventory(mark);
    const moveTicks = this.inventory.side === "LONG" ? (mark - this.inventory.averagePrice) / this.tickSize : (this.inventory.averagePrice - mark) / this.tickSize;
    const expired = now - this.inventory.openedAt >= this.config.maximumInventoryDurationMs;
    const hardStop = moveTicks <= -this.config.hardStopTicks;
    const toxic = features.toxicity.score >= this.config.maximumToxicity;
    const directional = directionModel(features, this.config);
    const edgeDecayed = this.inventory.side === "LONG" ? directional.probabilityUp < 0.47 : directional.probabilityDown < 0.47;
    if (!expired && !hardStop && !toxic && !edgeDecayed) { this.state = this.inventory.side === "LONG" ? "INVENTORY_LONG" : "INVENTORY_SHORT"; return; }
    const before = this.inventory;
    const execution = this.paper.executeTakerExit({ side: before.side === "LONG" ? "SELL" : "BUY", quantity: before.quantity, now, book, slippageTicks: Math.max(0.5, features.spreadTicks / 2), tickSize: this.tickSize });
    if (!execution) return this.block("EXIT_PENDING", "EXIT_BOOK_UNAVAILABLE", now, features);
    const gross = before.side === "LONG" ? (execution.price - before.averagePrice) * before.quantity : (before.averagePrice - execution.price) * before.quantity;
    const pnl = gross - before.entryFees - execution.fee;
    this.inventory = undefined;
    this.risk.recordClosed(pnl, now, toxic);
    this.state = this.risk.state().suspended ? "RISK_SUSPENDED" : "FLAT";
    this.audit("PAPER_INVENTORY_CLOSED", hardStop || toxic ? "WARN" : "INFO", hardStop ? "Hard-stop Paper exit." : toxic ? "Toxicity Paper exit." : edgeDecayed ? "Edge-decay Paper exit." : "Time-based Paper exit.", { pnl, durationMs: now - before.openedAt });
  }

  private markInventory(mark: number) {
    if (!this.inventory || !mark) return;
    this.inventory.lastMarkPrice = mark;
    const gross = this.inventory.side === "LONG" ? (mark - this.inventory.averagePrice) * this.inventory.quantity : (this.inventory.averagePrice - mark) * this.inventory.quantity;
    this.inventory.unrealizedPnl = gross - this.inventory.entryFees;
  }
  private noQuote(now: number, features: NonNullable<QalcTelemetry["features"]>, directional: ReturnType<typeof directionModel>, reason: string) {
    const fill = fillModel(features, Math.max(0.001, features.topDepth / 2), directional.probabilityUp >= 0.5 ? "BUY" : "SELL", this.config);
    const costs = costModel({ quotePrice: features.mid, quantity: 0, tickSize: this.tickSize, expectedMoveTicks: 0, adverseSelectionTicks: 0, fees: this.feeSchedule, config: this.config });
    this.state = "FLAT"; return this.setDecision({ time: now, action: "NO_QUOTE", reason, directional, fill, costs, toxicity: features.toxicity.score });
  }
  private block(state: QalcRuntimeState, reason: string, now: number, features?: QalcTelemetry["features"]) {
    if (this.state !== state) this.audit("QUOTE_GATE_BLOCKED", state === "DATA_STALE" || state === "CLOCK_UNSAFE" ? "ERROR" : "INFO", reason);
    this.state = state;
    if (features && this.latestDecision) this.latestDecision = { ...this.latestDecision, time: now, action: "NO_QUOTE", reason };
  }
  private setDecision(decision: QalcDecision) { this.latestDecision = decision; if (decision.action === "NO_QUOTE") this.increment(`gate_${decision.reason.toLowerCase()}`); }
  private actionAllowed(now: number) {
    this.actionTimes = this.actionTimes.filter((time) => time >= now - 60_000);
    return this.actionTimes.filter((time) => time >= now - 1_000).length < this.config.maximumQuoteActionsPerSecond && this.actionTimes.length < this.config.maximumQuoteActionsPerMinute;
  }
  private recordAction(now: number) { this.actionTimes.push(now); this.increment("quote_actions"); }
  private increment(key: string) { this.counters[key] = (this.counters[key] || 0) + 1; }
  private recordTiming(key: string, value: number) { const rows = this.timingSamples[key] ||= []; rows.push(value); if (rows.length > 2_048) rows.shift(); }
  private audit(type: string, severity: QalcAuditEvent["severity"], message: string, metadata?: Record<string, unknown>) { this.audits.push({ type, time: Date.now(), severity, message, metadata }); if (this.audits.length > 500) this.audits.shift(); }
}

function timingStats(values: number[]) {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) || 0 };
}
