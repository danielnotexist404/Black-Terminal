import type { QalcMarketEvent, QalcTelemetry } from "../../../../server/qalc/contracts.ts";
import { normalizeLocalBybitMessage } from "../../../../server/qalc/bybit-browser-normalizer.ts";
import { QalcEngine } from "../../../../server/qalc/engine.ts";
import { stableQalcId } from "../../../../server/qalc/stable-id.ts";
import { getLocalDocument, listLocalDocuments, putLocalDocument } from "../../../core/local-runtime/localDocumentStore";
import { getLocalBybitInstrumentRules, sampleLocalBybitClock } from "../../../core/local-runtime/localBybitClient";
import type { QalcChartEvent, QalcRuntimeStatus, QalcSavedStrategy, QalcTimelineResponse } from "./qalcApi";

const STRATEGY_NAMESPACE = "qalc-strategies";
const STATUS_NAMESPACE = "qalc-runtime-status";
const TIMELINE_NAMESPACE = "qalc-timeline";
const SOURCE = "LOCAL_DEVICE_QALC_EVENT_ENGINE";
const MAX_TIMELINE_EVENTS = 5_000;
const PUBLIC_SOCKET = "wss://stream.bybit.com/v5/public/linear";

let activeRuntime: LocalQalcRuntime | null = null;
let hydratedStatus: QalcRuntimeStatus | null = null;

export async function restoreActiveLocalQalcRuntime() {
  const documents = await listLocalDocuments<QalcSavedStrategy>(STRATEGY_NAMESPACE);
  const active = documents
    .filter((document) => document.value.desired_state === "ACTIVE")
    .sort((left, right) => right.value.updated_at.localeCompare(left.value.updated_at));
  if (!active.length) return;
  for (const duplicate of active.slice(1)) {
    const paused = { ...duplicate.value, desired_state: "PAUSED" as const, revision: duplicate.value.revision + 1, updated_at: new Date().toISOString() };
    await putLocalDocument(STRATEGY_NAMESPACE, duplicate.key, paused, duplicate.revision);
  }
  await activateLocalQalcRuntime(active[0].value);
}

export async function activateLocalQalcRuntime(strategy: QalcSavedStrategy) {
  if (activeRuntime?.strategyId === strategy.id) return;
  await activeRuntime?.stop("REPLACED");
  const runtime = new LocalQalcRuntime(strategy);
  activeRuntime = runtime;
  try {
    await runtime.start();
  } catch (cause) {
    if (activeRuntime === runtime) activeRuntime = null;
    await runtime.stop("STOPPED").catch(() => undefined);
    throw cause;
  }
}

export async function stopLocalQalcRuntime(strategyId: string, state: "PAUSED" | "STOPPED") {
  if (activeRuntime?.strategyId === strategyId) {
    const runtime = activeRuntime;
    activeRuntime = null;
    await runtime.stop(state);
    return;
  }
  hydratedStatus = stoppedStatus(state);
  await persistStatus(strategyId, hydratedStatus);
}

export async function getLocalQalcRuntimeStatus(): Promise<QalcRuntimeStatus> {
  if (activeRuntime) return activeRuntime.status();
  if (hydratedStatus) return structuredClone(hydratedStatus);
  const documents = await listLocalDocuments<QalcRuntimeStatus>(STATUS_NAMESPACE);
  const latest = documents.sort((left, right) => Number(right.value.updatedAt || 0) - Number(left.value.updatedAt || 0))[0]?.value;
  hydratedStatus = latest ? { ...latest, available: false, runtimeState: "STOPPED", source: SOURCE, updatedAt: Date.now() } : stoppedStatus("STOPPED");
  return structuredClone(hydratedStatus);
}

export async function getLocalQalcTimeline(params: { symbol: string; from?: number; to?: number; runId?: string; limit?: number }): Promise<QalcTimelineResponse> {
  const documents = await listLocalDocuments<QalcChartEvent[]>(TIMELINE_NAMESPACE);
  const limit = Math.max(1, Math.min(5_000, Math.trunc(params.limit || 1_000)));
  const events = documents
    .flatMap((document) => Array.isArray(document.value) ? document.value : [])
    .filter((event) => event.symbol === params.symbol.toUpperCase())
    .filter((event) => !params.runId || event.runId === params.runId)
    .filter((event) => !Number.isFinite(params.from) || event.eventTime >= Number(params.from))
    .filter((event) => !Number.isFinite(params.to) || event.eventTime <= Number(params.to))
    .sort((left, right) => left.eventTime - right.eventTime)
    .slice(-limit);
  return {
    available: events.length > 0,
    source: "LOCAL_QALC_TIMELINE",
    updatedAt: Date.now(),
    coverage: {
      firstEventAt: events[0]?.eventTime,
      lastEventAt: events.at(-1)?.eventTime,
      complete: false,
      source: "RECORDED_QALC_EVENT_TIME",
    },
    events,
    reason: events.length ? undefined : "No local QALC events have been recorded for this market and range.",
  };
}

class LocalQalcRuntime {
  readonly strategyId: string;
  private readonly strategy: QalcSavedStrategy;
  private readonly runId: string;
  private engine: QalcEngine | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private generation = 0;
  private reconnects = 0;
  private reconnectTimer?: number;
  private pingTimer?: number;
  private watchdogTimer?: number;
  private clockTimer?: number;
  private persistTimer?: number;
  private persisting: Promise<void> = Promise.resolve();
  private processing: Promise<void> = Promise.resolve();
  private lastMessageAt = 0;
  private lastStatus: QalcRuntimeStatus;
  private timeline: QalcChartEvent[] = [];
  private seenExecutions = new Set<string>();
  private priorQuote?: NonNullable<QalcTelemetry["activeQuote"]>;
  private lastCandidate?: { side: "BUY" | "SELL"; at: number };
  private lastRejected?: { reason: string; at: number };

  constructor(strategy: QalcSavedStrategy) {
    this.strategy = structuredClone(strategy);
    this.strategyId = strategy.id;
    this.runId = `local-${strategy.id}-${Date.now()}`;
    this.lastStatus = {
      available: false,
      source: SOURCE,
      certificationState: "RESEARCH",
      runtimeState: "INITIALIZING",
      updatedAt: Date.now(),
      clock: { state: "UNAVAILABLE", offsetMs: 0, driftMsPerMinute: 0 },
      recentAudit: [{ type: "LOCAL_QALC_INITIALIZING", time: Date.now(), severity: "INFO", message: "Loading native Bybit instrument rules and the local Paper event engine." }],
    };
  }

  async start() {
    const existingTimeline = await getLocalDocument<QalcChartEvent[]>(TIMELINE_NAMESPACE, this.strategyId);
    this.timeline = Array.isArray(existingTimeline?.value) ? existingTimeline.value.slice(-MAX_TIMELINE_EVENTS) : [];
    try {
      const rules = await getLocalBybitInstrumentRules("MAINNET", this.strategy.symbol);
      const tickSize = positive(rules.tickSize, "tick size");
      const quantityStep = positive(rules.quantityStep, "quantity step");
      const allocatedEquity = this.strategy.paper_equity * this.strategy.strategy_allocation_percent / 100;
      this.engine = new QalcEngine({
        strategyId: this.strategy.id,
        runId: this.runId,
        symbol: this.strategy.symbol,
        mode: "PAPER",
        paperEnabled: true,
        shadowEnabled: false,
        liveExecutionEnabled: false,
        groupFanoutEnabled: false,
        predictionHorizonMs: this.strategy.config.predictionHorizonMs as 250 | 500 | 1000 | 3000 | 5000 | 10000,
        quoteLifetimeMs: this.strategy.config.quoteLifetimeMs,
        minimumNetEdgeMultiplier: this.strategy.config.minimumNetEdgeMultiplier,
        minimumFillProbability: this.strategy.config.minimumFillProbability,
        maximumToxicity: this.strategy.config.maximumToxicity,
        maximumQuoteActionsPerSecond: this.strategy.config.maximumQuoteActionsPerSecond,
        maximumQuoteActionsPerMinute: Math.max(1, this.strategy.config.maximumQuoteActionsPerSecond * 30),
        paperEquity: allocatedEquity,
        riskPerTradePercent: this.strategy.config.riskPerTradePercent,
        maximumDailyLossPercent: this.strategy.config.maximumDailyLossPercent,
        maximumConsecutiveLosses: this.strategy.config.maximumConsecutiveLosses,
        maximumInventoryDurationMs: this.strategy.config.maximumInventoryDurationMs,
        hardStopTicks: this.strategy.config.hardStopTicks,
      }, { tickSize, quantityStep });
      this.engine.setFeeSchedule({ makerRate: 0.0002, takerRate: 0.00055, source: "PAPER_CONSERVATIVE", observedAt: Date.now(), version: "bybit-linear-conservative-2026-09" });
      const now = Date.now();
      this.engine.process({
        id: `local:${this.runId}:instrument:${rules.symbol}:${now}`,
        venue: "BYBIT",
        category: "linear",
        symbol: this.strategy.symbol,
        eventType: "INSTRUMENT",
        exchangeTimestamp: now,
        receiveTimestamp: now,
        processTimestamp: now,
        payloadVersion: 1,
        payload: {
          status: rules.status,
          tickSize,
          quantityStep,
          minimumQuantity: Number(rules.minQuantity),
          minimumNotional: Number(rules.minNotional),
          maximumLimitQuantity: Number(rules.maxLimitQuantity),
          maximumMarketQuantity: Number(rules.maxMarketQuantity),
          fundingIntervalMinutes: 480,
          version: `bybit-local:${rules.symbol}:${now}`,
        },
      });
      await this.sampleClock();
      this.clockTimer = window.setInterval(() => void this.sampleClock(), 10_000);
      this.connect();
      this.updateFromTelemetry(this.engine.telemetry(), true);
    } catch (cause) {
      this.fail(cause, "LOCAL_QALC_INITIALIZATION_FAILED");
      throw cause;
    }
  }

  status() {
    if (this.engine) this.updateFromTelemetry(this.engine.telemetry(), this.socket?.readyState === WebSocket.OPEN);
    return structuredClone(this.lastStatus);
  }

  async stop(state: string) {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.watchdogTimer) window.clearInterval(this.watchdogTimer);
    if (this.clockTimer) window.clearInterval(this.clockTimer);
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "QALC local runtime stopped");
    await this.processing.catch(() => undefined);
    await this.persisting.catch(() => undefined);
    this.lastStatus = { ...this.lastStatus, available: false, runtimeState: state, updatedAt: Date.now() };
    hydratedStatus = this.lastStatus;
    await Promise.all([persistStatus(this.strategyId, this.lastStatus), this.persistTimeline()]);
  }

  private connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.engine?.book.markSnapshotPending();
    this.lastStatus = { ...this.lastStatus, available: false, runtimeState: this.reconnects ? "RECONCILING" : "SYNCHRONIZING_BOOK", updatedAt: Date.now() };
    const socket = new WebSocket(PUBLIC_SOCKET);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.stopped || generation !== this.generation) return socket.close();
      this.lastMessageAt = Date.now();
      socket.send(JSON.stringify({ op: "subscribe", args: [`orderbook.200.${this.strategy.symbol}`, `publicTrade.${this.strategy.symbol}`] }));
      this.pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
      this.watchdogTimer = window.setInterval(() => {
        if (Date.now() - this.lastMessageAt > 5_000 && socket.readyState === WebSocket.OPEN) {
          this.engine?.book.markStale();
          this.lastStatus = { ...this.lastStatus, available: false, runtimeState: "DATA_STALE", updatedAt: Date.now() };
          socket.close(4000, "QALC public feed stale");
        }
      }, 1_000);
    });
    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      this.processing = this.processing.then(() => this.handleMessage(raw, generation)).catch((cause) => this.fail(cause, "LOCAL_QALC_EVENT_PROCESSING_FAILED"));
    });
    socket.addEventListener("error", () => {
      this.fail(new Error("Bybit public QALC socket error."), "LOCAL_QALC_SOCKET_ERROR", false);
      if (socket.readyState < WebSocket.CLOSING) socket.close(4002, "QALC public socket error");
    });
    socket.addEventListener("close", () => this.reconnect(generation));
  }

  private async handleMessage(raw: string, generation: number) {
    if (this.stopped || generation !== this.generation || !this.engine) return;
    const receiveTimestamp = Date.now();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload.success === false) throw new Error(`BYBIT_QALC_SUBSCRIPTION_${String(payload.ret_msg || "FAILED")}`);
    const events = normalizeLocalBybitMessage(payload, this.strategy.symbol, receiveTimestamp);
    if (!events.length) return;
    this.lastMessageAt = receiveTimestamp;
    for (const event of events) {
      const before = this.engine.telemetry(event.receiveTimestamp);
      const after = this.engine.process(event);
      this.projectTimeline(event, before, after);
      this.updateFromTelemetry(after, true);
      if (after.runtimeState === "BOOK_GAP") {
        this.socket?.close(4001, "QALC book gap");
        break;
      }
    }
    this.schedulePersist();
  }

  private reconnect(generation: number) {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.watchdogTimer) window.clearInterval(this.watchdogTimer);
    if (this.stopped || generation !== this.generation) return;
    this.reconnects += 1;
    this.lastStatus = { ...this.lastStatus, available: false, runtimeState: "RECONCILING", updatedAt: Date.now() };
    const delay = Math.min(30_000, 1_500 * 2 ** Math.min(5, this.reconnects - 1));
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private async sampleClock() {
    if (!this.engine || this.stopped) return;
    try {
      const sample = await sampleLocalBybitClock("MAINNET");
      this.engine.observeClock(sample.serverTimeMs, sample.requestSentAt, sample.responseReceivedAt);
      this.updateFromTelemetry(this.engine.telemetry(), this.socket?.readyState === WebSocket.OPEN);
    } catch (cause) {
      this.fail(cause, "LOCAL_QALC_CLOCK_SAMPLE_FAILED", false);
    }
  }

  private updateFromTelemetry(telemetry: QalcTelemetry, socketLive: boolean) {
    this.lastStatus = {
      available: socketLive && telemetry.book.state === "LIVE",
      source: SOURCE,
      certificationState: telemetry.certificationState,
      runtimeState: telemetry.runtimeState,
      updatedAt: telemetry.updatedAt,
      book: telemetry.book,
      clock: telemetry.clock,
      features: telemetry.features,
      decision: telemetry.decision,
      activeQuote: telemetry.activeQuote,
      inventory: telemetry.inventory,
      risk: telemetry.risk,
      executions: telemetry.executions,
      recentAudit: telemetry.recentAudit,
      counters: { ...telemetry.counters, local_socket_reconnects: this.reconnects, local_socket_live: socketLive ? 1 : 0 },
    };
    hydratedStatus = this.lastStatus;
  }

  private projectTimeline(source: QalcMarketEvent, before: QalcTelemetry, after: QalcTelemetry) {
    const decision = after.decision;
    const metrics = decisionMetrics(after);
    const side = decision && decision.directional.probabilityUp >= 0.58 ? "BUY" : decision && decision.directional.probabilityDown >= 0.58 ? "SELL" : undefined;
    if (decision && side && (!this.lastCandidate || this.lastCandidate.side !== side || source.receiveTimestamp - this.lastCandidate.at >= 15_000)) {
      this.emit(source, {
        kind: side === "BUY" ? "CANDIDATE_LONG" : "CANDIDATE_SHORT",
        price: decision.quotePrice || after.features?.mid || 0,
        quantity: decision.quantity || 0,
        side,
        direction: side === "BUY" ? "LONG" : "SHORT",
        reason: decision.action === "NO_QUOTE" ? `RESEARCH_SETUP:${decision.reason}` : decision.reason,
        metrics,
      });
      this.lastCandidate = { side, at: source.receiveTimestamp };
    }
    if (decision?.action === "NO_QUOTE" && decision.reason && (!this.lastRejected || this.lastRejected.reason !== decision.reason || source.receiveTimestamp - this.lastRejected.at >= 5_000)) {
      this.emit(source, { kind: "REJECTED", price: after.features?.mid || decision.quotePrice || 0, quantity: 0, reason: decision.reason, metrics });
      this.lastRejected = { reason: decision.reason, at: source.receiveTimestamp };
    }
    const quote = after.activeQuote;
    if (quote && (!this.priorQuote || quote.id !== this.priorQuote.id)) {
      this.emit(source, { kind: quote.side === "BUY" ? "QUOTE_BID" : "QUOTE_ASK", price: quote.price, quantity: quote.quantity, side: quote.side, direction: quote.side === "BUY" ? "LONG" : "SHORT", reason: decision?.reason || "PAPER_POST_ONLY_SUBMITTED", orderId: quote.id, metrics });
    }
    if (quote && this.priorQuote?.id === quote.id && quote.state !== this.priorQuote.state && (quote.state === "CANCELLED" || quote.state === "EXPIRED")) {
      this.emit(source, { kind: quote.state === "EXPIRED" ? "QUOTE_EXPIRED" : "QUOTE_CANCELLED", price: quote.price, quantity: quote.remainingQuantity, side: quote.side, direction: quote.side === "BUY" ? "LONG" : "SHORT", reason: quote.cancelReason || quote.state, orderId: quote.id, metrics });
    }
    for (const execution of after.executions || []) {
      if (this.seenExecutions.has(execution.id)) continue;
      this.seenExecutions.add(execution.id);
      if (execution.maker) {
        const first = !before.inventory;
        this.emit(source, { kind: first ? (execution.side === "BUY" ? "ENTRY_LONG" : "ENTRY_SHORT") : "PARTIAL_FILL", price: execution.price, quantity: execution.quantity, side: execution.side, direction: execution.side === "BUY" ? "LONG" : "SHORT", reason: first ? "PAPER_QUEUE_FILL_ENTRY" : "PAPER_QUEUE_PARTIAL_FILL", orderId: execution.orderId, fillId: execution.id, metrics });
      } else {
        const direction = before.inventory?.side || (execution.side === "SELL" ? "LONG" : "SHORT");
        this.emit(source, { kind: direction === "LONG" ? "EXIT_LONG" : "EXIT_SHORT", price: execution.price, quantity: execution.quantity, side: execution.side, direction, reason: "PAPER_INVENTORY_EXIT", orderId: execution.orderId, fillId: execution.id, metrics });
      }
    }
    this.priorQuote = quote ? { ...quote } : undefined;
  }

  private emit(source: QalcMarketEvent, value: Omit<QalcChartEvent, "schemaVersion" | "id" | "engineId" | "strategyId" | "runId" | "modelVersion" | "venue" | "category" | "symbol" | "eventTime" | "receiveTime" | "sourceEventId" | "origin" | "certificationState">) {
    if (!Number.isFinite(value.price) || value.price <= 0) return;
    const id = stableQalcId("timeline", this.runId, value.kind, source.id, value.orderId || "", value.fillId || "", String(source.exchangeTimestamp));
    if (this.timeline.some((event) => event.id === id)) return;
    this.timeline.push({
      schemaVersion: 1,
      id,
      engineId: "black-core-qalc",
      strategyId: this.strategyId,
      runId: this.runId,
      modelVersion: "BC-QALC-BASELINE-1",
      venue: "BYBIT",
      category: "linear",
      symbol: this.strategy.symbol,
      eventTime: source.exchangeTimestamp,
      receiveTime: source.receiveTimestamp,
      sourceEventId: source.id,
      origin: "PAPER",
      certificationState: "RESEARCH",
      ...value,
    });
    if (this.timeline.length > MAX_TIMELINE_EVENTS) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE_EVENTS);
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = undefined;
      this.persisting = this.persisting
        .then(() => Promise.all([persistStatus(this.strategyId, this.lastStatus), this.persistTimeline()]).then(() => undefined))
        .catch((cause) => this.fail(cause, "LOCAL_QALC_PERSIST_FAILED", false));
    }, 1_000);
  }

  private async persistTimeline() {
    const current = await getLocalDocument<QalcChartEvent[]>(TIMELINE_NAMESPACE, this.strategyId);
    await putLocalDocument(TIMELINE_NAMESPACE, this.strategyId, this.timeline.slice(-MAX_TIMELINE_EVENTS), current?.revision);
  }

  private fail(cause: unknown, type: string, terminal = true) {
    const message = String(cause instanceof Error ? cause.message : cause || "Unknown QALC failure").slice(0, 240);
    this.lastStatus = {
      ...this.lastStatus,
      available: false,
      runtimeState: terminal ? "ERROR" : this.lastStatus.runtimeState,
      updatedAt: Date.now(),
      recentAudit: [...(this.lastStatus.recentAudit || []).slice(-98), { type, time: Date.now(), severity: terminal ? "ERROR" : "WARN", message }],
    };
    hydratedStatus = this.lastStatus;
  }
}

function decisionMetrics(status: QalcTelemetry): QalcChartEvent["metrics"] {
  const decision = status.decision;
  return {
    probabilityUp: decision?.directional.probabilityUp,
    probabilityDown: decision?.directional.probabilityDown,
    expectedMoveTicks: decision?.directional.expectedMoveTicks,
    expectedNetEdgeUsdt: decision?.costs.expectedNetEdgeUsdt,
    allInCostUsdt: decision?.costs.allInCostUsdt,
    fillProbability: decision?.fill.beforeInvalidation,
    toxicity: decision?.toxicity ?? status.features?.toxicity.score,
    queueAhead: status.activeQuote?.queueAheadEstimated,
    queueConfidence: status.activeQuote?.queueConfidence,
    feeSource: decision?.costs.feeSource,
    projectedTargetPrice: decision?.projectedTargetPrice,
    invalidationPrice: decision?.invalidationPrice,
    expiresAt: decision?.expiresAt,
    quoteEligible: decision?.action === "QUOTE_BID" || decision?.action === "QUOTE_ASK",
  };
}

async function persistStatus(strategyId: string, status: QalcRuntimeStatus) {
  const current = await getLocalDocument<QalcRuntimeStatus>(STATUS_NAMESPACE, strategyId);
  await putLocalDocument(STATUS_NAMESPACE, strategyId, status, current?.revision);
}

function stoppedStatus(state: string): QalcRuntimeStatus {
  return { available: false, source: SOURCE, certificationState: "RESEARCH", runtimeState: state, updatedAt: Date.now(), clock: { state: "UNAVAILABLE", offsetMs: 0, driftMsPerMinute: 0 }, recentAudit: [] };
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value: unknown, label: string) {
  const parsed = finite(value);
  if (parsed <= 0) throw new Error(`Bybit returned an invalid QALC ${label}.`);
  return parsed;
}
