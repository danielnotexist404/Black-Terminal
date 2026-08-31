export type AuctionHistoryPage = { from: number; to: number; limit: number };

export function planAuctionHistoryPages(
  rangeStart: number,
  rangeEnd: number,
  sourceSeconds: number,
  pageSize: number,
  targetBars: number
): AuctionHistoryPage[] {
  const pages: AuctionHistoryPage[] = [];
  let to = rangeEnd;
  let remaining = Math.max(0, Math.trunc(targetBars));
  while (remaining > 0 && to >= rangeStart) {
    const limit = Math.min(pageSize, remaining);
    const from = Math.max(rangeStart, to - (limit - 1) * sourceSeconds);
    pages.push({ from, to, limit });
    remaining -= limit;
    to = from - sourceSeconds;
  }
  return pages;
}
