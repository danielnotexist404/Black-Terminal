import type { IndicatorAlertDefinition } from "../../../../automation/alerts";
import type {
  IndicatorAdvancedSettings,
  IndicatorPeriods,
  VisibleIndicators,
} from "../../../../chart-engine/types";
import type { StrategyRuntimeKind } from "../../types/strategy.types";
import type {
  StrategyIndicatorAlert,
  StrategyIndicatorBinding,
} from "../../automation/strategyAutomation.types";

export type StrategyIndicatorInstance = StrategyIndicatorBinding & {
  source: "ACTIVE_CHART" | "CUSTOM" | "BUILT_IN";
  runtimeKind: StrategyRuntimeKind;
  settings: Record<string, unknown>;
};

type ManifestRow = {
  key: keyof VisibleIndicators;
  name: string;
  version: string;
  runtimeKind: StrategyRuntimeKind;
  runtimeStatus: StrategyIndicatorBinding["runtimeStatus"];
  warmup: number;
  alerts: StrategyIndicatorAlert[];
};

const longShortAlerts: StrategyIndicatorAlert[] = [
  { id: "long-entry", name: "Long Entry", description: "Confirmed bullish entry signal.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
  { id: "short-entry", name: "Short Entry", description: "Confirmed bearish entry signal.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  { id: "long-exit", name: "Long Exit", description: "Optional confirmed long-position exit.", semantic: "LONG_EXIT", confirmedBar: true, intrabar: false },
  { id: "short-exit", name: "Short Exit", description: "Optional confirmed short-position exit.", semantic: "SHORT_EXIT", confirmedBar: true, intrabar: false },
];

const manifests: ManifestRow[] = [
  { key: "adaptiveSwingStrategy", name: "Adaptive Swing Reversal", version: "1", runtimeKind: "builtin-adaptive-swing", runtimeStatus: "CERTIFIED", warmup: 240, alerts: longShortAlerts },
  { key: "ddaProOscillator", name: "BC-RDA — Risk Distribution Analysis", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 500, alerts: longShortAlerts },
  { key: "vwap", name: "Institutional VWAP", version: "2", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 300, alerts: crossingAlerts("vwap") },
  { key: "ema20", name: "EMA 20", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 20, alerts: crossingAlerts("ema20") },
  { key: "ema50", name: "EMA 50", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 50, alerts: crossingAlerts("ema50") },
  { key: "ema200", name: "EMA 200", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 200, alerts: crossingAlerts("ema200") },
  { key: "auctionProfile", name: "RADAP", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 500, alerts: [] },
  { key: "volumeProfile", name: "HDLX Profile", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 500, alerts: [] },
  { key: "liquidationHeatmap", name: "Liquidation Intelligence", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "volatilityHeatmap", name: "Market Maker Heatmap", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "aif", name: "A.I.F. Auction Intelligence", version: "1", runtimeKind: "external-signals", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 1_000, alerts: [] },
  { key: "bollinger", name: "Bollinger Bands", version: "1", runtimeKind: "external-signals", runtimeStatus: "BROWSER_ONLY", warmup: 50, alerts: crossingAlerts("bollinger") },
  { key: "openInterestOscillator", name: "Open Interest Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
  { key: "zScoreOscillator", name: "Z-Score Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
  { key: "waveTrendOscillator", name: "WaveTrend Oscillator", version: "1", runtimeKind: "python-script", runtimeStatus: "REQUIRES_CERTIFICATION", warmup: 100, alerts: [] },
];

export function buildActiveIndicatorInstances(input: {
  visible: VisibleIndicators;
  periods: IndicatorPeriods;
  advanced: IndicatorAdvancedSettings;
  configuredAlerts: IndicatorAlertDefinition[];
}): StrategyIndicatorInstance[] {
  return manifests
    .filter((manifest) => input.visible[manifest.key])
    .map((manifest) => {
      const settings = settingsFor(manifest.key, input.periods, input.advanced);
      const configured = input.configuredAlerts
        .filter((alert) => alert.enabled && alert.indicator === alertTargetFor(manifest.key))
        .map<StrategyIndicatorAlert>((alert) => ({
          id: `configured:${alert.id}`,
          name: alert.name,
          description: alert.message || "User-configured chart alert.",
          semantic: inferSemantic(alert.name),
          confirmedBar: true,
          intrabar: false,
        }));
      const alerts = uniqueAlerts([...manifest.alerts, ...configured]);
      const settingsHash = stableHash(settings);
      return {
        indicatorId: String(manifest.key),
        instanceId: `chart:${String(manifest.key)}`,
        name: manifest.name,
        instanceName: `${manifest.name} — Main Instance`,
        version: manifest.version,
        settingsHash,
        settingsSummary: summarizeSettings(settings),
        alertManifestVersion: `${manifest.version}:${stableHash(alerts)}`,
        runtimeVersion: manifest.runtimeStatus === "CERTIFIED" ? "black-cloud-paper-v1" : "unavailable",
        warmupBars: manifest.warmup,
        runtimeStatus: manifest.runtimeStatus,
        useCurrentChartSettings: true,
        alerts,
        source: "ACTIVE_CHART",
        runtimeKind: manifest.runtimeKind,
        settings,
      };
    });
}

export function templateIndicatorInstances(): StrategyIndicatorInstance[] {
  return [
    template("builtin-adaptive-swing", "Hidden Distribution Swing", "hidden-distribution-swing", longShortAlerts, 240),
    template("builtin-ema-cross", "EMA Cross Baseline", "ema-cross-baseline", longShortAlerts, 60),
  ];
}

export function ownedCustomIndicatorInstances(): StrategyIndicatorInstance[] {
  if (typeof window === "undefined") return [];
  try {
    const rows = JSON.parse(window.localStorage.getItem("bt_user_scripts") || "[]") as Array<{ id?: string; name?: string; kind?: string; source?: string }>;
    return rows.filter((row) => row.kind === "indicator" && row.id && row.name).map((row) => {
      const sourceHash = stableHash(row.source || "");
      const alerts = parseCustomAlertManifest(row.source || "");
      return {
        indicatorId: `custom:${row.id}`,
        instanceId: `custom:${row.id}`,
        name: row.name || "Custom Indicator",
        instanceName: `${row.name || "Custom Indicator"} — Owned Script`,
        version: sourceHash,
        settingsHash: sourceHash,
        settingsSummary: "Owned custom indicator · runtime certification required",
        alertManifestVersion: `custom:${stableHash(alerts)}`,
        runtimeVersion: "unavailable",
        warmupBars: 500,
        runtimeStatus: "REQUIRES_CERTIFICATION",
        useCurrentChartSettings: false,
        alerts,
        source: "CUSTOM",
        runtimeKind: "python-script",
        settings: {},
      };
    });
  } catch {
    return [];
  }
}

function template(runtimeKind: StrategyRuntimeKind, name: string, id: string, alerts: StrategyIndicatorAlert[], warmupBars: number): StrategyIndicatorInstance {
  return {
    indicatorId: id,
    instanceId: `template:${id}`,
    name,
    instanceName: `${name} Template`,
    version: "1",
    settingsHash: stableHash({ template: id }),
    settingsSummary: "Black Core recommended defaults",
    alertManifestVersion: "1",
    runtimeVersion: "black-cloud-paper-v1",
    warmupBars,
    runtimeStatus: "CERTIFIED",
    useCurrentChartSettings: false,
    alerts,
    source: "BUILT_IN",
    runtimeKind,
    settings: {},
  };
}

function settingsFor(key: keyof VisibleIndicators, periods: IndicatorPeriods, advanced: IndicatorAdvancedSettings) {
  if (key === "adaptiveSwingStrategy") return structuredClone(advanced.adaptiveSwingStrategy) as unknown as Record<string, unknown>;
  if (key === "ddaProOscillator") return structuredClone(advanced.ddaProOscillator) as unknown as Record<string, unknown>;
  if (key === "vwap") return structuredClone(advanced.vwap) as unknown as Record<string, unknown>;
  const period = periods[key as keyof IndicatorPeriods];
  return typeof period === "number" ? { period } : {};
}

function crossingAlerts(id: string): StrategyIndicatorAlert[] {
  return [
    { id: `${id}:cross-above`, name: "Price Crossing Above", description: "Price crosses above the indicator on a confirmed bar.", semantic: "LONG_ENTRY", confirmedBar: true, intrabar: false },
    { id: `${id}:cross-below`, name: "Price Crossing Below", description: "Price crosses below the indicator on a confirmed bar.", semantic: "SHORT_ENTRY", confirmedBar: true, intrabar: false },
  ];
}

function alertTargetFor(key: keyof VisibleIndicators) {
  if (["vwap", "ema20", "ema50", "ema200"].includes(String(key))) return key as IndicatorAlertDefinition["indicator"];
  if (key === "volumeProfile") return "hdlxProfile";
  if (key === "ddaProOscillator") return "ddaPro";
  return "price";
}

function inferSemantic(name: string): StrategyIndicatorAlert["semantic"] {
  const normalized = name.toLowerCase();
  if (normalized.includes("short") || normalized.includes("sell") || normalized.includes("below")) return "SHORT_ENTRY";
  if (normalized.includes("long") || normalized.includes("buy") || normalized.includes("above")) return "LONG_ENTRY";
  return "NEUTRAL";
}

function parseCustomAlertManifest(source: string): StrategyIndicatorAlert[] {
  const rows: StrategyIndicatorAlert[] = [];
  for (const match of source.matchAll(/alertcondition\s*\([^,]+,\s*["']([^"']+)["']/gi)) {
    const name = match[1]?.trim();
    if (!name) continue;
    rows.push({ id: `custom-alert:${stableHash(name)}`, name, description: "Owned script alert; VPS certification is required before publish.", semantic: inferSemantic(name), confirmedBar: true, intrabar: false });
  }
  return uniqueAlerts(rows);
}

function uniqueAlerts(alerts: StrategyIndicatorAlert[]) {
  return [...new Map(alerts.map((alert) => [alert.id, alert])).values()];
}

function summarizeSettings(settings: Record<string, unknown>) {
  const rows = Object.entries(settings).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 4);
  return rows.length ? rows.map(([key, value]) => `${humanize(key)} ${String(value)}`).join(" · ") : "Current chart settings";
}

function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}

export function stableHash(value: unknown) {
  const text = JSON.stringify(sortValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((output, key) => {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
    return output;
  }, {});
  return value;
}
