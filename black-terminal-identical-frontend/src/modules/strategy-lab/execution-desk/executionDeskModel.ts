import type { CompiledMarker } from "../../../components/ScriptCompiler";
import type { Candle } from "../../../chart-engine/types";
import type { StrategySettings, StrategySignal } from "../types/strategy.types";
import {
  positionAwareStrategyEntries,
  superAtrTakeProfitAtrSeries,
  superAtrTakeProfitPlanFromAtr,
} from "../adapters/signalAdapter.ts";
import type { StrategyPaperAccount, StrategyTargetSnapshot } from "../automation/strategyAutomation.types";

export type ExecutionDeskData = {
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  analytics: Record<string, unknown>;
};

export type ExecutionDeskAction = {
  id: string;
  time: number;
  price: number;
  action: string;
  direction: "long" | "short" | "neutral";
  role: "entry" | "takeProfit" | "stopLoss" | "close" | "reversal" | "exit";
  quantity: number;
  pnl?: number;
  source: "PAPER" | "LIVE";
  detail: string;
};

export type ExecutionDeskMetrics = {
  equity: number;
  ongoingPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  winRate: number;
  currentDrawdown: number;
  maximumDrawdown: number;
  profitFactor: number | null;
  tradeCount: number;
  grossPnl: number;
  fees: number;
  funding: number;
  sharpe: number;
  sortino: number;
  openPositions: number;
  openOrders: number;
};

const list = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

export function executionDeskData(value: Record<string, unknown> | null | undefined): ExecutionDeskData {
  return {
    positions: list(value?.positions),
    orders: list(value?.orders),
    executions: list(value?.executions),
    trades: list(value?.trades),
    analytics: object(value?.analytics),
  };
}

export function buildExecutionDeskActions(data: ExecutionDeskData, source: "PAPER" | "LIVE"): ExecutionDeskAction[] {
  const actions: ExecutionDeskAction[] = [];
  for (const [index, trade] of data.trades.entries()) {
    const side = String(trade.side || trade.direction || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") continue;
    const direction = side === "LONG" ? "long" : "short";
    const openedAt = epochSeconds(trade.opened_at || trade.entry_time || trade.created_at);
    const closedAt = epochSeconds(trade.closed_at || trade.exit_time || trade.updated_at);
    const entryPrice = numeric(trade.entry_price, trade.average_price);
    const exitPrice = numeric(trade.exit_price, trade.close_price);
    const quantity = numeric(trade.quantity, trade.size);
    if (openedAt && entryPrice > 0) actions.push({
      id: `trade-entry:${String(trade.id || index)}`,
      time: openedAt,
      price: entryPrice,
      action: side,
      direction,
      role: "entry",
      quantity,
      source,
      detail: String(trade.entry_signal_key || trade.signal || "Confirmed strategy entry"),
    });
    if (closedAt && exitPrice > 0) {
      const reason = String(trade.exit_reason || trade.reason || "CLOSE");
      const classified = classifyExit(reason, side);
      actions.push({
        id: `trade-exit:${String(trade.id || index)}`,
        time: closedAt,
        price: exitPrice,
        action: classified.action,
        direction,
        role: classified.role,
        quantity,
        pnl: numeric(trade.net_pnl, trade.realized_pnl),
        source,
        detail: reason.replaceAll("_", " "),
      });
    }
  }

  for (const [index, execution] of data.executions.entries()) {
    const time = epochSeconds(execution.executed_at || execution.filled_at || execution.created_at);
    const price = numeric(execution.price, execution.filled_price, execution.average_price);
    if (!time || price <= 0) continue;
    const side = String(execution.side || "").toUpperCase();
    const metadata = object(execution.safe_metadata || execution.metadata);
    const descriptor = [
      metadata.action,
      metadata.label,
      metadata.strategyRole,
      metadata.exitReason,
      execution.signal_key,
      execution.reason,
    ].filter(Boolean).join(" ");
    const classified = classifyExecution(descriptor, side);
    actions.push({
      id: `execution:${String(execution.id || index)}`,
      time,
      price,
      action: classified.action,
      direction: classified.direction,
      role: classified.role,
      quantity: numeric(execution.quantity, execution.filled_quantity),
      pnl: numeric(execution.realized_pnl) || undefined,
      source,
      detail: descriptor || `${side || "STRATEGY"} fill`,
    });
  }

  const unique = new Map<string, ExecutionDeskAction>();
  for (const action of actions.sort((a, b) => a.time - b.time)) {
    const key = [Math.round(action.time), action.price.toPrecision(10), action.action].join(":");
    const existing = unique.get(key);
    // Trade rows carry entry/exit intent while raw venue fills carry the most
    // precise execution price. Retain the richer semantic row on collisions.
    if (!existing || action.id.startsWith("trade-")) unique.set(key, action);
  }
  return [...unique.values()].sort((a, b) => b.time - a.time);
}

export function executionMarkers(actions: readonly ExecutionDeskAction[], candleTimes: readonly number[]): CompiledMarker[] {
  if (!candleTimes.length) return [];
  return actions.flatMap((action) => {
    const index = nearestCandleIndex(candleTimes, action.time);
    if (index < 0) return [];
    return [{
      id: action.id,
      index,
      time: candleTimes[index]!,
      signalPrice: action.price,
      value: action.price,
      label: action.action,
      labelSize: 10,
      direction: action.direction,
      kind: action.role === "entry" ? "entry" as const : "exit" as const,
      strategyRole: action.role,
      color: actionColor(action),
    }];
  });
}

/**
 * Closed-bar strategy signals are research/runtime decisions, not broker
 * fills. They are therefore rendered on the dedicated chart but deliberately
 * excluded from the authoritative action tape and performance statistics.
 */
export function strategySignalMarkers(
  signals: readonly StrategySignal[],
  candles: readonly Candle[],
  intervalSeconds: number,
  options: { pyramiding?: number; processOrdersOnClose?: boolean } = {},
): CompiledMarker[] {
  if (!candles.length) return [];
  const candleTimes = candles.map((candle) => candle.time);
  const ordered = positionAwareStrategyEntries(signals, options.pyramiding);
  const markers: CompiledMarker[] = [];
  for (const signal of ordered) {
    const direction = signal.direction;
    if (direction !== "long" && direction !== "short") continue;
    const fillTime = signal.timestamp + (options.processOrdersOnClose === false ? intervalSeconds : 0);
    if (fillTime < candleTimes[0]! || fillTime > candleTimes[candleTimes.length - 1]!) continue;
    const index = nearestCandleIndex(candleTimes, fillTime);
    if (index < 0 || index >= candles.length) continue;
    const candle = candles[index]!;
    const signalPrice = options.processOrdersOnClose === false ? candle.open : candle.close;
    const previousDirection = signal.metadata?.previousDirection;
    if (previousDirection === "long" || previousDirection === "short") {
      markers.push({
        id: `strategy-close:${previousDirection}:${signal.timestamp}`,
        index,
        time: candle.time,
        signalPrice,
        value: signalPrice,
        label: previousDirection === "long" ? "CLOSE POSITION LONG" : "CLOSE POSITION SHORT",
        labelSize: 12,
        direction: previousDirection,
        kind: "exit",
        strategyRole: "reversal",
        color: "#a1a1aa",
      });
    }
    markers.push({
      id: `strategy-signal:${direction}:${signal.timestamp}`,
      index,
      time: candle.time,
      signalPrice,
      value: signalPrice,
      label: direction === "long" ? "LONG ENTRY" : "SHORT ENTRY",
      labelSize: 12,
      direction,
      kind: "entry",
      strategyRole: "entry",
      color: direction === "long" ? "#42f59b" : "#ff174a",
    });
  }
  return markers;
}

/**
 * Replays SuperATR's seven strategy.exit limit orders one candle at a time.
 * Orders calculated at a bar close are eligible only from the following bar,
 * ATR exits are repriced after every completed candle, and each exit ID can
 * fill only once for a position. These markers remain research projections;
 * authoritative broker/paper fills still come from the execution ledger.
 */
export function superAtrHistoricalStrategyMarkers(
  signals: readonly StrategySignal[],
  calculationCandles: readonly Candle[],
  visibleCandles: readonly Candle[],
  intervalSeconds: number,
  settings: StrategySettings,
  options: { pyramiding?: number; processOrdersOnClose?: boolean } = {},
): CompiledMarker[] {
  const entryMarkers = strategySignalMarkers(signals, visibleCandles, intervalSeconds, options);
  if (!calculationCandles.length || !visibleCandles.length || settings.superAtrMultiStepTakeProfit === false) return entryMarkers;

  type Target = { id: string; price: number; quantityPercent: number };
  type Position = {
    direction: "long" | "short";
    entryPrice: number;
    entryTime: number;
    filled: Set<string>;
    filledPercent: number;
    activeTargets: Target[];
  };

  const orderedCandles = [...calculationCandles].sort((left, right) => left.time - right.time);
  const transitionsByTime = new Map<number, StrategySignal>();
  for (const signal of positionAwareStrategyEntries(signals, options.pyramiding)) {
    const fillTime = signal.timestamp + (options.processOrdersOnClose === false ? intervalSeconds : 0);
    transitionsByTime.set(fillTime, signal);
  }
  const atrSeries = superAtrTakeProfitAtrSeries(orderedCandles, settings);
  const projected: Array<{ id: string; time: number; price: number; direction: "long" | "short"; target: string }> = [];
  let position: Position | null = null;

  const openPosition = (signal: StrategySignal, candle: Candle, price: number): Position | null => {
    if (signal.direction !== "long" && signal.direction !== "short") return null;
    return {
      direction: signal.direction,
      entryPrice: price,
      entryTime: candle.time,
      filled: new Set<string>(),
      filledPercent: 0,
      activeTargets: [],
    };
  };

  for (let index = 0; index < orderedCandles.length; index += 1) {
    const candle = orderedCandles[index]!;
    const transition = transitionsByTime.get(candle.time);
    let openedAtClose = false;

    // TradingView's default market fill happens at the next bar open. The
    // reversal closes the previous entry and cancels its remaining exits
    // before the new position's intrabar range is evaluated.
    if (transition && options.processOrdersOnClose === false) position = openPosition(transition, candle, candle.open);

    if (position) {
      for (const target of position.activeTargets) {
        if (position.filled.has(target.id) || position.filledPercent >= 100) continue;
        const touched = position.direction === "long" ? candle.high >= target.price : candle.low <= target.price;
        if (!touched) continue;
        const fillPrice = position.direction === "long"
          ? candle.open >= target.price ? candle.open : target.price
          : candle.open <= target.price ? candle.open : target.price;
        const filledPercent = Math.min(target.quantityPercent, 100 - position.filledPercent);
        if (!(filledPercent > 0)) continue;
        position.filled.add(target.id);
        position.filledPercent += filledPercent;
        projected.push({
          id: `strategy-tp:${position.entryTime}:${target.id}`,
          time: candle.time,
          price: fillPrice,
          direction: position.direction,
          target: target.id,
        });
      }
    }

    // With process_orders_on_close enabled, current-bar limit orders had the
    // intrabar opportunity above; the market reversal then fills at close.
    if (transition && options.processOrdersOnClose !== false) {
      position = openPosition(transition, candle, candle.close);
      openedAtClose = true;
    }

    if (position && !openedAtClose) {
      const plan = superAtrTakeProfitPlanFromAtr(position.direction, position.entryPrice, atrSeries[index], settings);
      let reserved = position.filledPercent;
      position.activeTargets = plan.flatMap((target) => {
        if (position!.filled.has(target.id) || reserved >= 100) return [];
        const quantityPercent = Math.min(target.quantityPercent, 100 - reserved);
        reserved += quantityPercent;
        return quantityPercent > 0 ? [{ ...target, quantityPercent }] : [];
      });
    }
  }

  const firstVisible = visibleCandles[0]!.time;
  const lastVisible = visibleCandles[visibleCandles.length - 1]!.time;
  const visibleTimes = visibleCandles.map((candle) => candle.time);
  const takeProfitMarkers = projected.flatMap((fill): CompiledMarker[] => {
    if (fill.time < firstVisible || fill.time > lastVisible) return [];
    const index = nearestCandleIndex(visibleTimes, fill.time);
    if (index < 0) return [];
    return [{
      id: fill.id,
      index,
      time: visibleCandles[index]!.time,
      signalPrice: fill.price,
      value: fill.price,
      label: fill.target,
      labelSize: 12,
      direction: fill.direction,
      kind: "exit",
      strategyRole: "takeProfit",
      color: "#ffd166",
    }];
  });
  return [...entryMarkers, ...takeProfitMarkers].sort((left, right) => left.index - right.index || left.label.localeCompare(right.label));
}

export function buildExecutionDeskMetrics(
  data: ExecutionDeskData,
  paper?: StrategyPaperAccount | null,
  snapshot?: StrategyTargetSnapshot | null,
): ExecutionDeskMetrics {
  const analytics = data.analytics;
  const tradePnls = data.trades.map((row) => numeric(row.net_pnl, row.realized_pnl));
  const grossProfits = tradePnls.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(tradePnls.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const realized = snapshot ? numeric(snapshot.realizedPnl, snapshot.netPnl) : numeric(paper?.realizedPnl, analytics.netPnl);
  const unrealized = snapshot
    ? numeric(snapshot.unrealizedPnl)
    : data.positions.length
      ? data.positions.reduce((sum, row) => sum + numeric(row.unrealized_pnl), 0)
      : numeric(paper?.unrealizedPnl);
  const analyticsNet = numeric(analytics.netPnl, analytics.net_pnl);
  const ongoingPnl = snapshot ? numeric(snapshot.netPnl) : realized + unrealized;
  const wins = tradePnls.filter((value) => value > 0).length;
  const profitFactorValue = analytics.profitFactor ?? analytics.profit_factor ?? snapshot?.profitFactor;
  const parsedProfitFactor = profitFactorValue === null ? null : numeric(profitFactorValue);
  return {
    equity: snapshot ? numeric(snapshot.equity) : numeric(paper?.demoEquity) + realized + unrealized,
    ongoingPnl,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    winRate: numeric(analytics.winRate, analytics.win_rate, snapshot?.winRate, tradePnls.length ? wins / tradePnls.length * 100 : 0),
    currentDrawdown: numeric(analytics.currentDrawdownPercent, analytics.current_drawdown_percent, snapshot?.currentDrawdownPercent),
    maximumDrawdown: numeric(analytics.maximumDrawdownPercent, analytics.maxDrawdownPercent, analytics.maximum_drawdown_percent, snapshot?.maximumDrawdownPercent, paper?.maximumDrawdownPercent),
    profitFactor: profitFactorValue === null ? null : parsedProfitFactor || (grossLosses > 0 ? grossProfits / grossLosses : grossProfits > 0 ? null : 0),
    tradeCount: Math.max(data.trades.length, Math.round(numeric(analytics.tradeCount, analytics.trade_count, snapshot?.tradeCount))),
    grossPnl: numeric(analytics.grossPnl, analytics.gross_pnl, snapshot?.grossPnl, tradePnls.reduce((sum, value) => sum + value, 0)),
    fees: numeric(analytics.fees, snapshot?.fees, paper?.fees),
    funding: numeric(analytics.funding, snapshot?.funding, paper?.funding),
    sharpe: numeric(analytics.sharpe, snapshot?.sharpe),
    sortino: numeric(analytics.sortino, snapshot?.sortino),
    openPositions: snapshot ? numeric(snapshot.openPositions) : data.positions.length,
    openOrders: snapshot ? numeric(snapshot.openOrders) : data.orders.filter((row) => !["FILLED", "CANCELLED", "REJECTED", "CLOSED"].includes(String(row.status || "").toUpperCase())).length,
  };
}

export function equityCurve(trades: readonly Record<string, unknown>[]) {
  let equity = 0;
  return [...trades]
    .sort((a, b) => epochSeconds(a.closed_at || a.exit_time) - epochSeconds(b.closed_at || b.exit_time))
    .map((trade) => ({ time: epochSeconds(trade.closed_at || trade.exit_time), value: equity += numeric(trade.net_pnl, trade.realized_pnl) }));
}

function classifyExit(reason: string, side: string): Pick<ExecutionDeskAction, "action" | "role"> {
  const normalized = reason.toUpperCase().replaceAll("-", "_");
  const level = takeProfitLevel(normalized);
  if (level) return { action: `TP${level}`, role: "takeProfit" };
  if (normalized.includes("TAKE_PROFIT") || normalized === "TP") return { action: "TP1", role: "takeProfit" };
  if (normalized.includes("STOP") || normalized.includes("LIQUIDATION")) return { action: "STOP LOSS", role: "stopLoss" };
  if (normalized.includes("OPPOSITE") || normalized.includes("REVERSE")) return { action: `CLOSE POSITION ${side}`, role: "reversal" };
  return { action: `CLOSE POSITION ${side}`, role: "close" };
}

function classifyExecution(descriptor: string, side: string): Pick<ExecutionDeskAction, "action" | "direction" | "role"> {
  const normalized = descriptor.toUpperCase().replaceAll("-", "_");
  const level = takeProfitLevel(normalized);
  if (level) return { action: `TP${level}`, direction: side === "BUY" ? "short" : "long", role: "takeProfit" };
  if (normalized.includes("TAKE_PROFIT")) return { action: "TP1", direction: side === "BUY" ? "short" : "long", role: "takeProfit" };
  if (normalized.includes("STOP") || normalized.includes("LIQUIDATION")) return { action: "STOP LOSS", direction: side === "BUY" ? "short" : "long", role: "stopLoss" };
  if (normalized.includes("EXIT") || normalized.includes("CLOSE") || normalized.includes("OPPOSITE") || normalized.includes("REVERSE")) {
    const closing = normalized.includes("SHORT") ? "SHORT" : normalized.includes("LONG") ? "LONG" : side === "BUY" ? "SHORT" : "LONG";
    return { action: `CLOSE POSITION ${closing}`, direction: closing === "LONG" ? "long" : "short", role: normalized.includes("REVERSE") || normalized.includes("OPPOSITE") ? "reversal" : "close" };
  }
  return side === "SELL"
    ? { action: "SHORT", direction: "short", role: "entry" }
    : { action: "LONG", direction: "long", role: "entry" };
}

function takeProfitLevel(value: string) {
  const match = value.match(/(?:\bTP|TAKE[_ ]?PROFIT)[_ :#-]*([1-7])\b/);
  return match ? Number(match[1]) : 0;
}

function actionColor(action: ExecutionDeskAction) {
  if (action.role === "takeProfit") return "#ffd166";
  if (action.role === "stopLoss") return "#ff174a";
  if (action.role === "close" || action.role === "reversal" || action.role === "exit") return "#d7dce5";
  return action.direction === "long" ? "#42f59b" : "#ff174a";
}

function epochSeconds(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1_000_000_000_000 ? value / 1000 : value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function nearestCandleIndex(times: readonly number[], target: number) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle]! < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low >= times.length) return times.length - 1;
  return Math.abs(times[low]! - target) < Math.abs(target - times[low - 1]!) ? low : low - 1;
}
