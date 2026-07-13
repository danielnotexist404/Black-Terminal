import type { Candle } from "../../../chart-engine/types";
import { emptyProfileRows, distributeConserved, finalizeRows } from "../core/aifBucketEngine.ts";
import type { AifNormalizedData } from "../core/aifDataNormalizer";
import type { AifAuctionDomain, AifImplementedProfileType, AifProfileResult, AifProfileRow, AifProvenance, AifSettings } from "../core/aifTypes";

export function calculateAifProfile(type: AifImplementedProfileType, data: AifNormalizedData, domain: AifAuctionDomain, settings: AifSettings, provenance: AifProvenance): AifProfileResult {
  const rows = emptyProfileRows(domain);
  if (type === "volume") calculateVolume(rows, domain, data.candles);
  if (type === "delta") calculateDelta(rows, domain, data.candles);
  if (type === "tpo") calculateTpo(rows, domain, data.candles, settings.tpoPeriodMinutes);
  if (type === "volatility") calculateVolatility(rows, domain, data.candles, settings);
  if (type === "pressure") calculatePressure(rows, domain, data.candles);
  finalizeRows(rows);
  const total = rows.reduce((sum, row) => sum + Math.abs(row.value), 0);
  const { poc, vah, val } = markValueArea(rows, 0.7);
  return {
    profileType: type,
    rows,
    poc,
    vah,
    val,
    total,
    valueAreaPercent: 70,
    quality: type === "volume" || type === "tpo" ? "estimated" : "estimated",
    allocationMethod: allocationMethod(type, settings),
    statistics: profileStatistics(type, rows, data.candles),
    provenance: { ...provenance, profileType: type, allocationMethod: allocationMethod(type, settings), profileVersion: "1.0.0" }
  };
}

function calculateVolume(rows: AifProfileRow[], domain: AifAuctionDomain, candles: Candle[]) {
  for (const candle of candles) distributeConserved(rows, domain, candle, candle.volume, pressureShare(candle));
}

function calculateDelta(rows: AifProfileRow[], domain: AifAuctionDomain, candles: Candle[]) {
  for (const candle of candles) {
    const share = pressureShare(candle);
    distributeConserved(rows, domain, candle, candle.volume * (share * 2 - 1), share);
  }
}

function calculateTpo(rows: AifProfileRow[], domain: AifAuctionDomain, candles: Candle[], periodMinutes: number) {
  const periods = new Map<number, Candle>();
  const seconds = Math.max(60, Math.round(periodMinutes) * 60);
  for (const candle of candles) {
    const key = Math.floor(candle.time / seconds) * seconds;
    const period = periods.get(key);
    if (!period) periods.set(key, { ...candle, time: key, volume: 1 });
    else periods.set(key, { ...period, high: Math.max(period.high, candle.high), low: Math.min(period.low, candle.low), close: candle.close, volume: 1 });
  }
  for (const period of periods.values()) distributeConserved(rows, domain, period, 1, 0.5, () => 1);
}

function calculateVolatility(rows: AifProfileRow[], domain: AifAuctionDomain, candles: Candle[], settings: AifSettings) {
  let previousClose = candles[0]?.close ?? 0;
  for (const candle of candles) {
    const range = Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    const logVariance = previousClose > 0 ? Math.pow(Math.log(candle.close / previousClose), 2) : 0;
    const parkinson = candle.low > 0 ? Math.pow(Math.log(candle.high / candle.low), 2) / (4 * Math.log(2)) : 0;
    const amount = settings.volatilityEstimator === "parkinson" ? parkinson : settings.volatilityEstimator === "log-return-variance" ? logVariance : settings.volatilityEstimator === "composite" ? range + Math.sqrt(logVariance + parkinson) * candle.close : range;
    const bodyCenter = (candle.open + candle.close) / 2;
    distributeConserved(rows, domain, candle, amount, pressureShare(candle), (row) => settings.volatilityAllocation === "body-weighted" ? 1 / (1 + Math.abs(row.center - bodyCenter)) : settings.volatilityAllocation === "close-location" ? 1 / (1 + Math.abs(row.center - candle.close)) : 1);
    previousClose = candle.close;
  }
}

function calculatePressure(rows: AifProfileRow[], domain: AifAuctionDomain, candles: Candle[]) {
  for (const candle of candles) {
    const share = pressureShare(candle);
    const signed = candle.volume * (share * 2 - 1);
    distributeConserved(rows, domain, candle, signed, share);
  }
}

export function pressureShare(candle: Candle) {
  const range = Math.max(1e-12, candle.high - candle.low);
  const body = (candle.close - candle.open) / range;
  const closeLocation = ((candle.close - candle.low) / range - 0.5) * 2;
  const upperWick = (candle.high - Math.max(candle.open, candle.close)) / range;
  const lowerWick = (Math.min(candle.open, candle.close) - candle.low) / range;
  return Math.max(0, Math.min(1, 0.5 + body * 0.22 + closeLocation * 0.18 + (lowerWick - upperWick) * 0.1));
}

function markValueArea(rows: AifProfileRow[], fraction: number) {
  if (!rows.length) return { poc: null, vah: null, val: null };
  let pocIndex = 0;
  for (let index = 1; index < rows.length; index += 1) if (Math.abs(rows[index].value) > Math.abs(rows[pocIndex].value)) pocIndex = index;
  const target = rows.reduce((sum, row) => sum + Math.abs(row.value), 0) * fraction;
  let included = Math.abs(rows[pocIndex].value);
  let low = pocIndex;
  let high = pocIndex;
  rows[pocIndex].valueArea = true;
  while (included < target && (low > 0 || high < rows.length - 1)) {
    const lower = low > 0 ? Math.abs(rows[low - 1].value) : -1;
    const upper = high < rows.length - 1 ? Math.abs(rows[high + 1].value) : -1;
    if (upper > lower) high += 1; else low -= 1;
    const row = rows[upper > lower ? high : low];
    row.valueArea = true;
    included += Math.abs(row.value);
  }
  return { poc: rows[pocIndex].center, vah: rows[high].high, val: rows[low].low };
}

function allocationMethod(type: AifImplementedProfileType, settings: AifSettings) {
  if (type === "volatility") return settings.volatilityAllocation;
  if (type === "delta") return "ohlcv-proportional-estimate";
  if (type === "pressure") return "body-close-wick-composite";
  if (type === "tpo") return `period-range-dwell-${settings.tpoPeriodMinutes}m`;
  return "range-overlap-volume-conserved";
}

function profileStatistics(type: AifImplementedProfileType, rows: AifProfileRow[], candles: Candle[]) {
  const positive = rows.reduce((sum, row) => sum + row.positive, 0);
  const negative = rows.reduce((sum, row) => sum + row.negative, 0);
  return { bars: candles.length, positive, negative, balance: positive + negative > 0 ? (positive - negative) / (positive + negative) : 0, estimated: true, lens: type };
}
