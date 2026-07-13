import type { AifAuctionDomain, AifProfileType, AifSettings } from "./aifTypes";
import type { AifNormalizedData } from "./aifDataNormalizer";

export function createAuctionDomain(data: AifNormalizedData, settings: AifSettings, currentPrice: number, profileType: AifProfileType): AifAuctionDomain {
  let rawMin = currentPrice * 0.99;
  let rawMax = currentPrice * 1.01;
  if (data.candles.length) {
    rawMin = Number.POSITIVE_INFINITY;
    rawMax = Number.NEGATIVE_INFINITY;
    for (const candle of data.candles) {
      rawMin = Math.min(rawMin, candle.low);
      rawMax = Math.max(rawMax, candle.high);
    }
  }
  const domainMin = Math.max(0.00000001, rawMin);
  const domainMax = Math.max(domainMin * 1.000001, rawMax);
  const mode = settings.logarithmic ? "logarithmic" : settings.bucketMode;
  const bucketCount = resolveBucketCount(domainMin, domainMax, settings, data);
  const boundaries = buildBoundaries(domainMin, domainMax, bucketCount, mode === "logarithmic");
  return {
    domainMin,
    domainMax,
    currentPrice,
    bucketMode: mode,
    bucketCount,
    bucketSize: (domainMax - domainMin) / bucketCount,
    logarithmic: mode === "logarithmic",
    rangeStart: data.coverage.calculationStart ?? 0,
    rangeEnd: data.coverage.calculationEnd ?? 0,
    requestedLookbackBars: data.coverage.requestedLookbackBars,
    effectiveLookbackBars: data.coverage.effectiveLookbackBars,
    currentProfileType: profileType,
    sourceResolution: "chart-candles",
    boundaries
  };
}

export function bucketIndexForPrice(domain: AifAuctionDomain, price: number) {
  if (price <= domain.domainMin) return 0;
  if (price >= domain.domainMax) return domain.bucketCount - 1;
  if (domain.logarithmic) {
    const ratio = Math.log(price / domain.domainMin) / Math.log(domain.domainMax / domain.domainMin);
    return Math.max(0, Math.min(domain.bucketCount - 1, Math.floor(ratio * domain.bucketCount)));
  }
  return Math.max(0, Math.min(domain.bucketCount - 1, Math.floor((price - domain.domainMin) / domain.bucketSize)));
}

function resolveBucketCount(min: number, max: number, settings: AifSettings, data: AifNormalizedData) {
  if (settings.bucketMode === "fixed-price" || settings.bucketMode === "tick") return Math.max(10, Math.min(2000, Math.ceil((max - min) / Math.max(0.00000001, settings.fixedPriceSize))));
  if (settings.bucketMode === "percentage") return Math.max(10, Math.min(2000, Math.ceil(Math.log(max / min) / Math.log(1 + Math.max(0.000001, settings.percentageBucket / 100)))));
  if (settings.bucketMode === "atr-normalized") {
    let trueRange = 0;
    for (let index = 1; index < data.candles.length; index += 1) {
      const candle = data.candles[index];
      const previous = data.candles[index - 1];
      trueRange += Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
    }
    const atr = trueRange / Math.max(1, data.candles.length - 1);
    return Math.max(10, Math.min(2000, Math.ceil((max - min) / Math.max(0.00000001, atr * 0.25))));
  }
  if (settings.bucketMode === "adaptive") return Math.max(100, Math.min(2000, Math.round(Math.sqrt(data.candles.length) * 3)));
  return Math.max(10, Math.min(2000, Math.round(settings.rowCount)));
}

function buildBoundaries(min: number, max: number, count: number, logarithmic: boolean) {
  if (!logarithmic) return Array.from({ length: count + 1 }, (_, index) => min + (max - min) * index / count);
  const ratio = Math.pow(max / min, 1 / count);
  return Array.from({ length: count + 1 }, (_, index) => index === count ? max : min * Math.pow(ratio, index));
}
