import type {
  CanonicalCluster,
  CanonicalNearest,
  CanonicalRatioModel,
  ClusterSide
} from "./canonical.ts";

export function nearestFromCluster(
  cluster: CanonicalCluster | undefined,
  typicalMove: number | null,
  activeSideTotal: number
): CanonicalNearest | null {
  if (!cluster) return null;
  return {
    clusterId: cluster.id,
    price: cluster.price,
    signedVolume: cluster.signedVolume,
    typicalMove,
    activeSidePercent:
      activeSideTotal === 0 ? null : (Math.abs(cluster.signedVolume) / Math.abs(activeSideTotal)) * 100
  };
}

export function ratioModel(values: {
  activeBuy: number;
  activeSell: number;
  violatedBuy: number;
  violatedSell: number;
}): CanonicalRatioModel {
  const activeBuyStops = Math.abs(values.activeBuy);
  const activeSellStops = Math.abs(values.activeSell);
  const violatedBuyStops = Math.abs(values.violatedBuy);
  const violatedSellStops = Math.abs(values.violatedSell);
  let activeBuyBlocks: number | null;
  let activeSellBlocks: number | null;
  if (activeBuyStops === 0 && activeSellStops === 0) {
    activeBuyBlocks = 10;
    activeSellBlocks = 10;
  } else {
    const minimum = Math.min(activeBuyStops, activeSellStops);
    const dominance =
      minimum === 0
        ? 10
        : Math.min(10, Math.round(((Math.max(activeBuyStops, activeSellStops) - minimum) / minimum) * 10));
    const signedDominance = dominance * Math.sign(activeSellStops - activeBuyStops);
    activeSellBlocks = 10 + signedDominance;
    activeBuyBlocks = 20 - activeSellBlocks;
  }
  const removedTotal = violatedBuyStops + violatedSellStops;
  const violatedBuyBlocks =
    removedTotal === 0 ? null : (20 * violatedBuyStops) / removedTotal;
  const violatedSellBlocks =
    removedTotal === 0 ? null : 20 - (violatedBuyBlocks ?? 0);
  return {
    activeBuyStops,
    activeSellStops,
    violatedBuyStops,
    violatedSellStops,
    activeBuyBlocks,
    activeSellBlocks,
    violatedBuyBlocks,
    violatedSellBlocks,
    blocks: 20
  };
}

export function sideForSignedVolume(volume: number): ClusterSide {
  return volume < 0 ? "buy-stop" : "sell-stop";
}
