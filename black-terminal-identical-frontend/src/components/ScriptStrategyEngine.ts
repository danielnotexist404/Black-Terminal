import type { Candle } from "../chart-engine/types";

export type StrategySide = "long" | "short";
export type StrategyQuantityMode = "fixed" | "cash" | "percent_of_equity";
export type StrategyCommissionMode = "percent" | "cash_per_order" | "cash_per_contract";

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
  processOrdersOnClose: true
};

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
  index: number;
  time: number;
  action: "entry" | "exit";
  side: StrategySide;
  price: number;
  quantity: number;
  commission: number;
  realizedPnl: number;
  reason: string;
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
  limit: number | null;
  stop: number | null;
  quantity: number | null;
  quantityPercent: number | null;
  market: boolean;
};

type PendingExit = {
  instruction: StrategyExitInstruction;
  lotUid: string;
  placedIndex: number;
  limit: number | null;
  stop: number | null;
  quantity: number | null;
  quantityPercent: number | null;
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

function exitTrigger(order: PendingExit, lot: OpenLot, candle: Candle) {
  const stopHit = order.stop !== null && (lot.side === "long" ? candle.low <= order.stop : candle.high >= order.stop);
  const limitHit = order.limit !== null && (lot.side === "long" ? candle.high >= order.limit : candle.low <= order.limit);
  // A candle does not reveal the path between high and low. Stop-first is the
  // deterministic conservative assumption when both levels trade in one bar.
  if (stopHit) {
    return {
      price: lot.side === "long" ? Math.min(candle.open, order.stop!) : Math.max(candle.open, order.stop!),
      reason: `${order.instruction.id}:STOP`
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
  const lots: OpenLot[] = [];
  const pendingEntries = new Map<string, PendingEntry>();
  const pendingExits = new Map<string, PendingExit>();
  const completedExitKeys = new Set<string>();
  let realizedPnl = 0;
  let totalCommission = 0;
  let lotSequence = 0;
  let fillSequence = 0;
  let peakEquity = config.initialCapital;
  let maxDrawdown = 0;

  const currentEquity = (price: number) => config.initialCapital + realizedPnl - totalCommission + unrealizedProfit(lots, price);

  const removeClosedLots = () => {
    for (let index = lots.length - 1; index >= 0; index -= 1) {
      if (lots[index].remainingQuantity > 1e-12) continue;
      const uid = lots[index].uid;
      lots.splice(index, 1);
      for (const [key, order] of pendingExits) if (order.lotUid === uid) pendingExits.delete(key);
    }
  };

  const closeLot = (lot: OpenLot, requestedQuantity: number, rawPrice: number, index: number, instructionId: string, reason: string) => {
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
    const candle = candles[index];
    const fillId = `fill-${++fillSequence}`;
    fills.push({
      id: fillId,
      instructionId,
      entryId: lot.entryId,
      index,
      time: candle.time,
      action: "exit",
      side: lot.side,
      price,
      quantity,
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
      exitTime: candle.time,
      exitPrice: price,
      grossPnl,
      commission: entryCommission + exitCommission,
      netPnl: grossPnl - entryCommission - exitCommission,
      exitReason: reason
    });
  };

  const closeMatchingLots = (index: number, rawPrice: number, instructionId: string, reason: string, fromEntry?: string, quantity?: number | null, quantityPercent?: number | null) => {
    const eligible = lots.filter((lot) => !fromEntry || lot.entryId === fromEntry);
    let remainingExplicit = quantity;
    for (const lot of eligible) {
      const requested = remainingExplicit !== null && remainingExplicit !== undefined
        ? Math.min(lot.remainingQuantity, remainingExplicit)
        : quantityPercent !== null && quantityPercent !== undefined
          ? lot.originalQuantity * Math.max(0, quantityPercent) / 100
          : lot.remainingQuantity;
      closeLot(lot, requested, rawPrice, index, instructionId, reason);
      if (remainingExplicit !== null && remainingExplicit !== undefined) {
        remainingExplicit = Math.max(0, remainingExplicit - requested);
        if (remainingExplicit <= 1e-12) break;
      }
    }
    removeClosedLots();
  };

  const fillEntry = (order: PendingEntry, rawPrice: number, index: number, reason: string) => {
    const instruction = order.instruction;
    const oppositeLots = lots.filter((lot) => lot.side !== instruction.side);
    for (const lot of oppositeLots) closeLot(lot, lot.remainingQuantity, rawPrice, index, instruction.id, `REVERSE:${instruction.id}`);
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
      entryTime: candle.time,
      entryPrice: price,
      remainingEntryCommission: commission
    };
    lots.push(lot);
    fills.push({
      id: `fill-${++fillSequence}`,
      instructionId: instruction.id,
      entryId: instruction.id,
      index,
      time: candle.time,
      action: "entry",
      side: instruction.side,
      price,
      quantity,
      commission,
      realizedPnl: 0,
      reason
    });
  };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];

    // Resting protective orders are processed before entries. If a candle
    // touches both stop and target, exitTrigger deliberately chooses the stop.
    for (const [key, pending] of [...pendingExits]) {
      if (pending.placedIndex >= index) continue;
      const lot = lots.find((candidate) => candidate.uid === pending.lotUid);
      if (!lot) {
        pendingExits.delete(key);
        continue;
      }
      const trigger = exitTrigger(pending, lot, candle);
      if (!trigger) continue;
      const requested = pending.quantity !== null
        ? pending.quantity
        : pending.quantityPercent !== null
          ? lot.originalQuantity * pending.quantityPercent / 100
          : lot.remainingQuantity;
      closeLot(lot, requested, trigger.price, index, pending.instruction.id, trigger.reason);
      pendingExits.delete(key);
      completedExitKeys.add(key);
      removeClosedLots();
    }

    for (const [key, pending] of [...pendingEntries]) {
      if (pending.placedIndex >= index) continue;
      const trigger = entryTriggerPrice(pending, candle);
      if (trigger === null) continue;
      fillEntry(pending, trigger, index, `${pending.instruction.id}:${pending.stop !== null ? "STOP" : "LIMIT"}`);
      pendingEntries.delete(key);
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
        const pending: PendingEntry = {
          instruction,
          placedIndex: index,
          limit: finiteAt(instruction.limit, index),
          stop: finiteAt(instruction.stop, index),
          quantity: clampNonNegative(finiteAt(instruction.quantity, index)),
          quantityPercent: clampNonNegative(finiteAt(instruction.quantityPercent, index)),
          market: false
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
        const limit = explicitLimit ?? (profitTicks === null ? null : lot.entryPrice + sideSign(lot.side) * profitTicks * config.tickSize);
        const stop = explicitStop ?? (lossTicks === null ? null : lot.entryPrice - sideSign(lot.side) * lossTicks * config.tickSize);
        if (limit === null && stop === null) {
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
          limit,
          stop,
          quantity: clampNonNegative(finiteAt(instruction.quantity, index)),
          quantityPercent: clampNonNegative(finiteAt(instruction.quantityPercent, index))
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
    } : null
  };
}
