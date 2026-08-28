import type { Candle } from "../../../chart-engine/types";

const HORIZON_FIXTURE_END_SECONDS = 1_900_000_000;

export function isHorizonVisualFixtureEnabled(locationValue?: Pick<Location, "hostname" | "search">) {
  const resolved = locationValue ?? (typeof window === "undefined" ? { hostname: "", search: "" } : window.location);
  const local = resolved.hostname === "localhost" || resolved.hostname === "127.0.0.1" || resolved.hostname === "::1";
  return local && new URLSearchParams(resolved.search).get("horizonVisualFixture") === "1";
}

/** Localhost-only deterministic one-second fixture. It is always labelled synthetic in the UI. */
export function createHorizonVisualFixture(count = 14_400): Candle[] {
  const length = Math.max(900, Math.min(100_000, Math.round(count)));
  return Array.from({ length }, (_, index) => {
    const macro = Math.sin(index / 1_480) * 2_200 + Math.sin(index / 410) * 480;
    const migration = index * 0.08;
    const center = 72_000 + macro + migration;
    const micro = Math.sin(index / 19) * 22 + Math.cos(index / 7) * 8;
    const open = center + micro;
    const signedBody = Math.sin(index / 137) >= 0 ? 1 : -1;
    const close = open + signedBody * (4 + (index % 11) * 0.65);
    const volume = 45 + (index % 43) * 3.2 + Math.abs(Math.sin(index / 31)) * 90;
    const delta = signedBody * volume * (0.28 + (index % 7) * 0.055);
    return {
      time: HORIZON_FIXTURE_END_SECONDS - (length - 1 - index),
      open,
      high: Math.max(open, close) + 5 + (index % 13) * 0.8,
      low: Math.min(open, close) - 5 - (index % 17) * 0.65,
      close,
      volume,
      delta,
      buyVolume: (volume + delta) / 2,
      sellVolume: (volume - delta) / 2
    };
  });
}
