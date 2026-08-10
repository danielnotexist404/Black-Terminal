import type { LiquidationFieldSettings } from "../core/types";
import { BCLIF_MAX_REQUEST_HOURS, bclifPriceDisplayForRangeMode } from "../core/settings";

interface Props {
  settings: LiquidationFieldSettings;
  visible: boolean;
  onVisibleChange(visible: boolean): void;
  onChange(settings: LiquidationFieldSettings): void;
}

const RANGE_OPTIONS: Array<{ value: LiquidationFieldSettings["rangeMode"]; label: string }> = [
  { value: "AUTO", label: "Auto" },
  { value: "VISIBLE", label: "Visible Range" },
  { value: "SESSION", label: "Session" },
  { value: "SWING", label: "Swing" },
  { value: "MACRO", label: "Macro" },
  { value: "FULL_LOADED", label: "Full Loaded" }
];

export function LiquidationFieldSettingsPanel({ settings, visible, onVisibleChange, onChange }: Props) {
  const update = <Key extends keyof LiquidationFieldSettings>(key: Key, value: LiquidationFieldSettings[Key]) => {
    onChange({ ...settings, preset: "CUSTOM", [key]: value });
  };
  const updateRange = (rangeMode: LiquidationFieldSettings["rangeMode"]) => onChange({
    ...settings,
    preset: "CUSTOM",
    rangeMode,
    priceDisplay: bclifPriceDisplayForRangeMode(rangeMode)
  });
  const viewValue = settings.viewMode === "LONG_EXPOSURE" ? "LONG"
    : settings.viewMode === "SHORT_EXPOSURE" ? "SHORT"
      : settings.viewMode === "DIRECTIONAL_SPLIT" ? "BOTH" : "COMBINED";
  const modelValue = settings.modelPreset === "CONSERVATIVE" ? "CONSERVATIVE"
    : settings.modelPreset === "REGIME_ADAPTIVE" ? "AGGRESSIVE" : "BALANCED";

  return <div className="liquidation-field-settings bclif-settings-v12">
    <section className="indicator-settings-section bclif-primary-section">
      <b>DISPLAY</b>
      <label>Visible<input type="checkbox" checked={visible} onChange={(event) => onVisibleChange(event.target.checked)} /></label>
      <label className="indicator-range-row">Intensity<span><input aria-label="BCLIF intensity" type="range" min={50} max={200} value={settings.intensityGain} onChange={(event) => update("intensityGain", Number(event.target.value))} /><strong>{settings.intensityGain}%</strong></span></label>
      <label>Range Mode<select value={settings.rangeMode} onChange={(event) => updateRange(event.target.value as LiquidationFieldSettings["rangeMode"])}>{RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>Theme<select value={settings.palette} onChange={(event) => update("palette", event.target.value as LiquidationFieldSettings["palette"])}><option value="REFERENCE_THERMAL">Reference Thermal</option><option value="BLACK_TERMINAL_BLOOD">Black Terminal Blood</option></select></label>
      <label className="indicator-range-row">Opacity<span><input type="range" min={10} max={100} value={settings.opacity} onChange={(event) => update("opacity", Number(event.target.value))} /><strong>{settings.opacity}%</strong></span></label>
      <label className="indicator-range-row">Contrast<span><input type="range" min={50} max={200} value={settings.thermalContrast} onChange={(event) => update("thermalContrast", Number(event.target.value))} /><strong>{settings.thermalContrast}%</strong></span></label>
    </section>

    <section className="indicator-settings-section bclif-primary-section">
      <b>FIELD BEHAVIOR</b>
      <label>View Mode<select value={viewValue} onChange={(event) => {
        const value = event.target.value;
        update("viewMode", value === "LONG" ? "LONG_EXPOSURE" : value === "SHORT" ? "SHORT_EXPOSURE" : value === "BOTH" ? "DIRECTIONAL_SPLIT" : "COMBINED_THERMAL");
      }}><option value="COMBINED">Combined</option><option value="LONG">Long</option><option value="SHORT">Short</option><option value="BOTH">Both</option></select></label>
      <label>Model Mode<select value={modelValue} onChange={(event) => update("modelPreset", event.target.value === "CONSERVATIVE" ? "CONSERVATIVE" : event.target.value === "AGGRESSIVE" ? "REGIME_ADAPTIVE" : "BALANCED")}><option value="BALANCED">Balanced</option><option value="CONSERVATIVE">Conservative</option><option value="AGGRESSIVE">Aggressive</option></select></label>
      <label>Noise Suppression<select value={settings.noiseSuppression} onChange={(event) => update("noiseSuppression", event.target.value as LiquidationFieldSettings["noiseSuppression"])}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label>Show Background Field<input type="checkbox" checked={settings.showBackgroundField} onChange={(event) => update("showBackgroundField", event.target.checked)} /></label>
      <label>Strong Shelves Only<input type="checkbox" checked={settings.strongShelvesOnly} onChange={(event) => update("strongShelvesOnly", event.target.checked)} /></label>
    </section>

    <section className="indicator-settings-section bclif-primary-section">
      <b>CONTEXT</b>
      <label>Historical Context<input type="checkbox" checked={settings.historicalContextEnabled} onChange={(event) => update("historicalContextEnabled", event.target.checked)} /></label>
      <label>Live-Calibrated Region<input type="checkbox" checked={settings.liveCalibratedEnabled} onChange={(event) => update("liveCalibratedEnabled", event.target.checked)} /></label>
    </section>

    <details className="bclif-advanced-settings">
      <summary>Advanced / Diagnostics</summary>
      <section className="indicator-settings-section">
        <b>AUTHORITY & MODEL</b>
        <label>Authority Semantics<select value={settings.authoritySemantics} onChange={(event) => update("authoritySemantics", event.target.value as LiquidationFieldSettings["authoritySemantics"])}><option value="RELATIVE_MODELED_EXPOSURE">Relative Modeled Exposure</option><option value="VERIFIED_AUTHORITY">Verified Authority</option></select></label>
        <label>Renderer<select value={settings.rendererVersion} onChange={(event) => update("rendererVersion", event.target.value as LiquidationFieldSettings["rendererVersion"])}><option value="REFERENCE_THERMAL_V2">Reference Thermal V2</option><option value="LEGACY_RGBA_V1">Legacy RGBA · comparison</option></select></label>
        <label>Horizon<select value={settings.horizon} onChange={(event) => update("horizon", event.target.value as LiquidationFieldSettings["horizon"])}><option value="6H">6 Hours</option><option value="12H">12 Hours</option><option value="1D">1 Day</option><option value="3D">3 Days</option><option value="1W">1 Week</option><option value="3W">3 Weeks</option><option value="1M">1 Month</option><option value="CUSTOM">Custom</option></select></label>
        {settings.horizon === "CUSTOM" && <label>Custom Hours<input type="number" min={1} max={BCLIF_MAX_REQUEST_HOURS} value={settings.customHours} onChange={(event) => update("customHours", Number(event.target.value))} /></label>}
        <label>Scale<select value={settings.scale} onChange={(event) => update("scale", event.target.value as LiquidationFieldSettings["scale"])}><option value="LOG_NOTIONAL">Log Notional</option><option value="ABSOLUTE_NOTIONAL">Absolute Notional</option><option value="PERCENTILE">Percentile</option><option value="OI_RELATIVE">OI Relative</option><option value="CONFIDENCE_WEIGHTED_LOG">Confidence Weighted Log</option></select></label>
      </section>
      <section className="indicator-settings-section">
        <b>DEBUG CHANNELS</b>
        <label>Output<select value={settings.viewMode} onChange={(event) => update("viewMode", event.target.value as LiquidationFieldSettings["viewMode"])}><option value="COMBINED_THERMAL">Final Thermal</option><option value="RAW_EXPOSURE">Raw Exposure</option><option value="CONFIDENCE_FIELD">Confidence Field</option><option value="VALIDITY_MASK">Validity Mask</option><option value="ALPHA_OUTPUT">Alpha Output</option><option value="SHELF_LINES_ONLY">Shelf Lines Only</option></select></label>
        <label>Normalization<select value={settings.thermalNormalization} onChange={(event) => update("thermalNormalization", event.target.value as LiquidationFieldSettings["thermalNormalization"])}><option value="GLOBAL_MODEL">Global Model</option><option value="HYBRID">Hybrid</option><option value="VISIBLE_FOCUS">Visible Focus</option><option value="FIXED_ABSOLUTE">Fixed Absolute</option><option value="OI_RELATIVE">OI Relative</option><option value="CONFIDENCE_WEIGHTED">Confidence Weighted</option></select></label>
        <label>Smoothing<select value={settings.smoothing} onChange={(event) => update("smoothing", event.target.value as LiquidationFieldSettings["smoothing"])}><option value="SHARP">Sharp</option><option value="BALANCED">Balanced</option><option value="SMOOTH">Smooth</option><option value="CUSTOM">Custom</option></select></label>
        <label>Display Grid<select value={settings.adaptiveResolution} onChange={(event) => update("adaptiveResolution", event.target.value as LiquidationFieldSettings["adaptiveResolution"])}><option value="AUTO">Auto</option><option value="ULTRA">Ultra</option><option value="HIGH">High</option><option value="BALANCED">Balanced</option><option value="LOW_PERFORMANCE">Compatibility</option></select></label>
        <label className="indicator-range-row">Background Floor<span><input type="range" min={0} max={64} value={settings.backgroundFloor} onChange={(event) => update("backgroundFloor", Number(event.target.value))} /><strong>{settings.backgroundFloor}</strong></span></label>
        <label className="indicator-range-row">Extreme Tail<span><input type="range" min={1} max={5} value={Math.round(settings.yellowTailPercent * 10)} onChange={(event) => update("yellowTailPercent", Number(event.target.value) / 10)} /><strong>{settings.yellowTailPercent.toFixed(1)}%</strong></span></label>
      </section>
      <section className="indicator-settings-section liquidation-field-toggles">
        <b>OVERLAYS & PROVENANCE</b>
        <label>Compact Status Badge<input type="checkbox" checked={settings.compactBadgeVisible} onChange={(event) => update("compactBadgeVisible", event.target.checked)} /></label>
        <label>Full Diagnostics<input type="checkbox" checked={settings.diagnosticsVisible} onChange={(event) => update("diagnosticsVisible", event.target.checked)} /></label>
        <label>Event Nodes<input type="checkbox" checked={settings.eventNodesVisible} onChange={(event) => update("eventNodesVisible", event.target.checked)} /></label>
        <label>Shelf Labels<input type="checkbox" checked={settings.shelfLabelsVisible} onChange={(event) => update("shelfLabelsVisible", event.target.checked)} /></label>
        <label>Cohort Provenance<input type="checkbox" checked={settings.cohortProvenanceVisible} onChange={(event) => update("cohortProvenanceVisible", event.target.checked)} /></label>
        <label>Raw Cohort Shelves<input type="checkbox" checked={settings.rawCohortShelvesVisible} onChange={(event) => update("rawCohortShelvesVisible", event.target.checked)} /></label>
        <label>Confirmed Markers<input type="checkbox" checked={settings.confirmedMarkersVisible} onChange={(event) => update("confirmedMarkersVisible", event.target.checked)} /></label>
        <small>Hashes, grid provenance and machine-readable export stay in the optional diagnostics HUD. Browser fallback remains modeled relative exposure, never persistent-node authority.</small>
      </section>
    </details>
  </div>;
}
