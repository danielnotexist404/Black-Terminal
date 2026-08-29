import { useState, type Dispatch, type SetStateAction } from "react";
import { AUCTION_PROFILE_DEFAULT_SETTINGS, AUCTION_PROFILE_LOOKBACK_OPTIONS } from "../core/settings.ts";
import { configureAuctionProfileEngine } from "../core/engineContract.ts";
import { RADAP_DISPLAY_NAME } from "../core/identity.ts";
import { auctionScopeUsesSessionControls } from "../core/scope.ts";
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
  const sessionControlsVisible = auctionScopeUsesSessionControls(settings.scopeMode);
  const patch = (value: Partial<AuctionProfileSettings>) => onChange(current => ({ ...current, ...value }));
  const patchRendering = (value: Partial<AuctionProfileSettings["rendering"]>) => onChange(current => ({ ...current, rendering: { ...current.rendering, ...value } }));
  const patchNodes = (value: Partial<AuctionProfileSettings["nodeDetection"]>) => onChange(current => ({ ...current, nodeDetection: { ...current.nodeDetection, ...value } }));
  const patchWeights = (value: Partial<AuctionProfileSettings["hybridWeights"]>) => onChange(current => ({ ...current, hybridWeights: { ...current.hybridWeights, ...value } }));
  const patchTime = (key: "fixedStartTime" | "fixedEndTime", value: string) => patch({ [key]: value ? Math.floor(Date.parse(value) / 1000) : undefined });
  const toggleOffChartMetric = (metric: AuctionProfileSettings["offChartMetrics"][number], checked: boolean) => onChange(current => ({
    ...current,
    offChartMetrics: checked ? [...new Set([...current.offChartMetrics, metric])] : current.offChartMetrics.filter(item => item !== metric)
  }));
  const selectEngine = (engine: AuctionProfileSettings["calculationEngine"]) => onChange(current => configureAuctionProfileEngine(current, engine));
  const applyPreset = (preset: "PINE" | "SESSION" | "MACRO" | "DEEP_MACRO" | "FOOTPRINT") => onChange(current => {
    const next = structuredClone(current);
    next.rendering.profileWidthAuto = false;
    if (preset === "PINE") {
      next.implementationMode = "PINE_COMPATIBILITY";
      next.scopeMode = "SESSION";
      next.calculationEngine = "CVD_PINE_COMPATIBLE";
      next.blockResolution = "CHART_TIMEFRAME";
      next.rendering.visualizationType = "AUCTION_PROFILE";
      next.rendering.profileBodyStyle = "HDLX_CVD_BLOCKS";
      next.rendering.profileBlockValueMode = "CUMULATIVE_CVD";
      next.rendering.profileGeometry = "SINGLE_SIDED_RIGHT";
      next.rendering.profilePlacement = "RANGE_START";
      next.rendering.profileWidthMetric = "CVD_ACTIVITY";
      next.rendering.timeSegmentsMode = "STACKED";
      next.rendering.rowLabelMode = "OFF";
      next.rendering.cellTextMode = "ALWAYS";
      next.rendering.widthPercent = 30;
      next.rendering.profileSide = "LEFT";
      next.rendering.profileLengthPercent = 75;
    } else if (preset === "SESSION") {
      next.implementationMode = "BLACK_CORE_NATIVE";
      next.scopeMode = "SESSION";
      next.calculationEngine = "CVD_REAL_TRADES";
      next.cvdMetric = "NET_CVD";
      next.rendering.visualizationType = "AUCTION_PROFILE";
      next.rendering.profileBodyStyle = "HDLX_CVD_BLOCKS";
      next.rendering.profileBlockValueMode = "CUMULATIVE_CVD";
      next.rendering.profileGeometry = "SINGLE_SIDED_RIGHT";
      next.rendering.profilePlacement = "RANGE_START";
      next.rendering.profileWidthMetric = "CVD_ACTIVITY";
      next.rendering.timeSegmentsMode = "STACKED";
      next.rendering.rowLabelMode = "OFF";
      next.rendering.cellTextMode = "ALWAYS";
      next.rendering.widthPercent = 30;
      next.rendering.profileSide = "LEFT";
      next.rendering.profileLengthPercent = 75;
    } else if (preset === "MACRO") {
      next.implementationMode = "BLACK_CORE_NATIVE";
      next.scopeMode = "MACRO_COMPOSITE";
      next.calculationEngine = "CVD_REAL_TRADES";
      next.cvdMetric = "NET_CVD";
      next.lookbackBars = 5000;
      next.blockResolution = "ADAPTIVE";
      next.rendering.visualizationType = "AUCTION_PROFILE";
      next.rendering.profileBodyStyle = "HDLX_CVD_BLOCKS";
      next.rendering.profileBlockValueMode = "CUMULATIVE_CVD";
      next.rendering.profileGeometry = "SINGLE_SIDED_RIGHT";
      next.rendering.profilePlacement = "RANGE_START";
      next.rendering.profileWidthMetric = "CVD_ACTIVITY";
      next.rendering.widthPercent = 32;
      next.rendering.timeSegmentsMode = "STACKED";
      next.rendering.rowLabelMode = "OFF";
      next.rendering.cellTextMode = "ALWAYS";
      next.rendering.profileSide = "LEFT";
      next.rendering.profileLengthPercent = 75;
      next.nodeDetection.showLvns = true;
      next.nodeDetection.showHvns = true;
      next.nodeDetection.lvnGapAware = true;
      next.rendering.structuralDetail = "STANDARD";
      next.rendering.maximumVisibleLvns = Math.max(6, next.rendering.maximumVisibleLvns);
      next.rendering.maximumVisibleStructuralZones = Math.max(8, next.rendering.maximumVisibleStructuralZones);
    } else if (preset === "DEEP_MACRO") {
      next.implementationMode = "BLACK_CORE_NATIVE";
      next.scopeMode = "MACRO_COMPOSITE";
      next.calculationEngine = "CVD_REAL_TRADES";
      next.cvdMetric = "NET_CVD";
      next.lookbackBars = 20000;
      next.rendering.visualizationType = "AUCTION_PROFILE";
      next.rendering.profileBodyStyle = "HDLX_CVD_BLOCKS";
      next.rendering.profileBlockValueMode = "CUMULATIVE_CVD";
      next.rendering.profileGeometry = "SINGLE_SIDED_RIGHT";
      next.rendering.profilePlacement = "RANGE_START";
      next.rendering.profileWidthMetric = "CVD_ACTIVITY";
      next.rendering.widthPercent = 36;
      next.rendering.timeSegmentsMode = "STACKED";
      next.rendering.rowLabelMode = "OFF";
      next.rendering.cellTextMode = "ALWAYS";
      next.rendering.profileSide = "LEFT";
      next.rendering.profileLengthPercent = 75;
      next.nodeDetection.showLvns = true;
      next.nodeDetection.showHvns = true;
      next.nodeDetection.lvnGapAware = true;
      next.rendering.structuralDetail = "DETAILED";
      next.rendering.maximumVisibleLvns = Math.max(12, next.rendering.maximumVisibleLvns);
      next.rendering.maximumVisibleStructuralZones = Math.max(16, next.rendering.maximumVisibleStructuralZones);
    } else {
      next.implementationMode = "BLACK_CORE_NATIVE";
      next.scopeMode = "ROLLING";
      next.calculationEngine = "CVD_REAL_TRADES";
      next.cvdMetric = "NET_CVD";
      next.rendering.visualizationType = "CVD_FOOTPRINT";
      next.rendering.cellTextMode = "AUTO";
      next.rendering.cellBorder = "SUBTLE";
    }
    return configureAuctionProfileEngine(next, next.calculationEngine);
  });

  return (
    <div className="indicator-settings auction-profile-settings" role="dialog" aria-label="RADAP settings" data-testid="auction-profile-settings">
      <div className="indicator-settings-title"><span>{RADAP_DISPLAY_NAME}</span><button type="button" onClick={onClose}>DONE</button></div>
      <div className="indicator-settings-tabs" role="tablist">
        {(["engine", "scope", "grid", "nodes", "style", "quality"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item.toUpperCase()}</button>)}
      </div>

      {tab === "engine" && <div className="indicator-settings-section">
        <b>Visualization</b>
        <label>Renderer<select value={settings.rendering.visualizationType} onChange={event => patchRendering({ visualizationType: event.target.value as AuctionProfileSettings["rendering"]["visualizationType"] })}><option value="AUCTION_PROFILE">RADAP Profile</option><option value="CVD_FOOTPRINT">CVD Footprint</option><option value="COMBINED">RADAP + Footprint</option></select></label>
        <small>Profile builds an HDLX-style silhouette from chronological CVD matrix blocks. Footprint remains the separate candle-aligned time × price view.</small>
        <b>Presets</b>
        <div className="auction-profile-presets">
          <button type="button" onClick={() => applyPreset("PINE")}>Original Pine</button><button type="button" onClick={() => applyPreset("SESSION")}>CVD Session</button>
          <button type="button" onClick={() => applyPreset("MACRO")}>CVD Macro</button><button type="button" onClick={() => applyPreset("DEEP_MACRO")}>CVD Deep Macro</button>
          <button type="button" onClick={() => applyPreset("FOOTPRINT")}>CVD Footprint</button>
        </div>
        <b>Calculation Engine</b>
        <label>Implementation<select value={settings.implementationMode} onChange={event => patch({ implementationMode: event.target.value as AuctionProfileSettings["implementationMode"] })}><option value="BLACK_CORE_NATIVE">Black Core Native</option><option value="PINE_COMPATIBILITY">Pine Compatibility</option></select></label>
        <label>Engine<select value={settings.calculationEngine} onChange={event => selectEngine(event.target.value as AuctionProfileSettings["calculationEngine"])}>
          <option value="CVD_REAL_TRADES">CVD · Real Trades</option><option value="CVD_PINE_COMPATIBLE">CVD · Pine Compatible</option><option value="VOLUME">Volume</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="DELTA_VOLUME">Delta Volume</option><option value="IMBALANCE_RATIO">Imbalance Ratio</option><option value="TPO">TPO</option><option value="ACTIVITY">Activity</option><option value="USD_VOLUME">USD Volume</option><option value="REALIZED_VOLATILITY">Realized Volatility</option><option value="PARKINSON_VOLATILITY">Parkinson Volatility</option><option value="GARMAN_KLASS_VOLATILITY">Garman-Klass Volatility</option><option value="RANGE_EXPANSION">Range Expansion</option><option value="TRADE_COUNT">Trade Count</option><option value="AVERAGE_TRADE_SIZE">Average Trade Size</option><option value="LIQUIDITY_WEIGHTED_ACTIVITY">Liquidity-Weighted Activity</option><option value="HYBRID_AUCTION_SCORE">Hybrid Auction Score</option>
        </select></label>
        {["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE"].includes(settings.calculationEngine) && <label>CVD Metric<select value={settings.cvdMetric} onChange={event => patch({ cvdMetric: event.target.value as AuctionProfileSettings["cvdMetric"] })}><option value="NET_CVD">Net CVD</option><option value="ABSOLUTE_CVD">Absolute CVD</option><option value="POSITIVE_CVD">Positive CVD</option><option value="NEGATIVE_CVD">Negative CVD</option><option value="CVD_IMBALANCE_RATIO">CVD Imbalance Ratio</option><option value="CVD_EFFICIENCY">CVD Efficiency</option><option value="CVD_ACCELERATION">CVD Acceleration</option><option value="CVD_PERSISTENCE">CVD Persistence</option><option value="CVD_DIVERGENCE">CVD Divergence</option></select></label>}
        {settings.calculationEngine === "TPO" && <label>TPO Bracket (minutes)<input type="number" min={1} max={1440} value={settings.tpoBracketMinutes} onChange={event => patch({ tpoBracketMinutes: Number(event.target.value) })} /></label>}
        {settings.calculationEngine === "HYBRID_AUCTION_SCORE" && <>
          <b>Hybrid Weights</b>
          {(Object.keys(settings.hybridWeights) as Array<keyof AuctionProfileSettings["hybridWeights"]>).map(key => <label key={key}>{key.replace(/([A-Z])/g, " $1")} ({settings.hybridWeights[key].toFixed(2)})<input type="range" min={0} max={2} step={0.01} value={settings.hybridWeights[key]} onChange={event => patchWeights({ [key]: Number(event.target.value) })} /></label>)}
        </>}
        <small>The selected engine now owns profile width, POC, value area and LVN/HVN detection. TPO renders chronological time-bracket letters; Volume builds volume-at-price; volatility engines distribute their own variance estimator by price. Exact and approximated source coverage remain explicitly separated.</small>
      </div>}

      {tab === "scope" && <div className="indicator-settings-section">
        <b>Scope / Composite</b>
        <label>Scope<select value={settings.scopeMode} onChange={event => patch({ scopeMode: event.target.value as AuctionProfileSettings["scopeMode"] })}><option value="SESSION">Session</option><option value="ROLLING">Rolling</option><option value="FIXED_START">Fixed Start</option><option value="VISIBLE_RANGE">Visible Range</option><option value="COMPOSITE">Composite</option><option value="PERIODIC_COMPOSITE">Periodic Composite</option><option value="MACRO_COMPOSITE">Macro Composite</option><option value="MANUAL_RANGE">Manual Range</option></select></label>
        <label>Lookback<select value={settings.lookbackBars} onChange={event => patch({ lookbackBars: Number(event.target.value) })}>{AUCTION_PROFILE_LOOKBACK_OPTIONS.map(value => <option key={value} value={value}>{value.toLocaleString()} bars</option>)}</select></label>
        <b>Block Construction</b>
        <label>Block Resolution<select value={settings.blockResolution} onChange={event => patch({ blockResolution: event.target.value as AuctionProfileSettings["blockResolution"] })}><option value="CHART_TIMEFRAME">Chart Timeframe</option><option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="30m">30 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option><option value="1d">1 day</option><option value="ADAPTIVE">Adaptive</option><option value="CUSTOM">Custom</option></select></label>
        {settings.blockResolution === "CUSTOM" && <label>Custom Block (minutes)<input type="number" min={1} max={525600} value={settings.customBlockMinutes} onChange={event => patch({ customBlockMinutes: Number(event.target.value) })} /></label>}
        <label>Developing Block Live<input type="checkbox" checked={settings.updateDevelopingBlock} onChange={event => patch({ updateDevelopingBlock: event.target.checked })} /></label>
        <label>Maximum Matrix Blocks<input type="number" min={16} max={20000} value={settings.maximumTimeBlocks} onChange={event => patch({ maximumTimeBlocks: Number(event.target.value) })} /></label>
        {sessionControlsVisible && <>
          <b>Session Definition</b>
          <label>Session<select value={settings.sessionTemplate} onChange={event => patch({ sessionTemplate: event.target.value as AuctionProfileSettings["sessionTemplate"] })}><option value="UTC_DAY">UTC Day</option><option value="EXCHANGE_DAY">Exchange Day</option><option value="ASIA">Asia</option><option value="LONDON">London</option><option value="NEW_YORK">New York</option><option value="WEEK">Week</option><option value="MONTH">Month</option><option value="CUSTOM">Custom</option></select></label>
          <label>Session Timezone<input type="text" value={settings.sessionTimezone} onChange={event => patch({ sessionTimezone: event.target.value })} /></label>
          <label>Initial Balance (minutes)<input type="number" min={1} max={1440} value={settings.initialBalanceMinutes} onChange={event => patch({ initialBalanceMinutes: Number(event.target.value) })} /></label>
          {settings.sessionTemplate === "CUSTOM" && <><label>Custom Start Minute<input type="number" min={0} max={1439} value={settings.customSessionStartMinute} onChange={event => patch({ customSessionStartMinute: Number(event.target.value) })} /></label><label>Custom End Minute<input type="number" min={1} max={1440} value={settings.customSessionEndMinute} onChange={event => patch({ customSessionEndMinute: Number(event.target.value) })} /></label></>}
        </>}
        {!sessionControlsVisible && <small>Continuous and anchored profiles do not reset on a session boundary. Session timezone and Initial Balance are therefore excluded from their calculation.</small>}
        {(settings.scopeMode === "FIXED_START" || settings.scopeMode === "MANUAL_RANGE") && <label>Start Time<input type="datetime-local" value={toDateTimeLocal(settings.fixedStartTime)} onChange={event => patchTime("fixedStartTime", event.target.value)} /></label>}
        {settings.scopeMode === "MANUAL_RANGE" && <label>End Time<input type="datetime-local" value={toDateTimeLocal(settings.fixedEndTime)} onChange={event => patchTime("fixedEndTime", event.target.value)} /></label>}
        {settings.scopeMode === "PERIODIC_COMPOSITE" && <>
          <label>Period<select value={settings.periodicity} onChange={event => patch({ periodicity: event.target.value as AuctionProfileSettings["periodicity"] })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="CUSTOM_BARS">Custom Bars</option><option value="CUSTOM_HOURS">Custom Hours</option></select></label>
          {settings.periodicity === "CUSTOM_BARS" && <label>Period Bars<input type="number" min={1} max={20000} value={settings.periodicBars} onChange={event => patch({ periodicBars: Number(event.target.value) })} /></label>}
          {settings.periodicity === "CUSTOM_HOURS" && <label>Period Hours<input type="number" min={1} max={8784} value={settings.periodicHours} onChange={event => patch({ periodicHours: Number(event.target.value) })} /></label>}
        </>}
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
        <label>Value Area Basis<select value={settings.valueAreaBasis} onChange={event => patch({ valueAreaBasis: event.target.value as AuctionProfileSettings["valueAreaBasis"] })}><option value="ABSOLUTE_VALUE">Absolute CVD / Value</option><option value="TOTAL_VOLUME">Total Volume</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="SELECTED_ENGINE">Selected Metric</option><option value="POSITIVE_SIDE">Positive Side</option><option value="NEGATIVE_SIDE">Negative Side</option><option value="TPO">TPO</option><option value="HYBRID">Hybrid</option></select></label>
        <label>POC Basis<select value={settings.pocBasis} onChange={event => patch({ pocBasis: event.target.value as AuctionProfileSettings["pocBasis"] })}><option value="MAXIMUM_ABSOLUTE_METRIC">Maximum Absolute CVD / Value</option><option value="MAXIMUM_POSITIVE_METRIC">Maximum Positive CVD / Value</option><option value="MINIMUM_NEGATIVE_METRIC">Maximum Negative Magnitude</option><option value="MAXIMUM_TOTAL_VOLUME">Maximum Total Volume</option><option value="MAXIMUM_SELECTED_METRIC">Maximum Selected Metric</option><option value="MAXIMUM_TPO">Maximum TPO</option><option value="HYBRID">Maximum Hybrid Score</option></select></label>
      </div>}

      {tab === "nodes" && <div className="indicator-settings-section">
        <b>LVN / HVN Intelligence</b>
        <label>Source<select value={settings.nodeDetection.source} onChange={event => patchNodes({ source: event.target.value as AuctionProfileSettings["nodeDetection"]["source"] })}><option value="SELECTED_ENGINE">Selected Engine · Linked</option><option value="ABSOLUTE_CVD">Absolute CVD</option><option value="NET_CVD">Net CVD</option><option value="CVD_EFFICIENCY">CVD Efficiency</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="DELTA_IMBALANCE">Delta Imbalance</option><option value="VOLUME">Volume</option><option value="TPO">TPO</option><option value="VOLATILITY">Volatility</option><option value="PARKINSON">Parkinson</option><option value="HYBRID">Hybrid</option></select></label>
        <label>Method<select value={settings.nodeDetection.method} onChange={event => patchNodes({ method: event.target.value as AuctionProfileSettings["nodeDetection"]["method"] })}><option value="HYBRID">Hybrid</option><option value="PERCENTILE">Percentile</option><option value="LOCAL_MINIMA">Local Minima</option><option value="PROMINENCE">Prominence</option><option value="Z_SCORE">Z-Score</option><option value="ADAPTIVE_VALLEY">Adaptive Valley</option><option value="KERNEL_SMOOTHED_VALLEY">Kernel-Smoothed Valley</option></select></label>
        <label>Sensitivity ({settings.nodeDetection.sensitivityPercentile}%)<input type="range" min={1} max={49} value={settings.nodeDetection.sensitivityPercentile} onChange={event => patchNodes({ sensitivityPercentile: Number(event.target.value) })} /></label>
        <label>Prominence ({Math.round(settings.nodeDetection.prominence * 100)}%)<input type="range" min={0} max={80} value={settings.nodeDetection.prominence * 100} onChange={event => patchNodes({ prominence: Number(event.target.value) / 100 })} /></label>
        <label>Neighborhood<input type="number" min={1} max={50} value={settings.nodeDetection.neighborhood} onChange={event => patchNodes({ neighborhood: Number(event.target.value) })} /></label>
        <label>Gap-Aware LVN Zones<input type="checkbox" checked={settings.nodeDetection.lvnGapAware} onChange={event => patchNodes({ lvnGapAware: event.target.checked })} /></label>
        {settings.nodeDetection.lvnGapAware && <>
          <label>Maximum Valley Activity ({Math.round(settings.nodeDetection.lvnMaximumActivityRatio * 100)}%)<input type="range" min={1} max={100} value={settings.nodeDetection.lvnMaximumActivityRatio * 100} onChange={event => patchNodes({ lvnMaximumActivityRatio: Number(event.target.value) / 100 })} /></label>
          <label>Require Acceptance Above + Below<input type="checkbox" checked={settings.nodeDetection.lvnRequireTwoSidedAcceptance} onChange={event => patchNodes({ lvnRequireTwoSidedAcceptance: event.target.checked })} /></label>
          <small>Wide low-activity rows are evaluated as one auction gap against acceptance immediately above and below the complete valley.</small>
        </>}
        <label>Minimum Width Rows<input type="number" min={1} max={100} value={settings.nodeDetection.minimumWidthRows} onChange={event => patchNodes({ minimumWidthRows: Number(event.target.value) })} /></label>
        <label>Maximum Gap Rows<input type="number" min={0} max={50} value={settings.nodeDetection.maximumGapRows} onChange={event => patchNodes({ maximumGapRows: Number(event.target.value) })} /></label>
        <label>Merge Contiguous Rows<input type="checkbox" checked={settings.nodeDetection.mergeContiguousRows} onChange={event => patchNodes({ mergeContiguousRows: event.target.checked })} /></label>
        <label>Show LVNs<input type="checkbox" checked={settings.nodeDetection.showLvns} onChange={event => patchNodes({ showLvns: event.target.checked })} /></label>
        <label>Show HVNs<input type="checkbox" checked={settings.nodeDetection.showHvns} onChange={event => patchNodes({ showHvns: event.target.checked })} /></label>
        <label>Structural Detail<select value={settings.rendering.structuralDetail} onChange={event => patchRendering({ structuralDetail: event.target.value as AuctionProfileSettings["rendering"]["structuralDetail"] })}><option value="MINIMAL">Minimal</option><option value="STANDARD">Standard</option><option value="DETAILED">Detailed</option><option value="RESEARCH">Research</option></select></label>
        <label>Maximum Visible LVNs<input type="number" min={0} max={100} value={settings.rendering.maximumVisibleLvns} onChange={event => patchRendering({ maximumVisibleLvns: Number(event.target.value) })} /></label>
        <label>Maximum Visible HVNs<input type="number" min={0} max={100} value={settings.rendering.maximumVisibleHvns} onChange={event => patchRendering({ maximumVisibleHvns: Number(event.target.value) })} /></label>
        <label>Maximum Structural Zones<input type="number" min={0} max={100} value={settings.rendering.maximumVisibleStructuralZones} onChange={event => patchRendering({ maximumVisibleStructuralZones: Number(event.target.value) })} /></label>
        <label>Zone Extension<select value={settings.rendering.zoneExtensionMode} onChange={event => patchRendering({ zoneExtensionMode: event.target.value as AuctionProfileSettings["rendering"]["zoneExtensionMode"] })}><option value="PROFILE_ONLY">Profile Only</option><option value="UNTIL_FIRST_TOUCH">Until First Touch</option><option value="UNTIL_MITIGATED">Until Mitigated</option><option value="UNTIL_INVALIDATED">Until Invalidated</option><option value="FIXED_N_BARS">Fixed N Bars</option><option value="EXTEND_RIGHT">Extend Right</option><option value="FULL_CHART">Full Chart</option></select></label>
      </div>}
        {settings.rendering.zoneExtensionMode === "FIXED_N_BARS" && <label>Extension Bars<input type="number" min={1} max={20000} value={settings.rendering.fixedExtensionBars} onChange={event => patchRendering({ fixedExtensionBars: Number(event.target.value) })} /></label>}

      {tab === "style" && <div className="indicator-settings-section">
        <b>Black Terminal Rendering</b>
        {settings.rendering.visualizationType !== "CVD_FOOTPRINT" && <>
          <label>Profile Construction<select value={settings.rendering.profileBodyStyle} onChange={event => patchRendering({ profileBodyStyle: event.target.value as AuctionProfileSettings["rendering"]["profileBodyStyle"] })}><option value="HDLX_CVD_BLOCKS">HDLX CVD Matrix Blocks</option><option value="SOLID_HISTOGRAM">Solid Histogram</option></select></label>
          {settings.rendering.profileBodyStyle === "HDLX_CVD_BLOCKS" && <>
            <label>Block Value<select value={settings.rendering.profileBlockValueMode} onChange={event => patchRendering({ profileBlockValueMode: event.target.value as AuctionProfileSettings["rendering"]["profileBlockValueMode"] })}><option value="CUMULATIVE_CVD">Developing CVD · Reference</option><option value="BLOCK_DELTA">Block Delta · Non-cumulative</option></select></label>
            <label>Matrix Block Width ({settings.rendering.profileBlockPixelWidth}px)<input type="range" min={14} max={80} step={1} value={settings.rendering.profileBlockPixelWidth} onChange={event => patchRendering({ profileBlockPixelWidth: Number(event.target.value) })} /></label>
            <label>Profile Cell Text<select value={settings.rendering.cellTextMode} onChange={event => patchRendering({ cellTextMode: event.target.value as AuctionProfileSettings["rendering"]["cellTextMode"] })}><option value="AUTO">Auto</option><option value="ALWAYS">Always</option><option value="HOVER_ONLY">Hover Only</option><option value="STRONG_ONLY">Strong Cells Only</option><option value="OFF">Off</option></select></label>
            <label>Profile Side<select value={settings.rendering.profileSide} onChange={event => patchRendering({ profileSide: event.target.value as AuctionProfileSettings["rendering"]["profileSide"] })}><option value="LEFT">Left · Lookback Start</option><option value="RIGHT">Right · Latest Edge</option></select></label>
            <label>Profile Length ({settings.rendering.profileLengthPercent}%)<input type="range" min={25} max={160} step={5} value={settings.rendering.profileLengthPercent} onChange={event => patchRendering({ profileLengthPercent: Number(event.target.value) })} /></label>
            <small>Contract or stretch the matrix body without shortening the historical POC, VAH, VAL, and node extensions.</small>
          </>}
          {settings.rendering.profileBodyStyle === "SOLID_HISTOGRAM" && <>
            <label>Profile Geometry<select value={settings.rendering.profileGeometry} onChange={event => patchRendering({ profileGeometry: event.target.value as AuctionProfileSettings["rendering"]["profileGeometry"] })}><option value="BIDIRECTIONAL_DELTA">Bidirectional Delta</option><option value="ABSOLUTE_DIRECTIONAL">Absolute Width + Directional Color</option><option value="POSITIVE_NEGATIVE_SPLIT">Positive / Negative Split</option><option value="MIRRORED">Mirrored</option><option value="SINGLE_SIDED_RIGHT">Single-Sided Right</option><option value="SINGLE_SIDED_LEFT">Single-Sided Left</option><option value="CENTERED">Centered</option></select></label>
            <label>Profile Placement<select value={settings.rendering.profilePlacement} onChange={event => patchRendering({ profilePlacement: event.target.value as AuctionProfileSettings["rendering"]["profilePlacement"] })}><option value="RANGE_START">Range Start</option><option value="RANGE_END">Range End</option><option value="RIGHT">Right</option><option value="LEFT">Left</option><option value="OVERLAY">Overlay</option><option value="INSIDE_RANGE">Inside Range</option><option value="DETACHED_PANEL">Detached Profile Rail</option></select></label>
          </>}
          <label>Width Metric<select value={settings.rendering.profileWidthMetric} onChange={event => patchRendering({ profileWidthMetric: event.target.value as AuctionProfileSettings["rendering"]["profileWidthMetric"] })}><option value="CVD_ACTIVITY">CVD Activity · Σ|Delta|</option><option value="NET_CVD">Net CVD</option><option value="ABSOLUTE_CVD">Absolute CVD</option><option value="BUY_VOLUME">Buy Volume</option><option value="SELL_VOLUME">Sell Volume</option><option value="TOTAL_VOLUME">Total Volume</option><option value="CVD_EFFICIENCY">CVD Efficiency</option><option value="IMBALANCE_RATIO">Imbalance Ratio</option><option value="SELECTED_ENGINE">Selected Engine</option></select></label>
          <label>Row Labels<select value={settings.rendering.rowLabelMode} onChange={event => patchRendering({ rowLabelMode: event.target.value as AuctionProfileSettings["rendering"]["rowLabelMode"] })}><option value="ALWAYS">Always</option><option value="AUTO">Auto</option><option value="STRONG_ONLY">Strong Rows Only</option><option value="HOVER">Hover</option><option value="OFF">Off</option></select></label>
          <label>Time Segments<select value={settings.rendering.timeSegmentsMode} onChange={event => patchRendering({ timeSegmentsMode: event.target.value as AuctionProfileSettings["rendering"]["timeSegmentsMode"] })}><option value="OFF">Off · Unified Profile</option><option value="STACKED">Stacked</option><option value="LATEST_N">Latest N</option><option value="SESSION_BLOCKS">Session Blocks</option><option value="CUSTOM">Custom</option></select></label>
          {["LATEST_N", "CUSTOM"].includes(settings.rendering.timeSegmentsMode) && <label>Segment Count<input type="number" min={1} max={5000} value={settings.rendering.latestSegmentCount} onChange={event => patchRendering({ latestSegmentCount: Number(event.target.value) })} /></label>}
        </>}
        {settings.rendering.visualizationType !== "AUCTION_PROFILE" && <>
          <label>Footprint Cell Text<select value={settings.rendering.cellTextMode} onChange={event => patchRendering({ cellTextMode: event.target.value as AuctionProfileSettings["rendering"]["cellTextMode"] })}><option value="AUTO">Auto</option><option value="ALWAYS">Always</option><option value="HOVER_ONLY">Hover Only</option><option value="STRONG_ONLY">Strong Cells Only</option><option value="OFF">Off</option></select></label>
          <label>Footprint Text Size<select value={settings.rendering.cellTextSize} onChange={event => patchRendering({ cellTextSize: event.target.value as AuctionProfileSettings["rendering"]["cellTextSize"] })}><option value="AUTO">Adaptive GPU Text</option><option value="TINY">Tiny</option><option value="SMALL">Small</option><option value="NORMAL">Normal</option><option value="LARGE">Large</option><option value="HUGE">Huge</option></select></label>
        </>}
        <label>Row / Cell Border<select value={settings.rendering.cellBorder} onChange={event => patchRendering({ cellBorder: event.target.value as AuctionProfileSettings["rendering"]["cellBorder"] })}><option value="NONE">None</option><option value="SUBTLE">Subtle</option><option value="STANDARD">Standard</option><option value="HIGH_CONTRAST">High Contrast</option></select></label>
        <label>Palette<select value={settings.rendering.palette} onChange={event => patchRendering({ palette: event.target.value as AuctionProfileSettings["rendering"]["palette"] })}><option value="BLACK_TERMINAL_INSTITUTIONAL">Black Terminal Institutional</option><option value="ORIGINAL">Original</option><option value="THERMAL">Thermal</option><option value="BLOOD_RED">Blood Red</option><option value="CVD_DIRECTIONAL">CVD Directional</option><option value="MONOCHROME">Monochrome</option><option value="CUSTOM">Custom</option></select></label>
        <label>Maximum Profile Width ({settings.rendering.widthPercent}%)<input type="range" min={5} max={100} value={settings.rendering.widthPercent} onChange={event => patchRendering({ widthPercent: Number(event.target.value) })} /></label>
        <label>Automatic Profile Width<input type="checkbox" checked={settings.rendering.profileWidthAuto} onChange={event => patchRendering({ profileWidthAuto: event.target.checked })} /></label>
        <label>Opacity ({Math.round(settings.rendering.opacity * 100)}%)<input type="range" min={2} max={100} value={settings.rendering.opacity * 100} onChange={event => patchRendering({ opacity: Number(event.target.value) / 100 })} /></label>
        <label>Brightness ({settings.rendering.brightness}%)<input type="range" min={10} max={300} step={5} value={settings.rendering.brightness} onChange={event => patchRendering({ brightness: Number(event.target.value) })} /></label>
        <label>Normalization<select value={settings.rendering.normalizationMode} onChange={event => patchRendering({ normalizationMode: event.target.value as AuctionProfileSettings["rendering"]["normalizationMode"] })}><option value="ROBUST_PERCENTILE">Robust Percentile</option><option value="PER_PROFILE">Per Profile</option><option value="PER_TIME_BLOCK">Per Time Block</option><option value="ROLLING">Rolling</option><option value="ABSOLUTE_FIXED">Absolute Fixed</option><option value="PERCENTILE">Percentile</option><option value="LOGARITHMIC">Logarithmic</option><option value="SQUARE_ROOT">Square Root</option></select></label>
        <label>Color Lifecycle<select value={settings.rendering.colorScalingLifecycle} onChange={event => patchRendering({ colorScalingLifecycle: event.target.value as AuctionProfileSettings["rendering"]["colorScalingLifecycle"] })}><option value="FROZEN_ON_BLOCK_CLOSE">Frozen On Block Close</option><option value="FROZEN_PER_BLOCK">Frozen Per Block</option><option value="DEVELOPING_GLOBAL">Developing Global</option><option value="FROZEN_ON_PROFILE_LOCK">Frozen On Profile Lock</option><option value="ROLLING">Rolling</option></select></label>
        <label>Visible Column Budget<input type="number" min={25} max={2000} value={settings.rendering.maximumVisibleColumns} onChange={event => patchRendering({ maximumVisibleColumns: Number(event.target.value) })} /></label>
        <label>Visible Row Budget<input type="number" min={25} max={1000} value={settings.rendering.maximumVisibleRows} onChange={event => patchRendering({ maximumVisibleRows: Number(event.target.value) })} /></label>
        <label>Visible Label Budget<input type="number" min={0} max={10000} value={settings.rendering.maximumVisibleLabels} onChange={event => patchRendering({ maximumVisibleLabels: Number(event.target.value) })} /></label>
        <label>Show Midpoint<input type="checkbox" checked={settings.rendering.showMidpoint} onChange={event => patchRendering({ showMidpoint: event.target.checked })} /></label>
        <label>Show Structural S/R<input type="checkbox" checked={settings.rendering.showStructuralSr} onChange={event => patchRendering({ showStructuralSr: event.target.checked })} /></label>
        <label>Positive<input type="color" value={settings.rendering.positiveColor} onChange={event => patchRendering({ positiveColor: event.target.value })} /></label><label>Negative<input type="color" value={settings.rendering.negativeColor} onChange={event => patchRendering({ negativeColor: event.target.value })} /></label><label>Balanced<input type="color" value={settings.rendering.balancedColor} onChange={event => patchRendering({ balancedColor: event.target.value })} /></label>
        <label>VAH / VAL Neon<input type="color" value={settings.rendering.valueAreaColor} onChange={event => patchRendering({ valueAreaColor: event.target.value })} /></label><label>POC Neon<input type="color" value={settings.rendering.pocColor} onChange={event => patchRendering({ pocColor: event.target.value })} /></label>
        <label>Value Area Background<input type="color" value={settings.rendering.valueAreaFillColor} onChange={event => patchRendering({ valueAreaFillColor: event.target.value })} /></label>
        <label>Value Area Intensity ({Math.round(settings.rendering.valueAreaFillOpacity * 100)}%)<input type="range" min={0} max={60} step={1} value={settings.rendering.valueAreaFillOpacity * 100} onChange={event => patchRendering({ valueAreaFillOpacity: Number(event.target.value) / 100 })} /></label>
        <label>LVN<input type="color" value={settings.rendering.lvnColor} onChange={event => patchRendering({ lvnColor: event.target.value })} /></label><label>HVN<input type="color" value={settings.rendering.hvnColor} onChange={event => patchRendering({ hvnColor: event.target.value })} /></label>
        <label>LVN Fill Intensity ({Math.round(settings.rendering.lvnFillOpacity * 100)}%)<input type="range" min={0} max={100} step={1} value={settings.rendering.lvnFillOpacity * 100} onChange={event => patchRendering({ lvnFillOpacity: Number(event.target.value) / 100 })} /></label>
        <label>Strong LVN Intensity ({Math.round(settings.rendering.lvnStrongFillOpacity * 100)}%)<input type="range" min={0} max={100} step={1} value={settings.rendering.lvnStrongFillOpacity * 100} onChange={event => patchRendering({ lvnStrongFillOpacity: Number(event.target.value) / 100 })} /></label>
        <label>Full-Color Prominence ({Math.round(settings.rendering.lvnFullColorProminence * 100)}%)<input type="range" min={5} max={100} step={1} value={settings.rendering.lvnFullColorProminence * 100} onChange={event => patchRendering({ lvnFullColorProminence: Number(event.target.value) / 100 })} /></label>
        <label>Show Values<input type="checkbox" checked={settings.rendering.showText} onChange={event => patchRendering({ showText: event.target.checked })} /></label><label>Show Key Levels<input type="checkbox" checked={settings.rendering.showKeyLevels} onChange={event => patchRendering({ showKeyLevels: event.target.checked })} /></label><label>Show Node Labels<input type="checkbox" checked={settings.rendering.showNodeLabels} onChange={event => patchRendering({ showNodeLabels: event.target.checked })} /></label>
        <label>Show Value Area<input type="checkbox" checked={settings.rendering.showValueArea} onChange={event => patchRendering({ showValueArea: event.target.checked })} /></label>{sessionControlsVisible && <label>Show Initial Balance<input type="checkbox" checked={settings.rendering.showInitialBalance} onChange={event => patchRendering({ showInitialBalance: event.target.checked })} /></label>}<label>Show Off-Chart Panel<input type="checkbox" checked={settings.rendering.showOffChart} onChange={event => patchRendering({ showOffChart: event.target.checked })} /></label>
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
