import type {
  OscillatorIndicatorKey,
  OscillatorPaneSettings,
  VisibleIndicators,
  WaveTrendOscillatorSettings
} from "../types";

export const OSCILLATOR_KEYS: readonly OscillatorIndicatorKey[] = [
  "acvdOscillator",
  "ddaProOscillator",
  "zScoreOscillator",
  "openInterestOscillator",
  "waveTrendOscillator"
];

const OSCILLATOR_KEY_SET = new Set<OscillatorIndicatorKey>(OSCILLATOR_KEYS);
const MINIMUM_PANE_HEIGHT = 82;
const MAXIMUM_PANE_HEIGHT = 420;
const COMPACT_MINIMUM_PANE_HEIGHT = 64;
const PANE_GAP = 8;
const RESERVED_PADDING = 20;

export type OscillatorPaneLayout = {
  key: OscillatorIndicatorKey;
  height: number;
  bottomOffset: number;
  topOffset: number;
};

export type OscillatorStackLayout = {
  panes: OscillatorPaneLayout[];
  injectionTarget?: Exclude<OscillatorIndicatorKey, "waveTrendOscillator">;
  totalContentHeight: number;
  reservedHeight: number;
};

function isOscillatorKey(value: unknown): value is OscillatorIndicatorKey {
  return typeof value === "string" && OSCILLATOR_KEY_SET.has(value as OscillatorIndicatorKey);
}

export function resolveOscillatorOrder(
  visibleIndicators: VisibleIndicators,
  paneSettings: OscillatorPaneSettings
) {
  const order: OscillatorIndicatorKey[] = [];
  for (const key of paneSettings.order ?? []) {
    if (isOscillatorKey(key) && visibleIndicators[key] && !order.includes(key)) order.push(key);
  }
  for (const key of OSCILLATOR_KEYS) {
    if (visibleIndicators[key] && !order.includes(key)) order.push(key);
  }
  return order;
}

export function resolveOscillatorStack(
  visibleIndicators: VisibleIndicators,
  paneSettings: OscillatorPaneSettings,
  waveTrendSettings: WaveTrendOscillatorSettings,
  canvasHeight: number,
  bottomAxisHeight = 58,
  topPadding = 38
): OscillatorStackLayout {
  const order = resolveOscillatorOrder(visibleIndicators, paneSettings);
  const firstPrimary = order.find(
    (key): key is "zScoreOscillator" | "openInterestOscillator" =>
      key === "zScoreOscillator" || key === "openInterestOscillator"
  );
  const injectionTarget = visibleIndicators.waveTrendOscillator &&
    waveTrendSettings.injectIntoPrimary &&
    firstPrimary
      ? firstPrimary
      : undefined;
  const paneKeys = injectionTarget
    ? order.filter((key) => key !== "waveTrendOscillator")
    : order;

  if (paneKeys.length === 0) {
    return { panes: [], totalContentHeight: 0, reservedHeight: 0 };
  }

  const requestedHeights = paneKeys.map((key) => {
    const configured = Number(paneSettings.paneHeights?.[key] ?? paneSettings.height ?? 128);
    const safeHeight = Number.isFinite(configured) ? configured : 128;
    return Math.max(MINIMUM_PANE_HEIGHT, Math.min(MAXIMUM_PANE_HEIGHT, Math.round(safeHeight)));
  });
  const gapsHeight = PANE_GAP * Math.max(0, paneKeys.length - 1);
  const maximumContentHeight = Math.max(
    COMPACT_MINIMUM_PANE_HEIGHT * paneKeys.length + gapsHeight,
    canvasHeight - bottomAxisHeight - topPadding - 64 - RESERVED_PADDING
  );
  const requestedTotal = requestedHeights.reduce((sum, height) => sum + height, 0) + gapsHeight;
  const scale = requestedTotal > maximumContentHeight
    ? Math.max(
        COMPACT_MINIMUM_PANE_HEIGHT / Math.max(...requestedHeights),
        (maximumContentHeight - gapsHeight) / Math.max(1, requestedTotal - gapsHeight)
      )
    : 1;
  const resolvedHeights = requestedHeights.map((height) =>
    Math.max(COMPACT_MINIMUM_PANE_HEIGHT, Math.floor(height * scale))
  );

  let cursor = 0;
  const panes = paneKeys.map((key, index) => {
    const height = resolvedHeights[index] ?? COMPACT_MINIMUM_PANE_HEIGHT;
    const pane = {
      key,
      height,
      bottomOffset: cursor,
      topOffset: cursor + height
    };
    cursor += height + PANE_GAP;
    return pane;
  });
  const totalContentHeight = cursor - PANE_GAP;

  return {
    panes,
    injectionTarget,
    totalContentHeight,
    reservedHeight: totalContentHeight + RESERVED_PADDING
  };
}
