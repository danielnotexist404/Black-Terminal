export function formatAuctionMetric(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + "B";
  if (absolute >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (absolute >= 1_000) return (value / 1_000).toFixed(2) + "K";
  if (absolute >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}
