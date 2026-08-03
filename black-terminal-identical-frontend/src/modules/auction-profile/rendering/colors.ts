import type { AuctionProfileSettings } from "../core/types.ts";

export function auctionColorNumber(color: string) {
  const parsed = Number.parseInt(color.replace(/^#/, ""), 16);
  return Number.isFinite(parsed) ? parsed : 0xffffff;
}

function mixColor(from: string, to: string, amount: number) {
  const left = auctionColorNumber(from);
  const right = auctionColorNumber(to);
  const t = Math.max(0, Math.min(1, amount));
  const channel = (shift: number) => Math.round(((left >> shift) & 0xff) * (1 - t) + ((right >> shift) & 0xff) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function auctionDirectionalColor(value: number, strength: number, settings: AuctionProfileSettings["rendering"]) {
  if (value === 0) return auctionColorNumber(settings.balancedColor);
  if (value > 0) return mixColor("#202020", settings.positiveColor, Math.pow(Math.max(0, Math.min(1, strength)), 0.72));
  return mixColor("#2a0508", settings.negativeColor, Math.pow(Math.max(0, Math.min(1, strength)), 0.72));
}
