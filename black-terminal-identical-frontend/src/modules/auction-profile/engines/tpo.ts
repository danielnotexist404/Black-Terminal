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

export interface AuctionTpoLetterDisplay {
  text: string;
  visibleLetters: string[];
  hiddenCount: number;
}

/**
 * Keeps large composite TPO profiles inside their calculated histogram row.
 * The calculation retains every chronological bracket; only presentation is
 * compacted, showing the newest prints and the exact number omitted.
 */
export function compactAuctionTpoLetters(letters: readonly string[], maximumGlyphs: number): AuctionTpoLetterDisplay {
  const capacity = Math.max(1, Math.floor(maximumGlyphs));
  const completeText = letters.join("");
  if (completeText.length <= capacity) {
    return { text: completeText, visibleLetters: [...letters], hiddenCount: 0 };
  }

  const visibleLetters: string[] = [];
  let visibleText = "";
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    const candidate = `${letters[index]}${visibleText}`;
    // Reserve room for a compact "+N|" omitted-print marker.
    if (candidate.length > Math.max(1, capacity - 4)) break;
    visibleLetters.unshift(letters[index]!);
    visibleText = candidate;
  }

  let hiddenCount = Math.max(1, letters.length - visibleLetters.length);
  let marker = `+${hiddenCount}|`;
  while (visibleLetters.length && marker.length + visibleText.length > capacity) {
    visibleLetters.shift();
    visibleText = visibleLetters.join("");
    hiddenCount = letters.length - visibleLetters.length;
    marker = `+${hiddenCount}|`;
  }

  if (marker.length > capacity) {
    return { text: "…", visibleLetters: [], hiddenCount: letters.length };
  }
  return { text: `${marker}${visibleText}`, visibleLetters, hiddenCount };
}
