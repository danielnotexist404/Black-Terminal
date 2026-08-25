import type { Candle } from "../../../chart-engine/types.ts";
import type { CanonicalTrade } from "../../auction-profile/core/types.ts";
import type { DDAProFlowAuthority, DDAProFlowBarInput } from "../core/types.ts";

const EXACT_AGGRESSOR_SOURCES = new Set(["EXCHANGE_AGGRESSOR_FLAG", "MAKER_SIDE_INVERSION"]);

export type DDAProFlowInput = {
  flowBars: DDAProFlowBarInput[];
  cvdValues: number[];
  flowAuthority: DDAProFlowAuthority;
  flowWarning: string | null;
};

type BuildDDAProFlowInputOptions = {
  candles: readonly Candle[];
  trades: readonly CanonicalTrade[];
  timeframeSeconds: number;
  captureStartedAt: number | null;
  streamHealthy: boolean;
  consumerLabel?: string;
};

function emptyBar(time: number): DDAProFlowBarInput {
  return {
    time,
    buyVolume: 0,
    sellVolume: 0,
    unknownVolume: 0,
    buyNotional: 0,
    sellNotional: 0,
    unknownNotional: 0,
    exactTradeCount: 0,
    totalTradeCount: 0,
    deliveryComplete: false
  };
}

function candleIndexForTrade(candles: readonly Candle[], timestamp: number, timeframeSeconds: number) {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = candles[middle]?.time ?? 0;
    const end = candles[middle + 1]?.time ?? start + timeframeSeconds;
    if (timestamp < start) high = middle - 1;
    else if (timestamp >= end) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function buildDDAProFlowInput(options: BuildDDAProFlowInputOptions): DDAProFlowInput {
  const consumerLabel = options.consumerLabel?.trim() || "BC-RDA Flow Pressure";
  const timeframeSeconds = Math.max(1, Math.round(options.timeframeSeconds));
  const flowBars = options.candles.map((candle) => emptyBar(candle.time));
  const captureStartedAt = Number.isFinite(options.captureStartedAt) ? Number(options.captureStartedAt) : null;

  if (!options.streamHealthy || captureStartedAt === null) {
    return {
      flowBars,
      cvdValues: new Array(flowBars.length).fill(Number.NaN),
      flowAuthority: "UNAVAILABLE",
      flowWarning: `${consumerLabel} requires a healthy, continuous aggressor-trade stream. Polling and disconnected feeds are not treated as complete order flow.`
    };
  }

  for (const bar of flowBars) bar.deliveryComplete = bar.time >= captureStartedAt;

  for (const trade of options.trades) {
    if (!(Number.isFinite(trade.timestamp) && Number.isFinite(trade.price) && Number.isFinite(trade.quantity))) continue;
    if (!(trade.timestamp > 0 && trade.price > 0 && trade.quantity >= 0)) continue;
    const index = candleIndexForTrade(options.candles, trade.timestamp, timeframeSeconds);
    if (index < 0) continue;
    const bar = flowBars[index]!;
    const notional = Number.isFinite(trade.notional) && trade.notional >= 0 ? trade.notional : trade.price * trade.quantity;
    const exact = EXACT_AGGRESSOR_SOURCES.has(trade.source) && trade.aggressorSide !== "UNKNOWN";
    bar.totalTradeCount += 1;
    if (!exact) {
      bar.unknownVolume += trade.quantity;
      bar.unknownNotional += notional;
      continue;
    }
    bar.exactTradeCount += 1;
    if (trade.aggressorSide === "BUY") {
      bar.buyVolume += trade.quantity;
      bar.buyNotional += notional;
    } else {
      bar.sellVolume += trade.quantity;
      bar.sellNotional += notional;
    }
  }

  let cumulativeDelta = 0;
  const cvdValues = flowBars.map((bar) => {
    const directionalVolume = bar.buyVolume + bar.sellVolume;
    if (!bar.deliveryComplete || !(directionalVolume > 0)) return Number.NaN;
    cumulativeDelta += bar.buyVolume - bar.sellVolume;
    return cumulativeDelta;
  });
  const eligibleBars = flowBars.filter((bar) => bar.deliveryComplete && bar.buyNotional + bar.sellNotional > 0);
  return {
    flowBars,
    cvdValues,
    flowAuthority: eligibleBars.length ? "EXACT_AGGRESSOR_TRADES" : "UNAVAILABLE",
    flowWarning: eligibleBars.length
      ? "Live aggressor flow is session-scoped. Bars before continuous capture began remain unavailable; no synthetic historical flow was created."
      : `${consumerLabel} is warming until a complete bar interval contains genuine classified aggressor trades.`
  };
}
