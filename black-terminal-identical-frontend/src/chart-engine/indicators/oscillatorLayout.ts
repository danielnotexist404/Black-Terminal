import type {
  OscillatorIndicatorKey,
  OscillatorPaneSettings,
  VisibleIndicators,
  WaveTrendOscillatorSettings
} from "../types";

export const OSCILLATOR_KEYS: readonly OscillatorIndicatorKey[] = [
  "cvdOscillator",
  "marketSentimentOscillator",
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
export const DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT = 170;

export type OscillatorPaneLayout = {
  key: OscillatorIndicatorKey;
  height: number;
  bottomOffset: number;
  topOffset: number;
};

export type CustomOscillatorPaneLayout = {
  scriptId: string;
  height: number;
  bottomOffset: number;
  topOffset: number;
};

export type OscillatorStackLayout = {
  panes: OscillatorPaneLayout[];
  customPanes: CustomOscillatorPaneLayout[];
  injectionTarget?: Exclude<OscillatorIndicatorKey, "waveTrendOscillator">;
  totalContentHeight: number;
  reservedHeight: number;
};

export function customOscillatorScriptId(plotName: string): string {
  const delimiter = plotName.indexOf(":");
  return delimiter > 0 ? plotName.slice(0, delimiter) : "__custom__";
}

export function customOscillatorScriptIds(
  plots: readonly { name: string; pane: "price" | "oscillator"; visible: boolean }[]
): string[] {
  return [...new Set(plots
    .filter((plot) => plot.pane === "oscillator" && plot.visible !== false)
    .map((plot) => customOscillatorScriptId(plot.name)))];
}

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
  topPadding = 38,
  customOscillatorIds: readonly string[] = []
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

  const uniqueCustomIds = [...new Set(customOscillatorIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (paneKeys.length === 0 && uniqueCustomIds.length === 0) {
    return { panes: [], customPanes: [], totalContentHeight: 0, reservedHeight: 0 };
  }

  const paneSpecs: Array<
    | { kind: "native"; key: OscillatorIndicatorKey; requestedHeight: number }
    | { kind: "custom"; scriptId: string; requestedHeight: number }
  > = [
    ...paneKeys.map((key) => ({
      kind: "native" as const,
      key,
      requestedHeight: Number(paneSettings.paneHeights?.[key] ?? paneSettings.height ?? 128)
    })),
    ...uniqueCustomIds.map((scriptId) => ({
      kind: "custom" as const,
      scriptId,
      requestedHeight: Number(paneSettings.customPaneHeights?.[scriptId] ?? DEFAULT_CUSTOM_OSCILLATOR_PANE_HEIGHT)
    }))
  ];
  const requestedHeights = paneSpecs.map(({ requestedHeight }) => {
    const configured = requestedHeight;
    const safeHeight = Number.isFinite(configured) ? configured : 128;
    return Math.max(MINIMUM_PANE_HEIGHT, Math.min(MAXIMUM_PANE_HEIGHT, Math.round(safeHeight)));
  });
  const gapsHeight = PANE_GAP * Math.max(0, paneSpecs.length - 1);
  const maximumContentHeight = Math.max(
    COMPACT_MINIMUM_PANE_HEIGHT * paneSpecs.length + gapsHeight,
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
  const panes: OscillatorPaneLayout[] = [];
  const customPanes: CustomOscillatorPaneLayout[] = [];
  paneSpecs.forEach((spec, index) => {
    const height = resolvedHeights[index] ?? COMPACT_MINIMUM_PANE_HEIGHT;
    const offsets = { height, bottomOffset: cursor, topOffset: cursor + height };
    if (spec.kind === "native") panes.push({ key: spec.key, ...offsets });
    else customPanes.push({ scriptId: spec.scriptId, ...offsets });
    cursor += height + PANE_GAP;
  });
  const totalContentHeight = cursor - PANE_GAP;

  return {
    panes,
    customPanes,
    injectionTarget,
    totalContentHeight,
    reservedHeight: totalContentHeight + RESERVED_PADDING
  };
}
