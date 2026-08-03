import type { AuctionCalculationEngine, AuctionCvdMetric } from "../core/types.ts";

export function formatAuctionMetric(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + "B";
  if (absolute >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (absolute >= 1_000) return (value / 1_000).toFixed(1) + "K";
  if (absolute >= 100) return Math.round(value).toString();
  if (absolute >= 1) return value.toFixed(absolute >= 10 ? 0 : 1);
  if (absolute === 0) return "0";
  return value.toPrecision(2);
}

export function formatAuctionCellMetric(value: number, engine: AuctionCalculationEngine, cvdMetric?: AuctionCvdMetric) {
  if (engine === "IMBALANCE_RATIO" || ["CVD_IMBALANCE_RATIO", "CVD_EFFICIENCY", "CVD_PERSISTENCE"].includes(cvdMetric ?? "")) {
    return (value >= 0 ? "+" : "") + Math.round(value * 100) + "%";
  }
  if (["REALIZED_VOLATILITY", "PARKINSON_VOLATILITY", "GARMAN_KLASS_VOLATILITY"].includes(engine)) return (value * 100).toFixed(2) + "%";
  if (engine === "USD_VOLUME") return (value < 0 ? "-$" : "$" ) + formatAuctionMetric(Math.abs(value));
  if (engine === "TPO" || engine === "TRADE_COUNT") return Math.round(value).toLocaleString("en-US");
  const text = formatAuctionMetric(value);
  return value > 0 && ["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE", "DELTA_VOLUME"].includes(engine) ? "+" + text : text;
}

export function auctionCellTextVisible(mode: "ALWAYS" | "AUTO" | "HOVER_ONLY" | "STRONG_ONLY" | "OFF", width: number, height: number, strength: number) {
  if (mode === "OFF" || mode === "HOVER_ONLY") return false;
  if (mode === "STRONG_ONLY") return strength >= 0.62 && width >= 18 && height >= 8;
  if (mode === "ALWAYS") return width >= 12 && height >= 7;
  return width >= 22 && height >= 9;
}
