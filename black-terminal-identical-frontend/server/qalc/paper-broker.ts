import type { QalcBookMutation, QalcBookView, QalcConfig, QalcFeeSchedule, QalcMarketEvent, QalcPaperExecution, QalcPaperOrder, QalcTradePayload } from "./contracts.ts";
import { stableQalcId } from "./stable-id.ts";

type PendingCancel = { orderId: string; effectiveAt: number; reason: string };

/**
 * Deterministic Paper-only matching model. It cannot call an exchange adapter.
 * Fills require observed opposing taker volume after acknowledgement and queue consumption.
 */
export class QalcPaperBroker {
  private readonly config: QalcConfig;
  private readonly fees: () => QalcFeeSchedule;
  private active?: QalcPaperOrder;
  private executions: QalcPaperExecution[] = [];
  private pendingCancel?: PendingCancel;
  private generation = 0;

  constructor(config: QalcConfig, fees: () => QalcFeeSchedule) { this.config = config; this.fees = fees; }

  order() { return this.active ? { ...this.active } : undefined; }
  executionHistory() { return this.executions.map((row) => ({ ...row })); }

  submit(input: { side: "BUY" | "SELL"; price: number; quantity: number; now: number; book: QalcBookView }) {
    if (this.config.mode !== "PAPER" || !this.config.paperEnabled || this.config.liveExecutionEnabled || this.config.groupFanoutEnabled) {
      return { accepted: false as const, reason: "PAPER_RUNTIME_NOT_ARMED" };
    }
    if (this.active && !terminal(this.active.state)) return { accepted: false as const, reason: "ONE_SIDED_QUOTE_ALREADY_ACTIVE" };
    const bid = input.book.bids[0]?.price;
    const ask = input.book.asks[0]?.price;
    if (!bid || !ask || input.quantity <= 0 || input.price <= 0) return { accepted: false as const, reason: "INVALID_QUOTE" };
    if ((input.side === "BUY" && input.price >= ask) || (input.side === "SELL" && input.price <= bid)) {
      return { accepted: false as const, reason: "POST_ONLY_WOULD_CROSS" };
    }
    this.generation += 1;
    const atPrice = input.book[input.side === "BUY" ? "bids" : "asks"].find((row) => row.price === input.price)?.quantity || 0;
    const order: QalcPaperOrder = {
      id: stableQalcId("order", this.config.runId, String(this.generation), input.side, String(input.price), String(input.quantity), String(input.now)),
      clientOrderId: `qalc-paper-${this.config.runId.slice(0, 12)}-${this.generation}`,
      generation: this.generation,
      symbol: this.config.symbol,
      side: input.side,
      price: input.price,
      quantity: input.quantity,
      filledQuantity: 0,
      remainingQuantity: input.quantity,
      state: "CREATED",
      createdAt: input.now,
      acknowledgedAt: input.now + this.config.latency.submissionMs + this.config.latency.acknowledgementMs,
      expiresAt: input.now + this.config.latency.submissionMs + this.config.latency.acknowledgementMs + this.config.quoteLifetimeMs,
      queueAheadInitial: atPrice * 1.1,
      queueAheadEstimated: atPrice * 1.1,
      queueConfidence: atPrice > 0 ? 0.55 : 0.25,
      maker: true,
    };
    this.active = order;
    this.pendingCancel = undefined;
    return { accepted: true as const, order: { ...order } };
  }

  requestCancel(now: number, reason: string) {
    if (!this.active || terminal(this.active.state) || this.pendingCancel) return false;
    this.pendingCancel = { orderId: this.active.id, effectiveAt: now + this.config.latency.cancelMs, reason };
    return true;
  }

  onTime(now: number) {
    if (!this.active || terminal(this.active.state)) return;
    if (this.active.state === "CREATED" && now >= (this.active.acknowledgedAt || Number.POSITIVE_INFINITY)) {
      this.active.state = "ACTIVE";
      this.active.activatedAt = this.active.acknowledgedAt;
    }
    if (this.pendingCancel?.orderId === this.active.id && now >= this.pendingCancel.effectiveAt) {
      this.active.state = "CANCELLED";
      this.active.cancelledAt = this.pendingCancel.effectiveAt;
      this.active.cancelReason = this.pendingCancel.reason;
      this.pendingCancel = undefined;
      return;
    }
    if (now >= this.active.expiresAt) {
      this.active.state = "EXPIRED";
      this.active.cancelledAt = now;
      this.active.cancelReason = "QUOTE_LIFETIME_EXPIRED";
    }
  }

  onBookMutation(mutation: QalcBookMutation) {
    const order = this.active;
    if (!order || !["ACTIVE", "PARTIALLY_FILLED"].includes(order.state)) return;
    for (const change of mutation.changes) {
      const sameSide = (order.side === "BUY" && change.side === "BID") || (order.side === "SELL" && change.side === "ASK");
      if (!sameSide || change.price !== order.price || change.delta >= 0) continue;
      // We cannot know whether cancellations were ahead of us, so credit only 25%.
      order.queueAheadEstimated = Math.max(0, order.queueAheadEstimated - Math.abs(change.delta) * 0.25);
      order.queueConfidence = Math.max(0.1, order.queueConfidence - 0.01);
    }
  }

  onTrade(event: QalcMarketEvent): QalcPaperExecution | undefined {
    const order = this.active;
    if (!order || !["ACTIVE", "PARTIALLY_FILLED"].includes(order.state) || event.eventType !== "TRADE") return undefined;
    const trade = event.payload as QalcTradePayload;
    const reachesQuote = order.side === "BUY"
      ? trade.side === "SELL" && trade.price <= order.price
      : trade.side === "BUY" && trade.price >= order.price;
    if (!reachesQuote) return undefined;
    let executable = trade.quantity;
    const consumedAhead = Math.min(order.queueAheadEstimated, executable);
    order.queueAheadEstimated -= consumedAhead;
    executable -= consumedAhead;
    const fillQuantity = Math.min(order.remainingQuantity, executable);
    if (fillQuantity <= 0) return undefined;
    order.filledQuantity += fillQuantity;
    order.remainingQuantity = Math.max(0, order.quantity - order.filledQuantity);
    order.state = order.remainingQuantity <= 1e-12 ? "FILLED" : "PARTIALLY_FILLED";
    if (order.state === "FILLED") this.pendingCancel = undefined;
    const fee = order.price * fillQuantity * this.fees().makerRate;
    const execution: QalcPaperExecution = {
      id: stableQalcId("fill", this.config.runId, order.id, trade.tradeId, String(order.filledQuantity)), orderId: order.id, symbol: order.symbol, side: order.side,
      price: order.price, quantity: fillQuantity, notional: order.price * fillQuantity,
      fee, maker: true, time: event.receiveTimestamp + this.config.latency.executionNotificationMs,
      sourceTradeId: trade.tradeId,
    };
    this.executions.push(execution);
    return { ...execution };
  }

  executeTakerExit(input: { side: "BUY" | "SELL"; quantity: number; now: number; book: QalcBookView; slippageTicks: number; tickSize: number }) {
    const level = input.side === "BUY" ? input.book.asks[0] : input.book.bids[0];
    if (!level || input.quantity <= 0) return undefined;
    const signedSlippage = input.side === "BUY" ? input.slippageTicks : -input.slippageTicks;
    const price = level.price + signedSlippage * input.tickSize;
    const execution: QalcPaperExecution = {
      id: stableQalcId("exit", this.config.runId, String(this.generation), input.side, String(input.quantity), String(input.now)), orderId: `qalc-paper-exit-${this.generation}`, symbol: this.config.symbol,
      side: input.side, price, quantity: input.quantity, notional: price * input.quantity,
      fee: price * input.quantity * this.fees().takerRate, maker: false,
      time: input.now + this.config.latency.submissionMs + this.config.latency.executionNotificationMs,
    };
    this.executions.push(execution);
    return { ...execution };
  }
}

function terminal(state: QalcPaperOrder["state"]) { return ["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(state); }
