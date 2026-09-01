import type { Candle } from "../../../chart-engine/types.ts";
import {
  compileAndRunScript,
  type ScriptInputValue,
} from "../../../components/ScriptCompiler.ts";
import type {
  CompiledStrategyFill,
  CompiledStrategyPendingOrder,
  CompiledStrategyReport,
  StrategyIntrabarSeries,
  StrategyRuntimeConfig,
  StrategyRuntimeSnapshot,
} from "../../../components/ScriptStrategyEngine.ts";

export const BLACK_SCRIPT_CLOUD_CHECKPOINT_VERSION = 1 as const;

export type BlackScriptCloudCheckpoint = {
  schemaVersion: typeof BLACK_SCRIPT_CLOUD_CHECKPOINT_VERSION;
  runtimeVersion: "black-script-v3";
  sourceVersion: string;
  settingsVersion: string;
  lastClosedCandleTime: number;
  processedFillKeys: string[];
  desiredOrderFingerprints: Record<string, string>;
  brokerOrderFingerprints?: Record<string, string>;
  brokerOrderHandles?: Record<string, { placeIdempotencyKey: string; commandType: "PLACE_ORDER" | "PLACE_PROTECTION" }>;
  engine: StrategyRuntimeSnapshot;
};

export type BlackScriptMarketAction = {
  key: string;
  action: "ENTRY" | "CLOSE" | "REVERSE";
  instructionId: string;
  direction: "long" | "short";
  positionDirection: "long" | "short" | null;
  quantity: number;
  quantityMode: CompiledStrategyFill["quantityMode"];
  quantityValue: number;
  placedTime: number;
  executionTime: number;
  referencePrice: number;
};

export type BlackScriptDesiredOrder = CompiledStrategyPendingOrder & {
  fingerprint: string;
};

export type BlackScriptExpectedOrderFill = {
  key: string;
  logicalOrderKey: string;
  action: "entry" | "exit";
  side: "long" | "short";
  quantity: number;
  executionTime: number;
  executionPrice: number;
  reason: string;
};

export type BlackScriptCloudEvaluation = {
  sourceVersion: string;
  settingsVersion: string;
  latestClosedCandleTime: number;
  marketActions: BlackScriptMarketAction[];
  desiredOrders: BlackScriptDesiredOrder[];
  expectedOrderFills: BlackScriptExpectedOrderFill[];
  retiredOrderKeys: string[];
  paperReport?: Pick<CompiledStrategyReport,
    | "fills"
    | "trades"
    | "endingEquity"
    | "realizedNetProfit"
    | "totalCommission"
    | "totalTrades"
    | "winningTrades"
    | "losingTrades"
    | "winRate"
    | "maxDrawdown"
    | "openPosition"
    | "openLots"
    | "pendingOrders"
  >;
  checkpoint: BlackScriptCloudCheckpoint;
};

export type BlackScriptCloudEvaluationRequest = {
  source: string;
  expectedSourceVersion: string;
  settings: Readonly<Record<string, ScriptInputValue>>;
  closedCandles: readonly Candle[];
  currentCandle?: Candle | null;
  checkpoint?: BlackScriptCloudCheckpoint | null;
  runtimeConfig?: Partial<StrategyRuntimeConfig>;
  intrabars?: StrategyIntrabarSeries;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((output, key) => {
    output[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return output;
  }, {});
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Matches the immutable version identity stored by ownedCustomIndicatorInstances. */
export function blackScriptOwnedSourceVersion(source: string) {
  return fnv1a(JSON.stringify(source));
}

export function blackScriptSettingsVersion(settings: Readonly<Record<string, ScriptInputValue>>) {
  return fnv1a(JSON.stringify(canonicalValue(settings)));
}

/**
 * Conservative cloud-runtime eligibility gate. The VPS calls this again from
 * immutable source; browser metadata alone never certifies execution.
 */
export function isBlackScriptV3CloudEligibleSource(
  source: string,
  inputValues: Readonly<Record<string, unknown>> = {},
) {
  const text = String(source || "");
  const flat = text.replace(/\s+/g, " ");
  if (!/\bstrategy\s*\(/i.test(flat)
    || /\b(?:request\.)?security\s*\(/i.test(flat)
    || /\bcalc_on_every_tick\s*=\s*true\b/i.test(flat)
    || /strategy\.exit\s*\([^)]*(?:trail_price|trail_points|trail_offset)[^)]*(?:qty|qty_percent)\s*=/i.test(flat)
    || /strategy\.exit\s*\([^)]*(?:qty|qty_percent)\s*=[^)]*(?:trail_price|trail_points|trail_offset)/i.test(flat)) {
    return false;
  }
  const candles = Array.from({ length: 256 }, (_, index) => {
    const open = 100 + index * 0.05;
    const close = open + (index % 2 === 0 ? 0.4 : -0.25);
    return {
      time: 1_900_000_000 + index * 60,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + index,
    };
  });
  const values = Object.fromEntries(Object.entries(inputValues)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, ScriptInputValue>;
  const compiled = compileAndRunScript(text, candles, values);
  return compiled.success && Boolean(compiled.strategy);
}

function stableIdentity(value: unknown) {
  return fnv1a(JSON.stringify(canonicalValue(value)));
}

function fillKey(sourceVersion: string, fill: CompiledStrategyFill) {
  return [
    sourceVersion,
    fill.action,
    fill.instructionId,
    fill.side,
    fill.placedTime,
    fill.time,
    fill.quantity.toFixed(12),
    fill.quantityMode,
    fill.quantityValue.toFixed(12),
    fill.reason,
  ].join(":");
}

function logicalOrderKey(fill: CompiledStrategyFill) {
  if (fill.action === "entry") return `entry:${fill.instructionId}`;
  const suffix = fill.reason.endsWith(":LIMIT")
    ? ":limit"
    : fill.reason.endsWith(":STOP")
      ? ":stop"
      : fill.reason.endsWith(":TRAIL")
        ? ":protection"
        : "";
  return `exit:${fill.instructionId}:${fill.lotUid}${suffix}`;
}

function isRestingOrderFill(fill: CompiledStrategyFill) {
  return /:(?:LIMIT|STOP|TRAIL)$/.test(fill.reason);
}

function normalizeCurrentCandle(current: Candle | null | undefined, latestClosed: Candle) {
  if (!current || !Number.isFinite(current.time) || current.time <= latestClosed.time || !Number.isFinite(current.open) || current.open <= 0) return null;
  return {
    time: current.time,
    open: current.open,
    high: current.open,
    low: current.open,
    close: current.open,
    volume: 0,
  } satisfies Candle;
}

function actionKey(sourceVersion: string, fills: readonly CompiledStrategyFill[]) {
  return `${sourceVersion}:market:${stableIdentity(fills.map((fill) => fillKey(sourceVersion, fill)))}`;
}

function marketActions(sourceVersion: string, fills: readonly CompiledStrategyFill[]) {
  const marketFills = fills.filter((fill) => !isRestingOrderFill(fill));
  const used = new Set<string>();
  const actions: BlackScriptMarketAction[] = [];
  for (const fill of marketFills) {
    const identity = fillKey(sourceVersion, fill);
    if (used.has(identity)) continue;
    if (fill.action === "entry") {
      const reversalExit = marketFills.find((candidate) =>
        candidate.action === "exit"
        && candidate.instructionId === fill.instructionId
        && candidate.placedTime === fill.placedTime
        && candidate.time === fill.time
        && candidate.reason.startsWith("REVERSE:"));
      const grouped = reversalExit ? [reversalExit, fill] : [fill];
      grouped.forEach((candidate) => used.add(fillKey(sourceVersion, candidate)));
      actions.push({
        key: actionKey(sourceVersion, grouped),
        action: reversalExit ? "REVERSE" : "ENTRY",
        instructionId: fill.instructionId,
        direction: fill.side,
        positionDirection: reversalExit?.side ?? null,
        quantity: fill.quantity,
        quantityMode: fill.quantityMode,
        quantityValue: fill.quantityValue,
        placedTime: fill.placedTime,
        executionTime: fill.time,
        referencePrice: fill.price,
      });
      continue;
    }
    if (fill.reason.startsWith("REVERSE:") && marketFills.some((candidate) =>
      candidate.action === "entry"
      && candidate.instructionId === fill.instructionId
      && candidate.placedTime === fill.placedTime
      && candidate.time === fill.time)) {
      continue;
    }
    used.add(identity);
    actions.push({
      key: actionKey(sourceVersion, [fill]),
      action: "CLOSE",
      instructionId: fill.instructionId,
      direction: fill.side,
      positionDirection: fill.side,
      quantity: fill.quantity,
      quantityMode: fill.quantityMode,
      quantityValue: fill.quantityValue,
      placedTime: fill.placedTime,
      executionTime: fill.time,
      referencePrice: fill.price,
    });
  }
  return actions;
}

/**
 * Evaluate one closed-candle Black Cloud generation without touching a broker.
 * The caller must durably enqueue/reconcile every returned intent before it
 * commits the returned checkpoint.
 */
export function evaluateBlackScriptCloudRuntime(request: BlackScriptCloudEvaluationRequest): BlackScriptCloudEvaluation {
  if (request.closedCandles.length < 2) throw new Error("BLACK_SCRIPT_CLOUD_HISTORY_INSUFFICIENT");
  const sourceVersion = blackScriptOwnedSourceVersion(request.source);
  if (sourceVersion !== request.expectedSourceVersion) throw new Error("BLACK_SCRIPT_SOURCE_VERSION_MISMATCH");
  const settingsVersion = blackScriptSettingsVersion(request.settings);
  const previous = request.checkpoint || null;
  if (previous && (previous.schemaVersion !== BLACK_SCRIPT_CLOUD_CHECKPOINT_VERSION
    || previous.runtimeVersion !== "black-script-v3"
    || previous.sourceVersion !== sourceVersion
    || previous.settingsVersion !== settingsVersion)) {
    throw new Error("BLACK_SCRIPT_CHECKPOINT_VERSION_MISMATCH");
  }

  const closed = [...request.closedCandles].sort((left, right) => left.time - right.time);
  const latestClosed = closed.at(-1)!;
  if (previous && latestClosed.time < previous.lastClosedCandleTime) throw new Error("BLACK_SCRIPT_CANDLE_REGRESSION");
  const current = normalizeCurrentCandle(request.currentCandle, latestClosed);
  const candles = current ? [...closed, current] : closed;
  const firstExecutable = previous
    ? closed.findIndex((candle) => candle.time > previous.lastClosedCandleTime)
    : closed.length - 1;
  const executionStartIndex = firstExecutable < 0 ? closed.length : firstExecutable;
  const compiled = compileAndRunScript(request.source, candles, request.settings, {
    runtimeConfig: request.runtimeConfig,
    intrabars: request.intrabars,
    initialState: previous?.engine,
    executionStartIndex,
    executionEndIndex: closed.length - 1,
  });
  if (!compiled.success) {
    throw new Error(`BLACK_SCRIPT_COMPILE_FAILED:${compiled.errors.map((error) => `${error.line}:${error.message}`).join("|")}`);
  }
  if (!compiled.strategy) throw new Error("BLACK_SCRIPT_STRATEGY_REQUIRED");

  const processed = new Set(previous?.processedFillKeys || []);
  const newFills = compiled.strategy.fills.filter((fill) => {
    const key = fillKey(sourceVersion, fill);
    if (processed.has(key)) return false;
    processed.add(key);
    return true;
  });
  const desiredOrders = compiled.strategy.pendingOrders
    .filter((order) => order.placedTime <= latestClosed.time)
    .map((order): BlackScriptDesiredOrder => ({
      ...order,
      fingerprint: stableIdentity({
        action: order.action,
        side: order.side,
        quantity: order.quantity,
        quantityPercent: order.quantityPercent,
        limit: order.limit,
        stop: order.stop,
        trailActivation: order.trailActivation,
        trailOffsetTicks: order.trailOffsetTicks,
        trailStop: order.trailStop,
      }),
    }));
  const desiredOrderFingerprints = Object.fromEntries(desiredOrders.map((order) => [order.key, order.fingerprint]));
  const retiredOrderKeys = Object.keys(previous?.desiredOrderFingerprints || {}).filter((key) => !(key in desiredOrderFingerprints));
  const expectedOrderFills = newFills.filter(isRestingOrderFill).map((fill): BlackScriptExpectedOrderFill => ({
    key: fillKey(sourceVersion, fill),
    logicalOrderKey: logicalOrderKey(fill),
    action: fill.action,
    side: fill.side,
    quantity: fill.quantity,
    executionTime: fill.time,
    executionPrice: fill.price,
    reason: fill.reason,
  }));

  return {
    sourceVersion,
    settingsVersion,
    latestClosedCandleTime: latestClosed.time,
    marketActions: marketActions(sourceVersion, newFills),
    desiredOrders,
    expectedOrderFills,
    retiredOrderKeys,
    paperReport: {
      fills: compiled.strategy.fills,
      trades: compiled.strategy.trades,
      endingEquity: compiled.strategy.endingEquity,
      realizedNetProfit: compiled.strategy.realizedNetProfit,
      totalCommission: compiled.strategy.totalCommission,
      totalTrades: compiled.strategy.totalTrades,
      winningTrades: compiled.strategy.winningTrades,
      losingTrades: compiled.strategy.losingTrades,
      winRate: compiled.strategy.winRate,
      maxDrawdown: compiled.strategy.maxDrawdown,
      openPosition: compiled.strategy.openPosition,
      openLots: compiled.strategy.openLots,
      pendingOrders: compiled.strategy.pendingOrders,
    },
    checkpoint: {
      schemaVersion: BLACK_SCRIPT_CLOUD_CHECKPOINT_VERSION,
      runtimeVersion: "black-script-v3",
      sourceVersion,
      settingsVersion,
      lastClosedCandleTime: latestClosed.time,
      processedFillKeys: [...processed].slice(-2_048),
      desiredOrderFingerprints,
      brokerOrderFingerprints: previous?.brokerOrderFingerprints || {},
      brokerOrderHandles: previous?.brokerOrderHandles || {},
      engine: compiled.strategy.checkpoint,
    },
  };
}
