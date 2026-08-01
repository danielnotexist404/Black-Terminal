import type {
  CanonicalCluster,
  CanonicalNearest,
  ClusterSide,
  KioseffSnapshot
} from "../core/canonical.ts";

export type MarketMakerWall = CanonicalNearest & {
  distancePercent: number | null;
};

export type MarketMakerLiquidationEvent = {
  side: ClusterSide;
  price: number;
  volume: number;
  time: number | null;
};

export type MarketMakerActivityDashboard = {
  nearestBuyWall: MarketMakerWall | null;
  nearestSellWall: MarketMakerWall | null;
  activeBuyWallCount: number;
  activeSellWallCount: number;
  activeBuyLiquidity: number;
  activeSellLiquidity: number;
  violatedEventCount: number;
  buyWallLiquidationPressure: number;
  sellWallLiquidationPressure: number;
  totalLiquidationPressure: number;
  dominantPressure: "buy-wall" | "sell-wall" | "balanced" | "none";
  dominantPressurePercent: number | null;
  latestLiquidationEvent: MarketMakerLiquidationEvent | null;
};

function sumVolume(clusters: readonly CanonicalCluster[]) {
  return clusters.reduce((sum, cluster) => sum + cluster.absoluteVolume, 0);
}

function nearestWall(
  clusters: readonly CanonicalCluster[],
  side: ClusterSide,
  currentPrice: number,
  canonicalNearest: CanonicalNearest | null
): MarketMakerWall | null {
  const candidates = clusters.filter(
    (cluster) => cluster.state === "active" && cluster.side === side
  );
  const nearest = candidates.reduce<CanonicalCluster | null>((selected, cluster) => {
    if (!selected) return cluster;
    if (side === "buy-stop") return cluster.price > selected.price ? cluster : selected;
    return cluster.price < selected.price ? cluster : selected;
  }, null);
  if (!nearest) return null;
  const sideTotal = sumVolume(candidates);
  const exactCanonical =
    canonicalNearest?.clusterId === nearest.id ? canonicalNearest : null;
  return {
    clusterId: nearest.id,
    price: nearest.price,
    signedVolume: nearest.signedVolume,
    typicalMove: exactCanonical?.typicalMove ?? null,
    activeSidePercent:
      sideTotal > 0 ? (nearest.absoluteVolume / sideTotal) * 100 : null,
    distancePercent:
      Number.isFinite(currentPrice) && currentPrice > 0
        ? ((nearest.price - currentPrice) / currentPrice) * 100
        : null
  };
}

function eventTime(cluster: CanonicalCluster) {
  return cluster.violationTime ?? cluster.endTime ?? null;
}

export function buildMarketMakerActivityDashboard(
  snapshot: KioseffSnapshot,
  currentPrice: number
): MarketMakerActivityDashboard {
  const activeBuy = snapshot.activeClusters.filter(
    (cluster) => cluster.side === "buy-stop"
  );
  const activeSell = snapshot.activeClusters.filter(
    (cluster) => cluster.side === "sell-stop"
  );
  const violatedBuy = snapshot.violatedClusters.filter(
    (cluster) => cluster.side === "buy-stop"
  );
  const violatedSell = snapshot.violatedClusters.filter(
    (cluster) => cluster.side === "sell-stop"
  );
  const buyPressure = sumVolume(violatedBuy);
  const sellPressure = sumVolume(violatedSell);
  const totalPressure = buyPressure + sellPressure;
  const pressureDifference = Math.abs(buyPressure - sellPressure);
  const dominantPressure =
    totalPressure === 0
      ? "none"
      : pressureDifference / totalPressure < 0.05
        ? "balanced"
        : buyPressure > sellPressure
          ? "buy-wall"
          : "sell-wall";
  const latest = snapshot.violatedClusters.reduce<CanonicalCluster | null>(
    (selected, cluster) => {
      if (!selected) return cluster;
      return (eventTime(cluster) ?? Number.NEGATIVE_INFINITY) >
        (eventTime(selected) ?? Number.NEGATIVE_INFINITY)
        ? cluster
        : selected;
    },
    null
  );

  return {
    nearestBuyWall: nearestWall(
      snapshot.activeClusters,
      "buy-stop",
      currentPrice,
      snapshot.summary.nearestBuy
    ),
    nearestSellWall: nearestWall(
      snapshot.activeClusters,
      "sell-stop",
      currentPrice,
      snapshot.summary.nearestSell
    ),
    activeBuyWallCount: activeBuy.length,
    activeSellWallCount: activeSell.length,
    activeBuyLiquidity: sumVolume(activeBuy),
    activeSellLiquidity: sumVolume(activeSell),
    violatedEventCount: snapshot.violatedClusters.length,
    buyWallLiquidationPressure: buyPressure,
    sellWallLiquidationPressure: sellPressure,
    totalLiquidationPressure: totalPressure,
    dominantPressure,
    dominantPressurePercent:
      totalPressure > 0
        ? (Math.max(buyPressure, sellPressure) / totalPressure) * 100
        : null,
    latestLiquidationEvent: latest
      ? {
          side: latest.side,
          price: latest.price,
          volume: latest.absoluteVolume,
          time: eventTime(latest)
        }
      : null
  };
}
