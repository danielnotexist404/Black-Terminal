import type { Candle } from "../chart-engine/types";

export type StrategySide = "long" | "short";
export type StrategyQuantityMode = "fixed" | "cash" | "percent_of_equity";
export type StrategyCommissionMode = "percent" | "cash_per_order" | "cash_per_contract";
export type StrategyHistoricalFillMode = "tradingview" | "conservative";

export type StrategyRuntimeConfig = {
  initialCapital: number;
  defaultQuantityMode: StrategyQuantityMode;
  defaultQuantityValue: number;
  commissionMode: StrategyCommissionMode;
  commissionValue: number;
  slippageTicks: number;
  tickSize: number;
  pyramiding: number;
  processOrdersOnClose: boolean;
  historicalFillMode: StrategyHistoricalFillMode;
  useBarMagnifier: boolean;
};

export const defaultStrategyRuntimeConfig: StrategyRuntimeConfig = {
  initialCapital: 10_000,
  defaultQuantityMode: "percent_of_equity",
  defaultQuantityValue: 10,
  commissionMode: "percent",
  commissionValue: 0,
  slippageTicks: 0,
  tickSize: 0.01,
  pyramiding: 1,
  // Pine strategies apply a one-tick delay by default. On historical OHLC
  // bars this fills a market order at the following bar's open.
  processOrdersOnClose: false,
  // TradingView's default broker emulator models four historical ticks using
  // open -> high/low -> low/high -> close, selected by proximity to the open.
  historicalFillMode: "tradingview",
  useBarMagnifier: false
};

export type StrategyIntrabarSeries = readonly (readonly Candle[] | null | undefined)[];

export type StrategyNumberSeries = (number | null)[];

type StrategyInstructionBase = {
  id: string;
  when: boolean[];
  line: number;
};

export type StrategyEntryInstruction = StrategyInstructionBase & {
  kind: "entry";
  side: StrategySide;
  quantity?: StrategyNumberSeries;
  quantityPercent?: StrategyNumberSeries;
  limit?: StrategyNumberSeries;
  stop?: StrategyNumberSeries;
};

export type StrategyExitInstruction = StrategyInstructionBase & {
  kind: "exit";
  fromEntry?: string;
  quantity?: StrategyNumberSeries;
  quantityPercent?: StrategyNumberSeries;
  limit?: StrategyNumberSeries;
  stop?: StrategyNumberSeries;
  profitTicks?: StrategyNumberSeries;
  lossTicks?: StrategyNumberSeries;
  trailPrice?: StrategyNumberSeries;
  trailPoints?: StrategyNumberSeries;
  trailOffsetTicks?: StrategyNumberSeries;
};

export type StrategyCloseInstruction = StrategyInstructionBase & {
  kind: "close";
  fromEntry?: string;
  quantity?: StrategyNumberSeries;
  quantityPercent?: StrategyNumberSeries;
};

export type StrategyCancelInstruction = StrategyInstructionBase & {
  kind: "cancel";
  targetId?: string;
  cancelAll: boolean;
};

export type StrategyInstruction =
  | StrategyEntryInstruction
  | StrategyExitInstruction
  | StrategyCloseInstruction
  | StrategyCancelInstruction;

export type CompiledStrategyFill = {
  id: string;
  instructionId: string;
  entryId: string;
  lotUid: string;
  index: number;
  time: number;
  placedIndex: number;
  placedTime: number;
  action: "entry" | "exit";
  side: StrategySide;
  price: number;
  quantity: number;
  quantityMode: "fixed" | "cash" | "percent_of_equity" | "percent_of_position";
  quantityValue: number;
  commission: number;
  realizedPnl: number;
  reason: string;
};

export type CompiledStrategyPendingOrder = {
  key: string;
  instructionId: string;
  action: "entry" | "exit";
  entryId: string;
  lotUid: string | null;
  side: StrategySide;
  orderSide: "buy" | "sell";
  placedIndex: number;
  placedTime: number;
  quantity: number | null;
  quantityPercent: number | null;
  limit: number | null;
  stop: number | null;
  stopActivated: boolean;
  trailActivation: number | null;
  trailOffsetTicks: number | null;
  trailActivated: boolean;
  trailBestPrice: number | null;
  trailStop: number | null;
};

export type CompiledStrategyOpenLot = {
  uid: string;
  entryId: string;
  side: StrategySide;
  originalQuantity: number;
  remainingQuantity: number;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
};

export type StrategyRuntimeSnapshot = {
  schemaVersion: 1;
  realizedPnl: number;
  totalCommission: number;
  peakEquity: number;
  maxDrawdown: number;
  lotSequence: number;
  fillSequence: number;
  lots: (CompiledStrategyOpenLot & { remainingEntryCommission: number })[];
  pendingOrders: CompiledStrategyPendingOrder[];
  completedExitKeys: string[];
};

export type CompiledStrategyTrade = {
  id: string;
  entryId: string;
  side: StrategySide;
  quantity: number;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
  exitReason: string;
};

export type CompiledStrategyOpenPosition = {
  side: StrategySide;
  quantity: number;
  averagePrice: number;
  unrealizedPnl: number;
};

export type CompiledStrategyReport = {
  config: StrategyRuntimeConfig;
  times: number[];
  fills: CompiledStrategyFill[];
  trades: CompiledStrategyTrade[];
  equityCurve: StrategyNumberSeries;
  positionSize: StrategyNumberSeries;
  positionAveragePrice: StrategyNumberSeries;
  openProfit: StrategyNumberSeries;
  netProfit: StrategyNumberSeries;
  initialCapital: number;
  endingEquity: number;
  realizedNetProfit: number;
  totalCommission: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  maxDrawdown: number;
  openPosition: CompiledStrategyOpenPosition | null;
  openLots: CompiledStrategyOpenLot[];
  pendingOrders: CompiledStrategyPendingOrder[];
  checkpoint: StrategyRuntimeSnapshot;
};

type OpenLot = {
  uid: string;
  entryId: string;
  side: StrategySide;
  originalQuantity: number;
  remainingQuantity: number;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  remainingEntryCommission: number;
};

type PendingEntry = {
  instruction: StrategyEntryInstruction;
  placedIndex: number;
  placedTime: number;
  limit: number | null;
  stop: number | null;
  quantity: number | null;
  quantityPercent: number | null;
  market: boolean;
  stopActivated: boolean;
};

type PendingExit = {
  instruction: StrategyExitInstruction;
  lotUid: string;
  placedIndex: number;
  placedTime: number;
  limit: number | null;
  stop: number | null;
  quantity: number | null;
  quantityPercent: number | null;
  trailActivation: number | null;
  trailOffsetTicks: number | null;
  trailActivated: boolean;
  trailBestPrice: number | null;
  trailStop: number | null;
};

function finiteAt(series: StrategyNumberSeries | undefined, index: number): number | null {
  const value = series?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampNonNegative(value: number | null) {
  return value === null ? null : Math.max(0, value);
}

function sideSign(side: StrategySide) {
  return side === "long" ? 1 : -1;
}

function averagePositionPrice(lots: readonly OpenLot[]) {
  const quantity = lots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
  if (quantity <= 0) return 0;
  return lots.reduce((sum, lot) => sum + lot.entryPrice * lot.remainingQuantity, 0) / quantity;
}

function positionSize(lots: readonly OpenLot[]) {
  return lots.reduce((sum, lot) => sum + lot.remainingQuantity * sideSign(lot.side), 0);
}

function unrealizedProfit(lots: readonly OpenLot[], price: number) {
  return lots.reduce((sum, lot) => sum + (price - lot.entryPrice) * lot.remainingQuantity * sideSign(lot.side), 0);
}

function commissionFor(config: StrategyRuntimeConfig, price: number, quantity: number) {
  if (config.commissionMode === "cash_per_order") return config.commissionValue;
  if (config.commissionMode === "cash_per_contract") return config.commissionValue * quantity;
  return price * quantity * Math.max(0, config.commissionValue) / 100;
}

function slippedPrice(config: StrategyRuntimeConfig, price: number, side: StrategySide, action: "entry" | "exit") {
  const isBuy = (side === "long" && action === "entry") || (side === "short" && action === "exit");
  const direction = isBuy ? 1 : -1;
  return Math.max(config.tickSize, price + direction * config.slippageTicks * config.tickSize);
}

function entryTriggerPrice(order: PendingEntry, candle: Candle) {
  if (order.market) return candle.open;
  const { side } = order.instruction;
  if (order.stop !== null && order.limit !== null) {
    const stopTriggered = side === "long" ? candle.high >= order.stop : candle.low <= order.stop;
    if (!stopTriggered) return null;
    const limitTouched = candle.low <= order.limit && candle.high >= order.limit;
    return limitTouched ? order.limit : null;
  }
  if (order.stop !== null) {
    if (side === "long" && candle.high >= order.stop) return Math.max(candle.open, order.stop);
    if (side === "short" && candle.low <= order.stop) return Math.min(candle.open, order.stop);
    return null;
  }
  if (order.limit !== null) {
    if (side === "long" && candle.low <= order.limit) return Math.min(candle.open, order.limit);
    if (side === "short" && candle.high >= order.limit) return Math.max(candle.open, order.limit);
  }
  return null;
}

function crossedAscending(start: number, end: number, level: number) {
  return end >= start && level >= start && level <= end;
}

function crossedDescending(start: number, end: number, level: number) {
  return end <= start && level <= start && level >= end;
}

/** Resolve one monotonic broker-emulator price segment. */
function entryTriggerOnSegment(order: PendingEntry, start: number, end: number) {
  if (order.market) return start;
  const { side } = order.instruction;

  if (order.stop !== null && !order.stopActivated) {
    const stopAt = side === "long"
      ? start >= order.stop ? start : crossedAscending(start, end, order.stop) ? order.stop : null
      : start <= order.stop ? start : crossedDescending(start, end, order.stop) ? order.stop : null;
    if (stopAt === null) return null;
    order.stopActivated = true;
    if (order.limit === null) return stopAt;
    const marketableAtStop = side === "long" ? stopAt <= order.limit : stopAt >= order.limit;
    if (marketableAtStop) return stopAt;
    // A stop-limit order remains active after its stop is crossed. The limit
    // may fill on a later segment or lower-timeframe candle.
    return null;
  }

  if (order.limit !== null && (order.stop === null || order.stopActivated)) {
    if (side === "long") {
      if (start <= order.limit) return start;
      if (crossedDescending(start, end, order.limit)) return order.limit;
    } else {
      if (start >= order.limit) return start;
      if (crossedAscending(start, end, order.limit)) return order.limit;
    }
  }
  return null;
}

function effectiveExitStop(order: PendingExit, lot: OpenLot) {
  if (order.stop === null) return order.trailStop;
  if (order.trailStop === null) return order.stop;
  return lot.side === "long" ? Math.max(order.stop, order.trailStop) : Math.min(order.stop, order.trailStop);
}

function updateConservativeTrail(order: PendingExit, lot: OpenLot, candle: Candle, tickSize: number) {
  if (order.trailActivation === null || order.trailOffsetTicks === null) return;
  const activated = lot.side === "long" ? candle.high >= order.trailActivation : candle.low <= order.trailActivation;
  if (!order.trailActivated && !activated) return;
  order.trailActivated = true;
  const favorable = lot.side === "long" ? candle.high : candle.low;
  order.trailBestPrice = order.trailBestPrice === null
    ? favorable
    : lot.side === "long" ? Math.max(order.trailBestPrice, favorable) : Math.min(order.trailBestPrice, favorable);
  const distance = order.trailOffsetTicks * tickSize;
  order.trailStop = lot.side === "long" ? order.trailBestPrice - distance : order.trailBestPrice + distance;
}

function exitTrigger(order: PendingExit, lot: OpenLot, candle: Candle, tickSize: number) {
  updateConservativeTrail(order, lot, candle, tickSize);
  const effectiveStop = effectiveExitStop(order, lot);
  const stopHit = effectiveStop !== null && (lot.side === "long" ? candle.low <= effectiveStop : candle.high >= effectiveStop);
  const limitHit = order.limit !== null && (lot.side === "long" ? candle.high >= order.limit : candle.low <= order.limit);
  // A candle does not reveal the path between high and low. Stop-first is the
  // deterministic conservative assumption when both levels trade in one bar.
  if (stopHit) {
    return {
      price: lot.side === "long" ? Math.min(candle.open, effectiveStop!) : Math.max(candle.open, effectiveStop!),
      reason: `${order.instruction.id}:${order.trailStop !== null && effectiveStop === order.trailStop ? "TRAIL" : "STOP"}`
    };
  }
  if (limitHit) {
    return {
      price: lot.side === "long" ? Math.max(candle.open, order.limit!) : Math.min(candle.open, order.limit!),
      reason: `${order.instruction.id}:LIMIT`
    };
  }
  return null;
}

/** Resolve a bracket against one monotonic broker-emulator price segment. */
function exitTriggerOnSegment(order: PendingExit, lot: OpenLot, start: number, end: number, tickSize: number) {
  let trailActivatedMidSegment = false;
  if (order.trailActivation !== null && order.trailOffsetTicks !== null) {
    const activatesAtStart = lot.side === "long" ? start >= order.trailActivation : start <= order.trailActivation;
    const crossesActivation = lot.side === "long"
      ? crossedAscending(start, end, order.trailActivation)
      : crossedDescending(start, end, order.trailActivation);
    if (!order.trailActivated && (activatesAtStart || crossesActivation)) {
      order.trailActivated = true;
      order.trailBestPrice = activatesAtStart ? start : order.trailActivation;
      trailActivatedMidSegment = !activatesAtStart;
    }
    if (order.trailActivated) {
      order.trailBestPrice = order.trailBestPrice === null
        ? start
        : lot.side === "long" ? Math.max(order.trailBestPrice, start, end) : Math.min(order.trailBestPrice, start, end);
      const distance = order.trailOffsetTicks * tickSize;
      order.trailStop = lot.side === "long" ? order.trailBestPrice - distance : order.trailBestPrice + distance;
    }
  }
  const candidates: { price: number; reason: string; distance: number; priority: number }[] = [];
  // A newly activated trailing stop cannot be crossed earlier on the same
  // monotonic favorable segment. It becomes executable on the next segment.
  const effectiveStop = trailActivatedMidSegment ? order.stop : effectiveExitStop(order, lot);
  if (effectiveStop !== null) {
    const price = lot.side === "long"
      ? start <= effectiveStop ? start : crossedDescending(start, end, effectiveStop) ? effectiveStop : null
      : start >= effectiveStop ? start : crossedAscending(start, end, effectiveStop) ? effectiveStop : null;
    if (price !== null) candidates.push({
      price,
      reason: `${order.instruction.id}:${order.trailStop !== null && effectiveStop === order.trailStop ? "TRAIL" : "STOP"}`,
      distance: Math.abs(price - start),
      priority: 0
    });
  }
  if (order.limit !== null) {
    const price = lot.side === "long"
      ? start >= order.limit ? start : crossedAscending(start, end, order.limit) ? order.limit : null
      : start <= order.limit ? start : crossedDescending(start, end, order.limit) ? order.limit : null;
    if (price !== null) candidates.push({ price, reason: `${order.instruction.id}:LIMIT`, distance: Math.abs(price - start), priority: 1 });
  }
  candidates.sort((left, right) => left.distance - right.distance || left.priority - right.priority);
  return candidates[0] ?? null;
}

function validExecutionCandle(candle: Candle) {
  return Number.isFinite(candle.time)
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
}

function tradingViewPath(candle: Candle): Candle[] {
  const highFirst = Math.abs(candle.open - candle.high) < Math.abs(candle.open - candle.low);
  const points = highFirst
    ? [candle.open, candle.high, candle.low, candle.close]
    : [candle.open, candle.low, candle.high, candle.close];
  return points.slice(1).map((close, index) => {
    const open = points[index]!;
    return {
      time: candle.time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: candle.volume / 3
    };
  });
}

function executionSlices(input: {
  candle: Candle;
  intrabars?: readonly Candle[] | null;
  config: StrategyRuntimeConfig;
}) {
  if (input.config.historicalFillMode === "conservative") return [input.candle];
  const intrabars = input.config.useBarMagnifier
    ? [...(input.intrabars || [])].filter(validExecutionCandle).sort((left, right) => left.time - right.time)
    : [];
  if (intrabars.length) return intrabars.flatMap(tradingViewPath);
  return tradingViewPath(input.candle);
}

function resolvedQuantity(input: {
  explicitQuantity: number | null;
  explicitPercent: number | null;
  config: StrategyRuntimeConfig;
  equity: number;
  price: number;
}) {
  if (input.explicitQuantity !== null) return Math.max(0, input.explicitQuantity);
  if (input.explicitPercent !== null) return Math.max(0, input.equity * input.explicitPercent / 100 / input.price);
  if (input.config.defaultQuantityMode === "fixed") return Math.max(0, input.config.defaultQuantityValue);
  if (input.config.defaultQuantityMode === "cash") return Math.max(0, input.config.defaultQuantityValue / input.price);
  return Math.max(0, input.equity * input.config.defaultQuantityValue / 100 / input.price);
}

export function simulateStrategy(input: {
  candles: readonly Candle[];
  instructions: readonly StrategyInstruction[];
  config?: Partial<StrategyRuntimeConfig>;
  intrabars?: StrategyIntrabarSeries;
  initialState?: StrategyRuntimeSnapshot | null;
  executionStartIndex?: number;
  executionEndIndex?: number;
}): CompiledStrategyReport {
  const candles = input.candles;
  const config: StrategyRuntimeConfig = { ...defaultStrategyRuntimeConfig, ...input.config };
  const fills: CompiledStrategyFill[] = [];
  const trades: CompiledStrategyTrade[] = [];
  const equityCurve: StrategyNumberSeries = Array(candles.length).fill(null);
  const positionSizeSeries: StrategyNumberSeries = Array(candles.length).fill(0);
  const positionAveragePrice: StrategyNumberSeries = Array(candles.length).fill(0);
  const openProfitSeries: StrategyNumberSeries = Array(candles.length).fill(0);
  const netProfitSeries: StrategyNumberSeries = Array(candles.length).fill(0);
  const initialState = input.initialState?.schemaVersion === 1 ? input.initialState : null;
  const lots: OpenLot[] = (initialState?.lots || []).map((lot) => ({ ...lot }));
  const pendingEntries = new Map<string, PendingEntry>();
  const pendingExits = new Map<string, PendingExit>();
  for (const order of initialState?.pendingOrders || []) {
    if (order.action === "entry") {
      pendingEntries.set(order.instructionId, {
        instruction: { kind: "entry", id: order.instructionId, side: order.side, when: [], line: 0 },
        placedIndex: -1,
        placedTime: order.placedTime,
        limit: order.limit,
        stop: order.stop,
        quantity: order.quantity,
        quantityPercent: order.quantityPercent,
        market: order.limit === null && order.stop === null,
        stopActivated: order.stopActivated
      });
    } else if (order.lotUid) {
      pendingExits.set(order.key.replace(/^exit:/, ""), {
        instruction: { kind: "exit", id: order.instructionId, fromEntry: order.entryId, when: [], line: 0 },
        lotUid: order.lotUid,
        placedIndex: -1,
        placedTime: order.placedTime,
        limit: order.limit,
        stop: order.stop,
        quantity: order.quantity,
        quantityPercent: order.quantityPercent,
        trailActivation: order.trailActivation,
        trailOffsetTicks: order.trailOffsetTicks,
        trailActivated: order.trailActivated,
        trailBestPrice: order.trailBestPrice,
        trailStop: order.trailStop
      });
    }
  }
  const completedExitKeys = new Set<string>(initialState?.completedExitKeys || []);
  let realizedPnl = initialState?.realizedPnl ?? 0;
  let totalCommission = initialState?.totalCommission ?? 0;
  let lotSequence = initialState?.lotSequence ?? 0;
  let fillSequence = initialState?.fillSequence ?? 0;
  let peakEquity = initialState?.peakEquity ?? config.initialCapital;
  let maxDrawdown = initialState?.maxDrawdown ?? 0;
  const executionStartIndex = Math.max(0, Math.min(candles.length, Math.floor(input.executionStartIndex ?? 0)));
  const executionEndIndex = Math.max(-1, Math.min(candles.length - 1, Math.floor(input.executionEndIndex ?? candles.length - 1)));

  const currentEquity = (price: number) => config.initialCapital + realizedPnl - totalCommission + unrealizedProfit(lots, price);

  const removeClosedLots = () => {
    for (let index = lots.length - 1; index >= 0; index -= 1) {
      if (lots[index].remainingQuantity > 1e-12) continue;
      const uid = lots[index].uid;
      lots.splice(index, 1);
      for (const [key, order] of pendingExits) if (order.lotUid === uid) pendingExits.delete(key);
    }
  };

  const closeLot = (lot: OpenLot, requestedQuantity: number, rawPrice: number, index: number, instructionId: string, reason: string, executionTime = candles[index]!.time, placedIndex = index, placedTime = candles[index]!.time, quantityMode: CompiledStrategyFill["quantityMode"] = "percent_of_position", quantityValue = 100) => {
    const quantity = Math.min(lot.remainingQuantity, Math.max(0, requestedQuantity));
    if (!(quantity > 1e-12)) return;
    const price = slippedPrice(config, rawPrice, lot.side, "exit");
    const grossPnl = (price - lot.entryPrice) * quantity * sideSign(lot.side);
    const exitCommission = commissionFor(config, price, quantity);
    const entryCommission = lot.originalQuantity > 0
      ? Math.min(lot.remainingEntryCommission, lot.remainingEntryCommission * quantity / lot.remainingQuantity)
      : 0;
    lot.remainingEntryCommission -= entryCommission;
    lot.remainingQuantity -= quantity;
    realizedPnl += grossPnl;
    totalCommission += exitCommission;
    const fillId = `fill-${++fillSequence}`;
    fills.push({
      id: fillId,
      instructionId,
      entryId: lot.entryId,
      lotUid: lot.uid,
      index,
      time: executionTime,
      placedIndex,
      placedTime,
      action: "exit",
      side: lot.side,
      price,
      quantity,
      quantityMode,
      quantityValue,
      commission: exitCommission,
      realizedPnl: grossPnl,
      reason
    });
    trades.push({
      id: `trade-${trades.length + 1}`,
      entryId: lot.entryId,
      side: lot.side,
      quantity,
      entryIndex: lot.entryIndex,
      entryTime: lot.entryTime,
      entryPrice: lot.entryPrice,
      exitIndex: index,
      exitTime: executionTime,
      exitPrice: price,
      grossPnl,
      commission: entryCommission + exitCommission,
      netPnl: grossPnl - entryCommission - exitCommission,
      exitReason: reason
    });
  };

  const closeMatchingLots = (index: number, rawPrice: number, instructionId: string, reason: string, fromEntry?: string, quantity?: number | null, quantityPercent?: number | null, executionTime = candles[index]!.time) => {
    const eligible = lots.filter((lot) => !fromEntry || lot.entryId === fromEntry);
    let remainingExplicit = quantity;
    for (const lot of eligible) {
      const requested = remainingExplicit !== null && remainingExplicit !== undefined
        ? Math.min(lot.remainingQuantity, remainingExplicit)
        : quantityPercent !== null && quantityPercent !== undefined
          ? lot.originalQuantity * Math.max(0, quantityPercent) / 100
          : lot.remainingQuantity;
      const mode = remainingExplicit !== null && remainingExplicit !== undefined
        ? "fixed"
        : quantityPercent !== null && quantityPercent !== undefined
          ? "percent_of_position"
          : "percent_of_position";
      const value = mode === "fixed" ? requested : quantityPercent ?? 100;
      closeLot(lot, requested, rawPrice, index, instructionId, reason, executionTime, index, candles[index]!.time, mode, value);
      if (remainingExplicit !== null && remainingExplicit !== undefined) {
        remainingExplicit = Math.max(0, remainingExplicit - requested);
        if (remainingExplicit <= 1e-12) break;
      }
    }
    removeClosedLots();
  };

  const fillEntry = (order: PendingEntry, rawPrice: number, index: number, reason: string, executionTime = candles[index]!.time) => {
    const instruction = order.instruction;
    const oppositeLots = lots.filter((lot) => lot.side !== instruction.side);
    for (const lot of oppositeLots) closeLot(lot, lot.remainingQuantity, rawPrice, index, instruction.id, `REVERSE:${instruction.id}`, executionTime, order.placedIndex, order.placedTime, "percent_of_position", 100);
    removeClosedLots();
    const sameSideCount = lots.filter((lot) => lot.side === instruction.side).length;
    if (sameSideCount >= Math.max(1, config.pyramiding)) return;
    const price = slippedPrice(config, rawPrice, instruction.side, "entry");
    const equity = currentEquity(price);
    const quantity = resolvedQuantity({
      explicitQuantity: order.quantity,
      explicitPercent: order.quantityPercent,
      config,
      equity,
      price
    });
    if (!(quantity > 1e-12) || !Number.isFinite(quantity)) return;
    const quantityMode = order.quantity !== null
      ? "fixed"
      : order.quantityPercent !== null
        ? "percent_of_equity"
        : config.defaultQuantityMode;
    const quantityValue = order.quantity
      ?? order.quantityPercent
      ?? config.defaultQuantityValue;
    const commission = commissionFor(config, price, quantity);
    totalCommission += commission;
    const candle = candles[index];
    const lot: OpenLot = {
      uid: `${instruction.id}:${candle.time}:${++lotSequence}`,
      entryId: instruction.id,
      side: instruction.side,
      originalQuantity: quantity,
      remainingQuantity: quantity,
      entryIndex: index,
      entryTime: executionTime,
      entryPrice: price,
      remainingEntryCommission: commission
    };
    lots.push(lot);
    fills.push({
      id: `fill-${++fillSequence}`,
      instructionId: instruction.id,
      entryId: instruction.id,
      lotUid: lot.uid,
      index,
      time: executionTime,
      placedIndex: order.placedIndex,
      placedTime: order.placedTime,
      action: "entry",
      side: instruction.side,
      price,
      quantity,
      quantityMode,
      quantityValue,
      commission,
      realizedPnl: 0,
      reason
    });
  };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];

    if (index < executionStartIndex) {
      const openProfit = unrealizedProfit(lots, candle.close);
      equityCurve[index] = config.initialCapital + realizedPnl - totalCommission + openProfit;
      positionSizeSeries[index] = positionSize(lots);
      positionAveragePrice[index] = averagePositionPrice(lots);
      openProfitSeries[index] = openProfit;
      netProfitSeries[index] = realizedPnl - totalCommission;
      continue;
    }

    const slices = executionSlices({ candle, intrabars: input.intrabars?.[index], config });
    for (const executionCandle of slices) {
      // Resting protection has priority over new entries at an identical
      // broker-emulator tick. Each default slice is monotonic; magnifier mode
      // expands every supplied lower-timeframe candle into the same four-tick
      // path contract.
      for (const [key, pending] of [...pendingExits]) {
        if (pending.placedIndex >= index) continue;
        const lot = lots.find((candidate) => candidate.uid === pending.lotUid);
        if (!lot) {
          pendingExits.delete(key);
          continue;
        }
        const trigger = config.historicalFillMode === "conservative"
          ? exitTrigger(pending, lot, executionCandle, config.tickSize)
          : exitTriggerOnSegment(pending, lot, executionCandle.open, executionCandle.close, config.tickSize);
        if (!trigger) continue;
        const requested = pending.quantity !== null
          ? pending.quantity
          : pending.quantityPercent !== null
            ? lot.originalQuantity * pending.quantityPercent / 100
            : lot.remainingQuantity;
        const quantityMode = pending.quantity !== null ? "fixed" : "percent_of_position";
        const quantityValue = pending.quantity ?? pending.quantityPercent ?? 100;
        closeLot(lot, requested, trigger.price, index, pending.instruction.id, trigger.reason, executionCandle.time, pending.placedIndex, pending.placedTime, quantityMode, quantityValue);
        pendingExits.delete(key);
        completedExitKeys.add(key);
        removeClosedLots();
      }

      for (const [key, pending] of [...pendingEntries]) {
        if (pending.placedIndex >= index) continue;
        const trigger = config.historicalFillMode === "conservative"
          ? entryTriggerPrice(pending, executionCandle)
          : entryTriggerOnSegment(pending, executionCandle.open, executionCandle.close);
        if (trigger === null) continue;
        fillEntry(
          pending,
          trigger,
          index,
          `${pending.instruction.id}:${pending.market ? "MARKET" : pending.stop !== null ? "STOP" : "LIMIT"}`,
          executionCandle.time
        );
        pendingEntries.delete(key);
      }
    }

    if (index > executionEndIndex) {
      removeClosedLots();
      const openProfit = unrealizedProfit(lots, candle.close);
      const equity = config.initialCapital + realizedPnl - totalCommission + openProfit;
      peakEquity = Math.max(peakEquity, equity);
      if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity * 100);
      equityCurve[index] = equity;
      positionSizeSeries[index] = positionSize(lots);
      positionAveragePrice[index] = averagePositionPrice(lots);
      openProfitSeries[index] = openProfit;
      netProfitSeries[index] = realizedPnl - totalCommission;
      continue;
    }

    for (const instruction of input.instructions) {
      if (!instruction.when[index]) continue;
      if (instruction.kind === "cancel") {
        if (instruction.cancelAll) {
          pendingEntries.clear();
          pendingExits.clear();
        } else if (instruction.targetId) {
          pendingEntries.delete(instruction.targetId);
          for (const [key, order] of pendingExits) if (order.instruction.id === instruction.targetId) pendingExits.delete(key);
        }
        continue;
      }
      if (instruction.kind === "close") {
        closeMatchingLots(
          index,
          candle.close,
          instruction.id,
          `CLOSE:${instruction.id}`,
          instruction.fromEntry,
          finiteAt(instruction.quantity, index),
          finiteAt(instruction.quantityPercent, index)
        );
        continue;
      }
      if (instruction.kind === "entry") {
        const sameSideCount = lots.filter((lot) => lot.side === instruction.side).length;
        if (sameSideCount >= Math.max(1, config.pyramiding)) {
          pendingEntries.delete(instruction.id);
          continue;
        }
        const pending: PendingEntry = {
          instruction,
          placedIndex: index,
          placedTime: candle.time,
          limit: finiteAt(instruction.limit, index),
          stop: finiteAt(instruction.stop, index),
          quantity: clampNonNegative(finiteAt(instruction.quantity, index)),
          quantityPercent: clampNonNegative(finiteAt(instruction.quantityPercent, index)),
          market: false,
          stopActivated: false
        };
        if (pending.limit === null && pending.stop === null) {
          if (config.processOrdersOnClose) fillEntry(pending, candle.close, index, `MARKET:${instruction.id}`);
          else pendingEntries.set(instruction.id, { ...pending, market: true });
        } else pendingEntries.set(instruction.id, pending);
        continue;
      }
      for (const lot of lots) {
        if (instruction.fromEntry && lot.entryId !== instruction.fromEntry) continue;
        const key = `${instruction.id}:${lot.uid}`;
        if (completedExitKeys.has(key)) continue;
        const profitTicks = finiteAt(instruction.profitTicks, index);
        const lossTicks = finiteAt(instruction.lossTicks, index);
        const explicitLimit = finiteAt(instruction.limit, index);
        const explicitStop = finiteAt(instruction.stop, index);
        const trailPrice = finiteAt(instruction.trailPrice, index);
        const trailPoints = finiteAt(instruction.trailPoints, index);
        const trailOffsetTicks = clampNonNegative(finiteAt(instruction.trailOffsetTicks, index));
        const limit = explicitLimit ?? (profitTicks === null ? null : lot.entryPrice + sideSign(lot.side) * profitTicks * config.tickSize);
        const stop = explicitStop ?? (lossTicks === null ? null : lot.entryPrice - sideSign(lot.side) * lossTicks * config.tickSize);
        const trailActivation = trailOffsetTicks === null
          ? null
          : trailPrice ?? (trailPoints === null ? null : lot.entryPrice + sideSign(lot.side) * trailPoints * config.tickSize);
        if (limit === null && stop === null && trailActivation === null) {
          closeMatchingLots(
            index,
            candle.close,
            instruction.id,
            `EXIT:${instruction.id}`,
            lot.entryId,
            finiteAt(instruction.quantity, index),
            finiteAt(instruction.quantityPercent, index)
          );
          completedExitKeys.add(key);
          continue;
        }
        pendingExits.set(key, {
          instruction,
          lotUid: lot.uid,
          placedIndex: index,
          placedTime: candle.time,
          limit,
          stop,
          quantity: clampNonNegative(finiteAt(instruction.quantity, index)),
          quantityPercent: clampNonNegative(finiteAt(instruction.quantityPercent, index)),
          trailActivation,
          trailOffsetTicks,
          trailActivated: false,
          trailBestPrice: null,
          trailStop: null
        });
      }
    }

    removeClosedLots();
    const openProfit = unrealizedProfit(lots, candle.close);
    const equity = config.initialCapital + realizedPnl - totalCommission + openProfit;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity * 100);
    equityCurve[index] = equity;
    positionSizeSeries[index] = positionSize(lots);
    positionAveragePrice[index] = averagePositionPrice(lots);
    openProfitSeries[index] = openProfit;
    netProfitSeries[index] = realizedPnl - totalCommission;
  }

  const endingPrice = candles.at(-1)?.close ?? 0;
  const endingEquity = config.initialCapital + realizedPnl - totalCommission + unrealizedProfit(lots, endingPrice);
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const losses = trades.filter((trade) => trade.netPnl < 0).length;
  const openQuantity = Math.abs(positionSize(lots));
  const openSide = positionSize(lots) >= 0 ? "long" : "short";

  const pendingOrders: CompiledStrategyPendingOrder[] = [
    ...[...pendingEntries.entries()].map(([key, order]): CompiledStrategyPendingOrder => ({
      key: `entry:${key}`,
      instructionId: order.instruction.id,
      action: "entry",
      entryId: order.instruction.id,
      lotUid: null,
      side: order.instruction.side,
      orderSide: order.instruction.side === "long" ? "buy" : "sell",
      placedIndex: order.placedIndex,
      placedTime: order.placedTime,
      quantity: order.quantity,
      quantityPercent: order.quantityPercent,
      limit: order.limit,
      stop: order.stop,
      stopActivated: order.stopActivated,
      trailActivation: null,
      trailOffsetTicks: null,
      trailActivated: false,
      trailBestPrice: null,
      trailStop: null
    })),
    ...[...pendingExits.entries()].flatMap(([key, order]): CompiledStrategyPendingOrder[] => {
      const lot = lots.find((candidate) => candidate.uid === order.lotUid);
      if (!lot) return [];
      return [{
        key: `exit:${key}`,
        instructionId: order.instruction.id,
        action: "exit",
        entryId: lot.entryId,
        lotUid: lot.uid,
        side: lot.side,
        orderSide: lot.side === "long" ? "sell" : "buy",
        placedIndex: order.placedIndex,
        placedTime: order.placedTime,
        quantity: order.quantity,
        quantityPercent: order.quantityPercent,
        limit: order.limit,
        stop: order.stop,
        stopActivated: false,
        trailActivation: order.trailActivation,
        trailOffsetTicks: order.trailOffsetTicks,
        trailActivated: order.trailActivated,
        trailBestPrice: order.trailBestPrice,
        trailStop: order.trailStop
      }];
    })
  ];
  const openLots = lots.map((lot) => ({
    uid: lot.uid,
    entryId: lot.entryId,
    side: lot.side,
    originalQuantity: lot.originalQuantity,
    remainingQuantity: lot.remainingQuantity,
    entryIndex: lot.entryIndex,
    entryTime: lot.entryTime,
    entryPrice: lot.entryPrice
  }));

  return {
    config,
    times: candles.map((candle) => candle.time),
    fills,
    trades,
    equityCurve,
    positionSize: positionSizeSeries,
    positionAveragePrice,
    openProfit: openProfitSeries,
    netProfit: netProfitSeries,
    initialCapital: config.initialCapital,
    endingEquity,
    realizedNetProfit: realizedPnl - totalCommission,
    totalCommission,
    totalTrades: trades.length,
    winningTrades: wins,
    losingTrades: losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    maxDrawdown,
    openPosition: openQuantity > 1e-12 ? {
      side: openSide,
      quantity: openQuantity,
      averagePrice: averagePositionPrice(lots),
      unrealizedPnl: unrealizedProfit(lots, endingPrice)
    } : null,
    openLots,
    pendingOrders,
    checkpoint: {
      schemaVersion: 1,
      realizedPnl,
      totalCommission,
      peakEquity,
      maxDrawdown,
      lotSequence,
      fillSequence,
      lots: lots.map((lot) => ({ ...lot })),
      pendingOrders,
      completedExitKeys: [...completedExitKeys].filter((key) => lots.some((lot) => key.endsWith(`:${lot.uid}`)))
    }
  };
}
