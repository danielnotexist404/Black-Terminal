import type { AuctionProfileRow } from "../core/types.ts";

export function tpoMetricValue(row: AuctionProfileRow) {
  return row.tpoCount;
}

const TPO_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function auctionTpoLetter(periodIndex: number) {
  const safeIndex = Math.max(0, Math.floor(periodIndex));
  const cycle = Math.floor(safeIndex / TPO_ALPHABET.length);
  const character = TPO_ALPHABET[safeIndex % TPO_ALPHABET.length]!;
  return cycle === 0 ? character : `${character}${cycle + 1}`;
}

export function auctionTpoLetters(brackets: readonly number[], profileStart: number, bracketSeconds: number) {
  const duration = Math.max(60, Math.floor(bracketSeconds));
  const anchor = Math.floor(profileStart / duration) * duration;
  return [...new Set(brackets)]
    .sort((left, right) => left - right)
    .map(bracket => auctionTpoLetter(Math.max(0, Math.round((bracket - anchor) / duration))));
}
