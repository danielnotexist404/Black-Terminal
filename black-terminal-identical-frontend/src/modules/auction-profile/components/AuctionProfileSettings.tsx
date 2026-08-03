import { useState, type Dispatch, type SetStateAction } from "react";
import { AUCTION_PROFILE_DEFAULT_SETTINGS, AUCTION_PROFILE_LOOKBACK_OPTIONS } from "../core/settings.ts";
import type { AuctionProfileSettings } from "../core/types.ts";

const OFF_CHART_METRICS: Array<{ value: AuctionProfileSettings["offChartMetrics"][number]; label: string }> = [
  { value: "CVD_DELTA", label: "CVD Delta" },
  { value: "CVD_ACCELERATION", label: "CVD Acceleration" },
  { value: "CVD_EFFICIENCY", label: "CVD Efficiency" },
  { value: "CVD_PERSISTENCE", label: "CVD Persistence" },
  { value: "BUY_SELL_IMBALANCE", label: "Buy/Sell Imbalance" },
  { value: "POC_MIGRATION", label: "POC Migration" },
  { value: "VALUE_MIGRATION", label: "Value Migration" },
  { value: "VOLATILITY", label: "Volatility" },
  { value: "PARKINSON_VOLATILITY", label: "Parkinson Volatility" },
  { value: "PROFILE_ENTROPY", label: "Profile Entropy" },
  { value: "NODE_STRENGTH", label: "Node Strength" }
];

function toDateTimeLocal(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type Props = {
  settings: AuctionProfileSettings;
  onChange: Dispatch<SetStateAction<AuctionProfileSettings>>;
  onClose: () => void;
};

export function AuctionProfileSettingsPanel({ settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<"engine" | "scope" | "grid" | "nodes" | "style" | "quality">("engine");
  const patch = (value: Partial<AuctionProfileSettings>) => onChange(current => ({ ...current, ...value }));
  const patchRendering = (value: Partial<AuctionProfileSettings["rendering"]>) => onChange(current => ({ ...current, rendering: { ...current.rendering, ...value } }));
  const patchNodes = (value: Partial<AuctionProfileSettings["nodeDetection"]>) => onChange(current => ({ ...current, nodeDetection: { ...current.nodeDetection, ...value } }));
  const patchWeights = (value: Partial<AuctionProfileSettings["hybridWeights"]>) => onChange(current => ({ ...current, hybridWeights: { ...current.hybridWeights, ...value } }));
  const patchTime = (key: "fixedStartTime" | "fixedEndTime", value: string) => patch({ [key]: value ? Math.floor(Date.parse(value) / 1000) : undefined });
  const toggleOffChartMetric = (metric: AuctionProfileSettings["offChartMetrics"][number], checked: boolean) => onChange(current => ({
    ...current,
    offChartMetrics: checked ? [...new Set([...current.offChartMetrics, metric])] : current.offChartMetrics.filter(item => item !== metric)
  }));

  return (
    <div className="indicator-settings auction-profile-settings" role="dialog" aria-label="Auction Profile settings" data-testid="auction-profile-settings">
      <div className="indicator-settings-title"><span>Auction Profile · BC-MEAP</span><button type="button" onClick={onClose}>DONE</button></div>
      <div className="indicator-settings-tabs" role="tablist">
        {(["engine", "scope", "grid", "nodes", "style", "quality"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item.toUpperCase()}</button>)}
      </div>

      {tab === "engine" && <div className="indicator-settings-section">
        <b>Calculation Engine</b>
        <label>Implementation<select value={settings.implementationMode} onChange={event => patch({ implementationMode: event.target.value as AuctionProfileSettings["implementationMode"] })}><option value="BLACK_CORE_NATIVE">Black Core Native</option><option value="PINE_COMPATIBILITY">Pine Compatibility</option></select></label>
        <label>Engine<select value={settings.calculationEngine} onChange={event => patch({ calculationEngine: event.target.value as AuctionProfileSettings["calculationEngine"] })}>
          <option value="CVD_REAL_TRADES">CVD · Real Trades</option><option value="CVD_PINE_COMPATIBLE">CVD · Pine Compatible</option><option value="VOLUME">Volume</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="DELTA_VOLUME">Delta Volume</option><option value="IMBALANCE_RATIO">Imbalance Ratio</option><option value="TPO">TPO</option><option value="ACTIVITY">Activity</option><option value="USD_VOLUME">USD Volume</option><option value="REALIZED_VOLATILITY">Realized Volatility</option><option value="PARKINSON_VOLATILITY">Parkinson Volatility</option><option value="GARMAN_KLASS_VOLATILITY">Garman-Klass Volatility</option><option value="RANGE_EXPANSION">Range Expansion</option><option value="TRADE_COUNT">Trade Count</option><option value="AVERAGE_TRADE_SIZE">Average Trade Size</option><option value="LIQUIDITY_WEIGHTED_ACTIVITY">Liquidity-Weighted Activity</option><option value="HYBRID_AUCTION_SCORE">Hybrid Auction Score</option>
        </select></label>
        <label>CVD Metric<select value={settings.cvdMetric} onChange={event => patch({ cvdMetric: event.target.value as AuctionProfileSettings["cvdMetric"] })}><option value="NET_CVD">Net CVD</option><option value="ABSOLUTE_CVD">Absolute CVD</option><option value="POSITIVE_CVD">Positive CVD</option><option value="NEGATIVE_CVD">Negative CVD</option><option value="CVD_IMBALANCE_RATIO">CVD Imbalance Ratio</option><option value="CVD_EFFICIENCY">CVD Efficiency</option><option value="CVD_ACCELERATION">CVD Acceleration</option><option value="CVD_PERSISTENCE">CVD Persistence</option><option value="CVD_DIVERGENCE">CVD Divergence</option></select></label>
        {settings.calculationEngine === "HYBRID_AUCTION_SCORE" && <>
          <b>Hybrid Weights</b>
          {(Object.keys(settings.hybridWeights) as Array<keyof AuctionProfileSettings["hybridWeights"]>).map(key => <label key={key}>{key.replace(/([A-Z])/g, " $1")} ({settings.hybridWeights[key].toFixed(2)})<input type="range" min={0} max={2} step={0.01} value={settings.hybridWeights[key]} onChange={event => patchWeights({ [key]: Number(event.target.value) })} /></label>)}
        </>}
        <small>Pine Compatibility preserves the original model and documented anomalies. Native mode uses canonical aggressor-side trades when available.</small>
      </div>}

      {tab === "scope" && <div className="indicator-settings-section">
        <b>Scope / Composite</b>
        <label>Scope<select value={settings.scopeMode} onChange={event => patch({ scopeMode: event.target.value as AuctionProfileSettings["scopeMode"] })}><option value="SESSION">Session</option><option value="ROLLING">Rolling</option><option value="FIXED_START">Fixed Start</option><option value="VISIBLE_RANGE">Visible Range</option><option value="COMPOSITE">Composite</option><option value="PERIODIC_COMPOSITE">Periodic Composite</option><option value="MACRO_COMPOSITE">Macro Composite</option><option value="MANUAL_RANGE">Manual Range</option></select></label>
        <label>Lookback<select value={settings.lookbackBars} onChange={event => patch({ lookbackBars: Number(event.target.value) })}>{AUCTION_PROFILE_LOOKBACK_OPTIONS.map(value => <option key={value} value={value}>{value.toLocaleString()} bars</option>)}</select></label>
        <label>Session<select value={settings.sessionTemplate} onChange={event => patch({ sessionTemplate: event.target.value as AuctionProfileSettings["sessionTemplate"] })}><option value="UTC_DAY">UTC Day</option><option value="EXCHANGE_DAY">Exchange Day</option><option value="ASIA">Asia</option><option value="LONDON">London</option><option value="NEW_YORK">New York</option><option value="WEEK">Week</option><option value="MONTH">Month</option><option value="CUSTOM">Custom</option></select></label>
        <label>Session Timezone<input type="text" value={settings.sessionTimezone} onChange={event => patch({ sessionTimezone: event.target.value })} /></label>
        <label>Initial Balance (minutes)<input type="number" min={1} max={1440} value={settings.initialBalanceMinutes} onChange={event => patch({ initialBalanceMinutes: Number(event.target.value) })} /></label>
        {(settings.scopeMode === "FIXED_START" || settings.scopeMode === "MANUAL_RANGE") && <label>Start Time<input type="datetime-local" value={toDateTimeLocal(settings.fixedStartTime)} onChange={event => patchTime("fixedStartTime", event.target.value)} /></label>}
        {settings.scopeMode === "MANUAL_RANGE" && <label>End Time<input type="datetime-local" value={toDateTimeLocal(settings.fixedEndTime)} onChange={event => patchTime("fixedEndTime", event.target.value)} /></label>}
        {settings.scopeMode === "PERIODIC_COMPOSITE" && <>
          <label>Period<select value={settings.periodicity} onChange={event => patch({ periodicity: event.target.value as AuctionProfileSettings["periodicity"] })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="CUSTOM_BARS">Custom Bars</option><option value="CUSTOM_HOURS">Custom Hours</option></select></label>
          {settings.periodicity === "CUSTOM_BARS" && <label>Period Bars<input type="number" min={1} max={20000} value={settings.periodicBars} onChange={event => patch({ periodicBars: Number(event.target.value) })} /></label>}
          {settings.periodicity === "CUSTOM_HOURS" && <label>Period Hours<input type="number" min={1} max={8784} value={settings.periodicHours} onChange={event => patch({ periodicHours: Number(event.target.value) })} /></label>}
        </>}
        {settings.sessionTemplate === "CUSTOM" && <><label>Custom Start Minute<input type="number" min={0} max={1439} value={settings.customSessionStartMinute} onChange={event => patch({ customSessionStartMinute: Number(event.target.value) })} /></label><label>Custom End Minute<input type="number" min={1} max={1440} value={settings.customSessionEndMinute} onChange={event => patch({ customSessionEndMinute: Number(event.target.value) })} /></label></>}
        <label>Lock Composite<input type="checkbox" checked={settings.compositeLocked} onChange={event => patch({ compositeLocked: event.target.checked })} /></label>
        <small>Only Visible Range and Visible Pixel Adaptive rows depend on the camera. Other grids do not change when the chart is zoomed.</small>
      </div>}

      {tab === "grid" && <div className="indicator-settings-section">
        <b>Price Grid / Value Area</b>
        <label>Row Sizing<select value={settings.rowSizingMode} onChange={event => patch({ rowSizingMode: event.target.value as AuctionProfileSettings["rowSizingMode"] })}><option value="AUTO">Auto</option><option value="TICKS">Ticks</option><option value="PRICE">Fixed Price</option><option value="BASIS_POINTS">Basis Points</option><option value="ATR_FRACTION">ATR Fraction</option><option value="FIXED_ROW_COUNT">Fixed Row Count</option><option value="VISIBLE_PIXEL_ADAPTIVE">Visible Pixel Adaptive</option></select></label>
        <label>Target Rows<input type="number" min={16} max={4096} value={settings.targetRows} onChange={event => patch({ targetRows: Number(event.target.value) })} /></label>
        <label>Maximum Rows<input type="number" min={16} max={4096} value={settings.maximumRows} onChange={event => patch({ maximumRows: Number(event.target.value) })} /></label>
        <label>Ticks per Row<input type="number" min={1} value={settings.ticksPerRow} onChange={event => patch({ ticksPerRow: Number(event.target.value) })} /></label>
        {settings.rowSizingMode === "PRICE" && <label>Price per Row<input type="number" min={0.00000001} step="any" value={settings.rowSizePrice} onChange={event => patch({ rowSizePrice: Number(event.target.value) })} /></label>}
        {settings.rowSizingMode === "BASIS_POINTS" && <label>Basis Points per Row<input type="number" min={0.01} step={0.01} value={settings.basisPointsPerRow} onChange={event => patch({ basisPointsPerRow: Number(event.target.value) })} /></label>}
        {settings.rowSizingMode === "ATR_FRACTION" && <label>ATR Fraction<input type="number" min={0.001} step={0.01} value={settings.atrFraction} onChange={event => patch({ atrFraction: Number(event.target.value) })} /></label>}
        <label>Grid Anchor<select value={settings.gridAnchor} onChange={event => patch({ gridAnchor: event.target.value as AuctionProfileSettings["gridAnchor"] })}><option value="INSTRUMENT_TICK_ORIGIN">Instrument Tick Origin</option><option value="PROFILE_OPEN">Profile Open</option><option value="ROUND_NUMBER">Round Number</option><option value="FIXED_ORIGIN">Fixed Origin</option><option value="MANUAL_ORIGIN">Manual Origin</option></select></label>
        {settings.gridAnchor === "MANUAL_ORIGIN" && <label>Manual Grid Origin<input type="number" step="any" value={settings.manualGridOrigin ?? ""} onChange={event => patch({ manualGridOrigin: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>}
        <label>Value Area ({Math.round(settings.valueAreaFraction * 100)}%)<input type="range" min={50} max={95} value={settings.valueAreaFraction * 100} onChange={event => patch({ valueAreaFraction: Number(event.target.value) / 100 })} /></label>
        <label>Value Area Basis<select value={settings.valueAreaBasis} onChange={event => patch({ valueAreaBasis: event.target.value as AuctionProfileSettings["valueAreaBasis"] })}><option value="SELECTED_ENGINE">Selected Engine</option><option value="TOTAL_VOLUME">Total Volume</option><option value="ABSOLUTE_VALUE">Absolute Value</option><option value="POSITIVE_SIDE">Positive Side</option><option value="NEGATIVE_SIDE">Negative Side</option><option value="TPO">TPO</option><option value="HYBRID">Hybrid</option></select></label>
        <label>POC Basis<select value={settings.pocBasis} onChange={event => patch({ pocBasis: event.target.value as AuctionProfileSettings["pocBasis"] })}><option value="MAXIMUM_SELECTED_METRIC">Maximum Selected Metric</option><option value="MAXIMUM_ABSOLUTE_METRIC">Maximum Absolute Metric</option><option value="MAXIMUM_POSITIVE_METRIC">Maximum Positive Metric</option><option value="MINIMUM_NEGATIVE_METRIC">Minimum Negative Metric</option><option value="MAXIMUM_TOTAL_VOLUME">Maximum Total Volume</option><option value="MAXIMUM_TPO">Maximum TPO</option><option value="HYBRID">Hybrid</option></select></label>
      </div>}

      {tab === "nodes" && <div className="indicator-settings-section">
        <b>LVN / HVN Intelligence</b>
        <label>Source<select value={settings.nodeDetection.source} onChange={event => patchNodes({ source: event.target.value as AuctionProfileSettings["nodeDetection"]["source"] })}><option value="ABSOLUTE_CVD">Absolute CVD</option><option value="NET_CVD">Net CVD</option><option value="CVD_EFFICIENCY">CVD Efficiency</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="DELTA_IMBALANCE">Delta Imbalance</option><option value="VOLUME">Volume</option><option value="TPO">TPO</option><option value="VOLATILITY">Volatility</option><option value="PARKINSON">Parkinson</option><option value="HYBRID">Hybrid</option></select></label>
        <label>Method<select value={settings.nodeDetection.method} onChange={event => patchNodes({ method: event.target.value as AuctionProfileSettings["nodeDetection"]["method"] })}><option value="HYBRID">Hybrid</option><option value="PERCENTILE">Percentile</option><option value="LOCAL_MINIMA">Local Minima</option><option value="PROMINENCE">Prominence</option><option value="Z_SCORE">Z-Score</option><option value="ADAPTIVE_VALLEY">Adaptive Valley</option><option value="KERNEL_SMOOTHED_VALLEY">Kernel-Smoothed Valley</option></select></label>
        <label>Sensitivity ({settings.nodeDetection.sensitivityPercentile}%)<input type="range" min={1} max={49} value={settings.nodeDetection.sensitivityPercentile} onChange={event => patchNodes({ sensitivityPercentile: Number(event.target.value) })} /></label>
        <label>Prominence ({Math.round(settings.nodeDetection.prominence * 100)}%)<input type="range" min={0} max={80} value={settings.nodeDetection.prominence * 100} onChange={event => patchNodes({ prominence: Number(event.target.value) / 100 })} /></label>
        <label>Neighborhood<input type="number" min={1} max={50} value={settings.nodeDetection.neighborhood} onChange={event => patchNodes({ neighborhood: Number(event.target.value) })} /></label>
        <label>Minimum Width Rows<input type="number" min={1} max={100} value={settings.nodeDetection.minimumWidthRows} onChange={event => patchNodes({ minimumWidthRows: Number(event.target.value) })} /></label>
        <label>Maximum Gap Rows<input type="number" min={0} max={50} value={settings.nodeDetection.maximumGapRows} onChange={event => patchNodes({ maximumGapRows: Number(event.target.value) })} /></label>
        <label>Merge Contiguous Rows<input type="checkbox" checked={settings.nodeDetection.mergeContiguousRows} onChange={event => patchNodes({ mergeContiguousRows: event.target.checked })} /></label>
        <label>Show LVNs<input type="checkbox" checked={settings.nodeDetection.showLvns} onChange={event => patchNodes({ showLvns: event.target.checked })} /></label>
        <label>Show HVNs<input type="checkbox" checked={settings.nodeDetection.showHvns} onChange={event => patchNodes({ showHvns: event.target.checked })} /></label>
      </div>}

      {tab === "style" && <div className="indicator-settings-section">
        <b>Black Terminal Rendering</b>
        <label>Display<select value={settings.rendering.displayStyle} onChange={event => patchRendering({ displayStyle: event.target.value as AuctionProfileSettings["rendering"]["displayStyle"] })}><option value="COMBINED">Combined</option><option value="HEATMAP_BLOCKS">Heatmap Blocks</option><option value="HORIZONTAL_HISTOGRAM">Horizontal Histogram</option><option value="PROFILE_COLUMNS">Profile Columns</option><option value="LETTERS_TPO">TPO Letters</option><option value="CONTOUR">Contour</option><option value="NODES_ONLY">Nodes Only</option><option value="STRUCTURAL_ZONES">Structural Zones</option></select></label>
        <label>Palette<select value={settings.rendering.palette} onChange={event => patchRendering({ palette: event.target.value as AuctionProfileSettings["rendering"]["palette"] })}><option value="BLACK_TERMINAL_INSTITUTIONAL">Black Terminal Institutional</option><option value="ORIGINAL">Original</option><option value="THERMAL">Thermal</option><option value="BLOOD_RED">Blood Red</option><option value="CVD_DIRECTIONAL">CVD Directional</option><option value="MONOCHROME">Monochrome</option><option value="CUSTOM">Custom</option></select></label>
        <label>Width ({settings.rendering.widthPercent}%)<input type="range" min={5} max={100} value={settings.rendering.widthPercent} onChange={event => patchRendering({ widthPercent: Number(event.target.value) })} /></label>
        <label>Opacity ({Math.round(settings.rendering.opacity * 100)}%)<input type="range" min={2} max={100} value={settings.rendering.opacity * 100} onChange={event => patchRendering({ opacity: Number(event.target.value) / 100 })} /></label>
        <label>Brightness ({settings.rendering.brightness}%)<input type="range" min={10} max={300} step={5} value={settings.rendering.brightness} onChange={event => patchRendering({ brightness: Number(event.target.value) })} /></label>
        <label>Positive<input type="color" value={settings.rendering.positiveColor} onChange={event => patchRendering({ positiveColor: event.target.value })} /></label><label>Negative<input type="color" value={settings.rendering.negativeColor} onChange={event => patchRendering({ negativeColor: event.target.value })} /></label><label>Balanced<input type="color" value={settings.rendering.balancedColor} onChange={event => patchRendering({ balancedColor: event.target.value })} /></label>
        <label>Value Area<input type="color" value={settings.rendering.valueAreaColor} onChange={event => patchRendering({ valueAreaColor: event.target.value })} /></label><label>POC<input type="color" value={settings.rendering.pocColor} onChange={event => patchRendering({ pocColor: event.target.value })} /></label><label>LVN<input type="color" value={settings.rendering.lvnColor} onChange={event => patchRendering({ lvnColor: event.target.value })} /></label><label>HVN<input type="color" value={settings.rendering.hvnColor} onChange={event => patchRendering({ hvnColor: event.target.value })} /></label>
        <label>Show Values<input type="checkbox" checked={settings.rendering.showText} onChange={event => patchRendering({ showText: event.target.checked })} /></label><label>Show Key Levels<input type="checkbox" checked={settings.rendering.showKeyLevels} onChange={event => patchRendering({ showKeyLevels: event.target.checked })} /></label><label>Show Node Labels<input type="checkbox" checked={settings.rendering.showNodeLabels} onChange={event => patchRendering({ showNodeLabels: event.target.checked })} /></label>
        <label>Show Value Area<input type="checkbox" checked={settings.rendering.showValueArea} onChange={event => patchRendering({ showValueArea: event.target.checked })} /></label><label>Show Initial Balance<input type="checkbox" checked={settings.rendering.showInitialBalance} onChange={event => patchRendering({ showInitialBalance: event.target.checked })} /></label><label>Show Off-Chart Panel<input type="checkbox" checked={settings.rendering.showOffChart} onChange={event => patchRendering({ showOffChart: event.target.checked })} /></label>
        {settings.rendering.showOffChart && <>{OFF_CHART_METRICS.map(metric => <label key={metric.value}>{metric.label}<input type="checkbox" checked={settings.offChartMetrics.includes(metric.value)} onChange={event => toggleOffChartMetric(metric.value, event.target.checked)} /></label>)}</>}
      </div>}

      {tab === "quality" && <div className="indicator-settings-section">
        <b>Data Quality</b>
        <label>Source<select value={settings.dataSource} onChange={event => patch({ dataSource: event.target.value as AuctionProfileSettings["dataSource"] })}><option value="HYBRID">Hybrid · Exact + Fallback</option><option value="LIVE_TRADE_STREAM">Live Trade Stream Only</option><option value="HISTORICAL_TRADE_ARCHIVE">Historical Trade Archive</option><option value="LOWER_TIMEFRAME_BARS">Lower-Timeframe Approximation</option><option value="CHART_BARS">Chart-Bar Approximation</option></select></label>
        {settings.dataSource === "HYBRID" && <label>Fallback Source<select value={settings.fallbackSource} onChange={event => patch({ fallbackSource: event.target.value as AuctionProfileSettings["fallbackSource"] })}><option value="CHART_BARS">Chart Bars</option><option value="LOWER_TIMEFRAME_BARS">Lower-Timeframe Bars</option><option value="HISTORICAL_TRADE_ARCHIVE">Historical Trade Archive</option><option value="LIVE_TRADE_STREAM">Live Trade Stream</option></select></label>}
        <label>Lower Timeframe<select value={settings.lowerTimeframe} onChange={event => patch({ lowerTimeframe: event.target.value as AuctionProfileSettings["lowerTimeframe"] })}><option value="1s">1 second</option><option value="10s">10 seconds</option><option value="30s">30 seconds</option><option value="1m">1 minute</option><option value="3m">3 minutes</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="30m">30 minutes</option><option value="1h">1 hour</option></select></label>
        <label>Unknown Aggressor<select value={settings.unknownSideHandling} onChange={event => patch({ unknownSideHandling: event.target.value as AuctionProfileSettings["unknownSideHandling"] })}><option value="SEPARATE">Keep Separate</option><option value="EXCLUDE_DIRECTIONAL">Exclude Directional</option></select></label>
        <label>Price Allocation<select value={settings.priceAllocation} onChange={event => patch({ priceAllocation: event.target.value as AuctionProfileSettings["priceAllocation"] })}><option value="TRADE_AT_PRICE_EXACT">Trade at Price · Exact</option><option value="VOLUME_AT_PRICE_EXACT">Volume at Price · Exact</option><option value="BODY_WICK_WEIGHTED">Body/Wick Weighted</option><option value="UNIFORM_BAR_RANGE">Uniform Bar Range</option><option value="CLOSE_WEIGHTED">Close Weighted</option><option value="TYPICAL_PRICE_WEIGHTED">Typical Price Weighted</option><option value="GAUSSIAN_AROUND_VWAP">Gaussian around VWAP</option><option value="HYBRID">Hybrid</option></select></label>
        <label>TPO Bracket (minutes)<input type="number" min={1} max={1440} value={settings.tpoBracketMinutes} onChange={event => patch({ tpoBracketMinutes: Number(event.target.value) })} /></label>
        <label>Volatility Annualization<select value={settings.volatilityAnnualization} onChange={event => patch({ volatilityAnnualization: event.target.value as AuctionProfileSettings["volatilityAnnualization"] })}><option value="NONE">None</option><option value="CRYPTO_365">Crypto 365</option><option value="CALENDAR_365">Calendar 365</option><option value="CUSTOM">Custom</option></select></label>
        {settings.volatilityAnnualization === "CUSTOM" && <label>Annualization Periods<input type="number" min={1} value={settings.annualizationPeriods} onChange={event => patch({ annualizationPeriods: Number(event.target.value) })} /></label>}
        <label>Show Diagnostics<input type="checkbox" checked={settings.diagnosticsVisible} onChange={event => patch({ diagnosticsVisible: event.target.checked })} /></label>
        <small>Exact, mixed, and approximate coverage are always reported separately. The terminal never labels candle-derived history as exact CVD.</small>
      </div>}
      <button type="button" className="tv-defaults" onClick={() => onChange(structuredClone(AUCTION_PROFILE_DEFAULT_SETTINGS))}>Defaults</button>
    </div>
  );
}
