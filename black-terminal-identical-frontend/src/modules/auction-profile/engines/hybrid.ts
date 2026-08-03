import type { AuctionProfileRow, HybridAuctionWeights } from "../core/types.ts";

function normalized(value: number, maximum: number) {
  return maximum > 0 ? value / maximum : 0;
}

export function applyHybridScores(rows: AuctionProfileRow[], weights: HybridAuctionWeights) {
  const maxima = {
    volume: Math.max(...rows.map(row => row.totalQuantity), 0),
    cvd: Math.max(...rows.map(row => Math.abs(row.buyQuantity - row.sellQuantity)), 0),
    efficiency: Math.max(...rows.map(row => Math.abs(row.cvdEfficiency)), 0),
    tpo: Math.max(...rows.map(row => row.tpoCount), 0),
    realized: Math.max(...rows.map(row => row.realizedVariance), 0),
    parkinson: Math.max(...rows.map(row => row.parkinsonVariance), 0),
    trades: Math.max(...rows.map(row => row.tradeCount), 0),
    notional: Math.max(...rows.map(row => row.buyNotional + row.sellNotional + row.unknownNotional), 0)
  };
  const weightTotal = Math.max(Number.EPSILON, Object.values(weights).reduce((sum, value) => sum + value, 0));
  rows.forEach(row => {
    row.hybridScore = (
      normalized(row.totalQuantity, maxima.volume) * weights.volume +
      normalized(Math.abs(row.buyQuantity - row.sellQuantity), maxima.cvd) * weights.cvd +
      normalized(Math.abs(row.cvdEfficiency), maxima.efficiency) * weights.cvdEfficiency +
      normalized(row.tpoCount, maxima.tpo) * weights.tpo +
      normalized(row.realizedVariance, maxima.realized) * weights.realizedVolatility +
      normalized(row.parkinsonVariance, maxima.parkinson) * weights.parkinsonVolatility +
      normalized(row.tradeCount, maxima.trades) * weights.tradeCount +
      normalized(row.buyNotional + row.sellNotional + row.unknownNotional, maxima.notional) * weights.notional
    ) / weightTotal;
  });
}
