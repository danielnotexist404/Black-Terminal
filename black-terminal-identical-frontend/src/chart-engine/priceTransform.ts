export type ChartPriceScaleMode = "linear" | "logarithmic";

export type ChartPriceTransformSnapshot = {
  revision: number;
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  priceMin: number;
  priceMax: number;
  scaleMode: ChartPriceScaleMode;
  firstIndex: number;
  lastIndex: number;
};

export type PriceTransformInput = Pick<
  ChartPriceTransformSnapshot,
  "plotTop" | "plotBottom" | "priceMin" | "priceMax" | "scaleMode"
>;

export function priceToScreenY(price: number, transform: PriceTransformInput) {
  if (!Number.isFinite(price)) return null;
  const min = toAxisValue(transform.priceMin, transform.scaleMode);
  const max = toAxisValue(transform.priceMax, transform.scaleMode);
  const value = toAxisValue(price, transform.scaleMode);
  const height = transform.plotBottom - transform.plotTop;
  if (![min, max, value, height].every(Number.isFinite) || max <= min || height <= 0) return null;
  return transform.plotTop + (1 - (value - min) / (max - min)) * height;
}

export function screenYToPrice(y: number, transform: PriceTransformInput) {
  const min = toAxisValue(transform.priceMin, transform.scaleMode);
  const max = toAxisValue(transform.priceMax, transform.scaleMode);
  const height = transform.plotBottom - transform.plotTop;
  if (![y, min, max, height].every(Number.isFinite) || max <= min || height <= 0) return null;
  const axisValue = min + (1 - (y - transform.plotTop) / height) * (max - min);
  return fromAxisValue(axisValue, transform.scaleMode);
}

export function toAxisValue(price: number, mode: ChartPriceScaleMode) {
  if (mode === "logarithmic") return price > 0 ? Math.log(price) : Number.NaN;
  return price;
}

export function fromAxisValue(value: number, mode: ChartPriceScaleMode) {
  return mode === "logarithmic" ? Math.exp(value) : value;
}
