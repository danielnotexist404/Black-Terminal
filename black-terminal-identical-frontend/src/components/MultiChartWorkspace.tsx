import { useEffect, useMemo, useState, type ReactNode, type SetStateAction } from "react";
import { Activity, Maximize2, Minimize2 } from "lucide-react";
import type {
  ChartDisplayType,
  IndicatorAdvancedSettings,
  IndicatorPeriods,
  IndicatorVisualSettings,
  VisibleIndicators,
} from "../chart-engine/types";
import type { MarketSymbolOption } from "../market-data/marketCatalog";
import type { Timeframe } from "../market-data/types";
import type { KioseffSettingsV1 } from "../modules/kioseff-stop-loss-clustering/core/settings";
import type { AuctionProfileSettings } from "../modules/auction-profile/core/types";
import "../styles/multi-chart.css";

export const MAX_MULTI_CHART_PANES = 7;

export type MultiChartPaneConfiguration = {
  id: string;
  symbolRaw: string;
  timeframe: Timeframe;
  chartType: ChartDisplayType;
  visibleIndicators: VisibleIndicators;
  indicatorPeriods: IndicatorPeriods;
  indicatorVisualSettings: IndicatorVisualSettings;
  indicatorAdvancedSettings: IndicatorAdvancedSettings;
  kioseffSettings: KioseffSettingsV1;
  auctionProfileSettings: AuctionProfileSettings;
};

type PaneFieldUpdater = <Key extends keyof MultiChartPaneConfiguration>(
  key: Key,
  value: SetStateAction<MultiChartPaneConfiguration[Key]>,
) => void;

type MultiChartWorkspaceProps = {
  workspaceId: string;
  paneCount: number;
  primary: ReactNode;
  seed: Omit<MultiChartPaneConfiguration, "id">;
  symbols: readonly MarketSymbolOption[];
  timeframeOptions: ReadonlyArray<{ label: string; value: Timeframe }>;
  chartTypeOptions: ReadonlyArray<{ label: string; value: ChartDisplayType }>;
  renderSecondary: (
    pane: MultiChartPaneConfiguration,
    symbol: MarketSymbolOption,
    update: PaneFieldUpdater,
  ) => ReactNode;
};

const indicatorLabels: Record<keyof VisibleIndicators, string> = {
  qalc: "QALC",
  liquidationHeatmap: "Liquidation field",
  auctionProfile: "RADAP",
  volatilityHeatmap: "Volatility heatmap",
  volumeProfile: "HDLX profile",
  aif: "AIF",
  adaptiveSwingStrategy: "Adaptive swings",
  vwap: "VWAP",
  ema20: "EMA 20",
  ema50: "EMA 50",
  ema200: "EMA 200",
  sma20: "SMA 20",
  sma50: "SMA 50",
  bollinger: "Bollinger",
  openInterestOscillator: "Open interest",
  zScoreOscillator: "Z-Score",
  waveTrendOscillator: "WaveTrend",
  ddaProOscillator: "BC-RDA",
  acvdOscillator: "ACVD",
  cvdOscillator: "CVD",
  marketSentimentOscillator: "BC-MSO",
  volume: "Volume",
};

const fallbackTimeframes: Timeframe[] = ["1h", "4h", "1d", "15m", "1w", "5m"];

function storageKey(workspaceId: string) {
  return `bt_multi_chart_workspace_v1:${workspaceId}`;
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function makePane(seed: Omit<MultiChartPaneConfiguration, "id">, index: number): MultiChartPaneConfiguration {
  return {
    ...clone(seed),
    id: `pane-${index + 1}`,
    timeframe: index === 0 ? seed.timeframe : fallbackTimeframes[(index - 1) % fallbackTimeframes.length],
  };
}

function readStoredPanes(workspaceId: string, seed: Omit<MultiChartPaneConfiguration, "id">) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(workspaceId)) || "[]") as MultiChartPaneConfiguration[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_MULTI_CHART_PANES - 1).map((pane, index) => ({
      ...makePane(seed, index + 1),
      ...pane,
      id: `pane-${index + 2}`,
      visibleIndicators: { ...clone(seed.visibleIndicators), ...(pane.visibleIndicators || {}) },
      indicatorPeriods: { ...clone(seed.indicatorPeriods), ...(pane.indicatorPeriods || {}) },
      indicatorVisualSettings: { ...clone(seed.indicatorVisualSettings), ...(pane.indicatorVisualSettings || {}) },
      indicatorAdvancedSettings: { ...clone(seed.indicatorAdvancedSettings), ...(pane.indicatorAdvancedSettings || {}) },
      kioseffSettings: { ...clone(seed.kioseffSettings), ...(pane.kioseffSettings || {}) },
      auctionProfileSettings: { ...clone(seed.auctionProfileSettings), ...(pane.auctionProfileSettings || {}) },
    }));
  } catch {
    return [];
  }
}

export function normalizeMultiChartPaneCount(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_MULTI_CHART_PANES, Math.trunc(value)));
}

export function MultiChartWorkspace({
  workspaceId,
  paneCount,
  primary,
  seed,
  symbols,
  timeframeOptions,
  chartTypeOptions,
  renderSecondary,
}: MultiChartWorkspaceProps) {
  const count = normalizeMultiChartPaneCount(paneCount);
  const [secondaryPanes, setSecondaryPanes] = useState<MultiChartPaneConfiguration[]>(() =>
    readStoredPanes(workspaceId, seed),
  );
  const [indicatorMenuPane, setIndicatorMenuPane] = useState<string | null>(null);
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);

  useEffect(() => {
    setSecondaryPanes(readStoredPanes(workspaceId, seed));
    setIndicatorMenuPane(null);
    setMaximizedPane(null);
  }, [workspaceId]);

  useEffect(() => {
    const required = count - 1;
    setSecondaryPanes((current) => {
      if (current.length >= required) return current;
      const next = [...current];
      while (next.length < required) next.push(makePane(seed, next.length + 1));
      return next;
    });
  }, [count, seed]);

  useEffect(() => {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(secondaryPanes));
  }, [secondaryPanes, workspaceId]);

  const availableSymbols = useMemo(
    () => symbols.length > 0 ? symbols : [{ ...seed, rawSymbol: seed.symbolRaw } as unknown as MarketSymbolOption],
    [seed, symbols],
  );

  const updatePane = (paneId: string, key: keyof MultiChartPaneConfiguration, value: SetStateAction<unknown>) => {
    setSecondaryPanes((current) => current.map((pane) => {
      if (pane.id !== paneId) return pane;
      const previous = pane[key];
      const nextValue = typeof value === "function"
        ? (value as (currentValue: unknown) => unknown)(previous)
        : value;
      return { ...pane, [key]: nextValue };
    }));
  };

  const panes = [
    <div className="multi-chart-pane primary" data-pane-id="pane-1" key="pane-1">
      {primary}
      {count > 1 && <span className="multi-chart-primary-badge">PRIMARY · 1</span>}
    </div>,
    ...secondaryPanes.slice(0, count - 1).map((pane, index) => {
      const marketSymbol = availableSymbols.find((item) => item.rawSymbol === pane.symbolRaw) ?? availableSymbols[0];
      const update: PaneFieldUpdater = (key, value) => updatePane(pane.id, key, value as SetStateAction<unknown>);
      const indicatorMenuOpen = indicatorMenuPane === pane.id;
      return (
        <div className="multi-chart-pane secondary" data-pane-id={pane.id} key={pane.id}>
          {renderSecondary(pane, marketSymbol, update)}
          <div className="multi-chart-pane-controls" aria-label={`Chart pane ${index + 2} controls`}>
            <b>{index + 2}</b>
            <select aria-label={`Pane ${index + 2} symbol`} value={marketSymbol.rawSymbol} onChange={(event) => update("symbolRaw", event.target.value)}>
              {availableSymbols.map((item) => <option value={item.rawSymbol} key={item.rawSymbol}>{item.label}</option>)}
            </select>
            <select aria-label={`Pane ${index + 2} timeframe`} value={pane.timeframe} onChange={(event) => update("timeframe", event.target.value as Timeframe)}>
              {timeframeOptions.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
            </select>
            <select aria-label={`Pane ${index + 2} chart type`} value={pane.chartType} onChange={(event) => update("chartType", event.target.value as ChartDisplayType)}>
              {chartTypeOptions.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
            </select>
            <button type="button" className={indicatorMenuOpen ? "active" : ""} onClick={() => setIndicatorMenuPane(indicatorMenuOpen ? null : pane.id)} title="Independent indicator set"><Activity size={13} /></button>
            <button type="button" onClick={() => setMaximizedPane(maximizedPane === pane.id ? null : pane.id)} title={maximizedPane === pane.id ? "Restore grid" : "Maximize pane"}>{maximizedPane === pane.id ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
          </div>
          {indicatorMenuOpen && (
            <div className="multi-chart-indicator-menu" role="dialog" aria-label={`Pane ${index + 2} indicators`}>
              <header><strong>INDEPENDENT INDICATORS</strong><span>{marketSymbol.label} · {pane.timeframe}</span></header>
              <div>
                {(Object.keys(indicatorLabels) as Array<keyof VisibleIndicators>).map((key) => (
                  <label key={key}>
                    <input type="checkbox" checked={pane.visibleIndicators[key]} onChange={(event) => update("visibleIndicators", (current) => ({ ...current, [key]: event.target.checked }))} />
                    <span>{indicatorLabels[key]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }),
  ];

  const visiblePanes = maximizedPane ? panes.filter((pane) => pane.props["data-pane-id"] === maximizedPane) : panes;

  return <div className={`multi-chart-grid panes-${maximizedPane ? 1 : count}`} data-pane-count={count}>{visiblePanes}</div>;
}
