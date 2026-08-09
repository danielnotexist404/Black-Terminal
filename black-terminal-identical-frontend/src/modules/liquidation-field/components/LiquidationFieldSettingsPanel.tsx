import type { LiquidationFieldSettings } from "../core/types";
import { applyBclifPresentationPreset, BCLIF_MAX_REQUEST_HOURS } from "../core/settings";

interface Props {
  settings: LiquidationFieldSettings;
  onChange(settings: LiquidationFieldSettings): void;
}

export function LiquidationFieldSettingsPanel({ settings, onChange }: Props) {
  const update = <Key extends keyof LiquidationFieldSettings>(key: Key, value: LiquidationFieldSettings[Key]) => {
    onChange({ ...settings, preset: key === "preset" ? value as LiquidationFieldSettings["preset"] : "CUSTOM", [key]: value });
  };
  return <div className="liquidation-field-settings">
    <section className="indicator-settings-section">
      <b>OPERATIONAL PRESENTATION</b>
      <label>Preset<select value={settings.preset} onChange={(event) => {
        const preset = event.target.value as LiquidationFieldSettings["preset"];
        onChange(preset === "CUSTOM" ? { ...settings, preset } : applyBclifPresentationPreset(settings, preset));
      }}>
        <option value="TRADE_FOCUS">BCLIF — Trade Focus</option>
        <option value="HIGH_CONFIDENCE">BCLIF — High Confidence</option>
        <option value="LIVE_CALIBRATED">BCLIF — Live Calibrated</option>
        <option value="FULL_SPECTRUM_RESEARCH">BCLIF — Full Spectrum Research</option>
        <option value="RAW_MODEL">BCLIF — Raw Model</option>
        <option value="CUSTOM">Custom</option>
      </select></label>
      <label>Price Display<select value={settings.priceDisplay} onChange={(event) => update("priceDisplay", event.target.value as LiquidationFieldSettings["priceDisplay"])}>
        <option value="CHART_SCALE">Chart Scale · operational</option><option value="CURRENT_PRICE_5">Current Price ±5%</option>
        <option value="CURRENT_PRICE_10">Current Price ±10%</option><option value="CURRENT_PRICE_20">Current Price ±20%</option>
        <option value="CURRENT_PRICE_40">Current Price ±40%</option><option value="AUTO_FOCUS">Auto Focus</option>
        <option value="FULL_MODEL_RANGE">Full Model Range · research</option><option value="CUSTOM">Custom Range</option>
      </select></label>
      {settings.priceDisplay === "CUSTOM" && <label>Custom Range<span className="liquidation-inline-inputs"><input type="number" min={0} value={settings.customPriceMinimum} onChange={(event) => update("customPriceMinimum", Number(event.target.value))} /><input type="number" min={0} value={settings.customPriceMaximum} onChange={(event) => update("customPriceMaximum", Number(event.target.value))} /></span></label>}
      {settings.priceDisplay === "AUTO_FOCUS" && <label className="indicator-range-row">Auto-Focus Margin<span><input type="range" min={0} max={25} value={settings.autoFocusMarginPercent} onChange={(event) => update("autoFocusMarginPercent", Number(event.target.value))} /><strong>{settings.autoFocusMarginPercent}%</strong></span></label>}
      <label>Visual Channel<select value={settings.visualChannel} onChange={(event) => update("visualChannel", event.target.value as LiquidationFieldSettings["visualChannel"])}><option value="COMBINED">Combined</option><option value="HISTORICAL_CONTEXT">Historical Context</option><option value="LIVE_CALIBRATED">Live Calibrated</option></select></label>
    </section>

    <section className="indicator-settings-section">
      <b>BLACK CORE LIQUIDATION INTELLIGENCE</b>
      <label>Horizon<select value={settings.horizon} onChange={(event) => update("horizon", event.target.value as LiquidationFieldSettings["horizon"])}>
        <option value="6H">6 Hours</option><option value="12H">12 Hours</option><option value="1D">1 Day</option>
        <option value="3D">3 Days</option><option value="1W">1 Week</option><option value="3W">Event Horizon · 3 Weeks</option>
        <option value="1M">1 Month</option><option value="CUSTOM">Custom</option>
      </select></label>
      {settings.horizon === "CUSTOM" && <label>Custom Hours<input type="number" min={1} max={BCLIF_MAX_REQUEST_HOURS} value={settings.customHours} onChange={(event) => update("customHours", Number(event.target.value))} /></label>}
      <label>View<select value={settings.viewMode} onChange={(event) => update("viewMode", event.target.value as LiquidationFieldSettings["viewMode"])}>
        <option value="COMBINED_THERMAL">Combined Thermal</option><option value="LONG_EXPOSURE">Long Exposure</option>
        <option value="SHORT_EXPOSURE">Short Exposure</option><option value="DIRECTIONAL_SPLIT">Directional Split</option>
        <option value="CONFIDENCE_FIELD">Confidence Field</option><option value="CONFIRMED_LIQUIDATIONS">Confirmed Liquidations</option>
        <option value="CASCADE_RISK">Cascade Risk</option><option value="COMBINED_INTELLIGENCE">Combined Intelligence</option>
      </select></label>
      <label>Venue<select value={settings.venue} onChange={(event) => update("venue", event.target.value as LiquidationFieldSettings["venue"])}>
        <option value="BYBIT">Bybit</option><option value="COMPOSITE" disabled>Composite · future collector</option>
      </select></label>
    </section>

    <section className="indicator-settings-section">
      <b>MODEL & UNCERTAINTY</b>
      <label>Model<select value={settings.modelPreset} onChange={(event) => update("modelPreset", event.target.value as LiquidationFieldSettings["modelPreset"])}>
        <option value="CONSERVATIVE">Conservative</option><option value="BALANCED">Balanced</option>
        <option value="VENUE_CALIBRATED">Venue-Calibrated</option><option value="REGIME_ADAPTIVE">Regime-Adaptive</option>
      </select></label>
      <label>Scale<select value={settings.scale} onChange={(event) => update("scale", event.target.value as LiquidationFieldSettings["scale"])}>
        <option value="CONFIDENCE_WEIGHTED_LOG">Confidence-Weighted Log</option><option value="LOG_NOTIONAL">Log Notional</option>
        <option value="ABSOLUTE_NOTIONAL">Absolute Notional</option><option value="PERCENTILE">Percentile</option><option value="OI_RELATIVE">OI Relative</option>
      </select></label>
      <label className="indicator-range-row">Context Visibility Floor<span><input type="range" min={0} max={90} value={settings.contextVisibilityFloor} onChange={(event) => update("contextVisibilityFloor", Number(event.target.value))} /><strong>{settings.contextVisibilityFloor}%</strong></span></label>
      <label className="indicator-range-row">Cluster Label Floor<span><input type="range" min={0} max={100} value={settings.clusterLabelFloor} onChange={(event) => update("clusterLabelFloor", Number(event.target.value))} /><strong>{settings.clusterLabelFloor}%</strong></span></label>
      <label className="indicator-range-row">High-Authority Color Floor<span><input type="range" min={60} max={100} value={settings.highAuthorityColorFloor} onChange={(event) => update("highAuthorityColorFloor", Number(event.target.value))} /><strong>{settings.highAuthorityColorFloor}%</strong></span></label>
      <label>Strict Hide Below<input type="checkbox" checked={settings.strictHideBelowEnabled} onChange={(event) => update("strictHideBelowEnabled", event.target.checked)} /></label>
      {settings.strictHideBelowEnabled && <label className="indicator-range-row">Strict Filter Confidence<span><input type="range" min={0} max={100} value={settings.strictHideBelowConfidence} onChange={(event) => update("strictHideBelowConfidence", Number(event.target.value))} /><strong>{settings.strictHideBelowConfidence}%</strong></span></label>}
      <label>Historical OI Context<input type="checkbox" checked={settings.historicalContextEnabled} onChange={(event) => update("historicalContextEnabled", event.target.checked)} /></label>
      <label>Live-Calibrated Region<input type="checkbox" checked={settings.liveCalibratedEnabled} onChange={(event) => update("liveCalibratedEnabled", event.target.checked)} /></label>
      <label>Side<select value={settings.sideFilter} onChange={(event) => update("sideFilter", event.target.value as LiquidationFieldSettings["sideFilter"])}><option value="BOTH">Both</option><option value="LONG">Longs</option><option value="SHORT">Shorts</option></select></label>
      <label>Leverage Range<span className="liquidation-inline-inputs"><input type="number" min={1} max={125} value={settings.leverageMinimum} onChange={(event) => update("leverageMinimum", Number(event.target.value))} /><input type="number" min={1} max={125} value={settings.leverageMaximum} onChange={(event) => update("leverageMaximum", Number(event.target.value))} /></span></label>
      <label>OI Noise Floor<select value={settings.oiNoiseMethod} onChange={(event) => update("oiNoiseMethod", event.target.value as LiquidationFieldSettings["oiNoiseMethod"])}><option value="HYBRID_ROBUST">Hybrid Robust · recommended</option><option value="ABSOLUTE_NOTIONAL">Absolute Notional</option><option value="OI_PERCENT">OI Percentage</option><option value="ROBUST_MAD">Robust MAD</option></select></label>
      <label>Absolute OI Materiality<input type="number" min={0} step={10_000} value={settings.oiNoiseAbsoluteNotionalUsd} onChange={(event) => update("oiNoiseAbsoluteNotionalUsd", Number(event.target.value))} /></label>
      <label className="indicator-range-row">OI Percentage Floor<span><input type="range" min={0} max={100} value={Math.round(settings.oiNoisePercent * 100_000)} onChange={(event) => update("oiNoisePercent", Number(event.target.value) / 100_000)} /><strong>{(settings.oiNoisePercent * 100).toFixed(4)}%</strong></span></label>
      <label className="indicator-range-row">Robust MAD Multiplier<span><input type="range" min={0} max={100} value={Math.round(settings.oiNoiseMadMultiplier * 5)} onChange={(event) => update("oiNoiseMadMultiplier", Number(event.target.value) / 5)} /><strong>{settings.oiNoiseMadMultiplier.toFixed(1)}×</strong></span></label>
      <label className="indicator-range-row">Isolated Estimate Weight<span><input type="range" min={0} max={100} value={Math.round(settings.isolatedContributionCap * 100)} onChange={(event) => update("isolatedContributionCap", Number(event.target.value) / 100)} /><strong>{Math.round(settings.isolatedContributionCap * 100)}%</strong></span></label>
      <label className="indicator-range-row">Cross Estimate Cap<span><input type="range" min={0} max={30} value={Math.round(settings.crossContributionCap * 100)} onChange={(event) => update("crossContributionCap", Number(event.target.value) / 100)} /><strong>{Math.round(settings.crossContributionCap * 100)}%</strong></span></label>
      <label className="indicator-range-row">Unknown Estimate Cap<span><input type="range" min={0} max={20} value={Math.round(settings.unknownContributionCap * 100)} onChange={(event) => update("unknownContributionCap", Number(event.target.value) / 100)} /><strong>{Math.round(settings.unknownContributionCap * 100)}%</strong></span></label>
    </section>

    <section className="indicator-settings-section">
      <b>THERMAL FIELD</b>
      <label>Thermal Theme<select value={settings.palette} onChange={(event) => update("palette", event.target.value as LiquidationFieldSettings["palette"])}>
        <option value="REFERENCE_THERMAL">Purple Plasma · CoinGlass</option><option value="BLACK_TERMINAL_BLOOD">Blood / White / Silver · Black Terminal</option>
        <option value="INSTITUTIONAL_MONOCHROME">Institutional Monochrome</option><option value="DIRECTIONAL_SPLIT">Directional Split</option><option value="CONFIDENCE">Confidence</option>
      </select></label>
      <label className="indicator-range-row">Opacity<span><input type="range" min={10} max={100} value={settings.opacity} onChange={(event) => update("opacity", Number(event.target.value))} /><strong>{settings.opacity}</strong></span></label>
      <label className="indicator-range-row">Plasma Background<span><input type="range" min={0} max={100} value={settings.plasmaBackgroundOpacity} onChange={(event) => update("plasmaBackgroundOpacity", Number(event.target.value))} /><strong>{settings.plasmaBackgroundOpacity}%</strong></span></label>
      <label className="indicator-range-row">Shelf Clarity<span><input type="range" min={0} max={100} value={settings.shelfContrast} onChange={(event) => update("shelfContrast", Number(event.target.value))} /><strong>{settings.shelfContrast}%</strong></span></label>
      <label className="indicator-range-row">Residual / Half-Mitigated Shelves<span><input type="range" min={0} max={100} value={settings.residualShelfVisibility} onChange={(event) => update("residualShelfVisibility", Number(event.target.value))} /><strong>{settings.residualShelfVisibility}%</strong></span></label>
      <label className="indicator-range-row">Gamma<span><input type="range" min={35} max={250} value={Math.round(settings.gamma * 100)} onChange={(event) => update("gamma", Number(event.target.value) / 100)} /><strong>{settings.gamma.toFixed(2)}</strong></span></label>
      <label className="indicator-range-row">Lower Intensity Percentile<span><input type="range" min={0} max={95} value={Math.round(settings.lowQuantile * 100)} onChange={(event) => update("lowQuantile", Number(event.target.value) / 100)} /><strong>{(settings.lowQuantile * 100).toFixed(1)}%</strong></span></label>
      <label className="indicator-range-row">Upper Intensity Percentile<span><input type="range" min={950} max={1000} value={Math.round(settings.highQuantile * 1000)} onChange={(event) => update("highQuantile", Number(event.target.value) / 1000)} /><strong>{(settings.highQuantile * 100).toFixed(1)}%</strong></span></label>
      <label className="indicator-range-row">Thermal Color Floor<span><input type="range" min={0} max={64} value={settings.backgroundFloor} onChange={(event) => update("backgroundFloor", Number(event.target.value))} /><strong>{settings.backgroundFloor}</strong></span></label>
      <label className="indicator-range-row">Yellow Tail<span><input type="range" min={1} max={5} value={Math.round(settings.yellowTailPercent * 10)} onChange={(event) => update("yellowTailPercent", Number(event.target.value) / 10)} /><strong>{settings.yellowTailPercent.toFixed(1)}%</strong></span></label>
      <label>Normalization<select value={settings.thermalNormalization} onChange={(event) => update("thermalNormalization", event.target.value as LiquidationFieldSettings["thermalNormalization"])}><option value="HYBRID">Hybrid · recommended</option><option value="GLOBAL_MODEL">Global Model</option><option value="VISIBLE_FOCUS">Visible Focus · camera-relative</option><option value="FIXED_ABSOLUTE">Fixed Absolute</option><option value="OI_RELATIVE">OI Relative</option><option value="CONFIDENCE_WEIGHTED">Confidence Weighted</option></select></label>
      <label className="indicator-range-row">Historical Context<span><input type="range" min={0} max={100} value={settings.historicalContextOpacity} onChange={(event) => update("historicalContextOpacity", Number(event.target.value))} /><strong>{settings.historicalContextOpacity}%</strong></span></label>
      <label className="indicator-range-row">Live Calibrated<span><input type="range" min={0} max={100} value={settings.liveCalibratedOpacity} onChange={(event) => update("liveCalibratedOpacity", Number(event.target.value))} /><strong>{settings.liveCalibratedOpacity}%</strong></span></label>
      <label>Smoothing<select value={settings.smoothing} onChange={(event) => update("smoothing", event.target.value as LiquidationFieldSettings["smoothing"])}><option value="SHARP">Sharp</option><option value="BALANCED">Balanced</option><option value="SMOOTH">Smooth</option><option value="CUSTOM">Custom</option></select></label>
      <label>Model Grid<select value={`${settings.timeColumns}x${settings.priceRows}`} onChange={(event) => {
        const [timeColumns, priceRows] = event.target.value.split("x").map(Number);
        onChange({ ...settings, preset: "CUSTOM", timeColumns, priceRows });
      }}><option value="256x256">Touch · 256²</option><option value="512x384">Desktop · 512×384</option><option value="1024x512">Research · 1024×512</option></select></label>
      <label>Display LOD<select value={settings.adaptiveResolution} onChange={(event) => update("adaptiveResolution", event.target.value as LiquidationFieldSettings["adaptiveResolution"])}><option value="AUTO">Auto · device aware</option><option value="HIGH">High Resolution</option><option value="BALANCED">Balanced</option><option value="LOW_PERFORMANCE">Low-Performance Fallback</option></select></label>
      <label>Candles<select value={settings.candlePalette} onChange={(event) => update("candlePalette", event.target.value as LiquidationFieldSettings["candlePalette"])}><option value="BLACK_TERMINAL_HIGH_CONTRAST">Black Terminal High Contrast</option><option value="REFERENCE_CYAN_MAGENTA">Reference Cyan / Magenta</option></select></label>
      <label>Candle Contrast<select value={settings.candleContrast} onChange={(event) => update("candleContrast", event.target.value as LiquidationFieldSettings["candleContrast"])}><option value="STANDARD">Standard</option><option value="HIGH">High</option><option value="MAXIMUM">Maximum</option></select></label>
    </section>

    <section className="indicator-settings-section liquidation-field-toggles">
      <b>OVERLAYS</b>
      <label>Legend<input type="checkbox" checked={settings.legendVisible} onChange={(event) => update("legendVisible", event.target.checked)} /></label>
      <label>Diagnostics<input type="checkbox" checked={settings.diagnosticsVisible} onChange={(event) => update("diagnosticsVisible", event.target.checked)} /></label>
      <label>Confirmed Events<input type="checkbox" checked={settings.confirmedMarkersVisible} onChange={(event) => update("confirmedMarkersVisible", event.target.checked)} /></label>
      <label>Cascade Paths<input type="checkbox" checked={settings.cascadePathsVisible} onChange={(event) => update("cascadePathsVisible", event.target.checked)} /></label>
      <label>Confidence Weight<input type="checkbox" checked={settings.confidenceWeightEnabled} onChange={(event) => update("confidenceWeightEnabled", event.target.checked)} /></label>
      <label>Require 2+ Evidence Channels<input type="checkbox" checked={settings.requireMultipleEvidenceChannels} onChange={(event) => update("requireMultipleEvidenceChannels", event.target.checked)} /></label>
      <label>Uncertainty Envelopes<input type="checkbox" checked={settings.uncertaintyEnvelopesVisible} onChange={(event) => update("uncertaintyEnvelopesVisible", event.target.checked)} /></label>
      <label>Operational Summary<input type="checkbox" checked={settings.operationalSummaryVisible} onChange={(event) => update("operationalSummaryVisible", event.target.checked)} /></label>
      <label>Live Calibration Marker<input type="checkbox" checked={settings.collectionStartMarkerVisible} onChange={(event) => update("collectionStartMarkerVisible", event.target.checked)} /></label>
      <label>Cohort Provenance<input type="checkbox" checked={settings.cohortProvenanceVisible} onChange={(event) => update("cohortProvenanceVisible", event.target.checked)} /></label>
      <label>Cohort Birth Markers<input type="checkbox" checked={settings.cohortBirthMarkersVisible} onChange={(event) => update("cohortBirthMarkersVisible", event.target.checked)} /></label>
      <label>Raw Cohort Shelf Overlay · diagnostic<input type="checkbox" checked={settings.rawCohortShelvesVisible} onChange={(event) => update("rawCohortShelvesVisible", event.target.checked)} /></label>
      <label>Focus Band<select value={settings.focusBand} onChange={(event) => update("focusBand", event.target.value as LiquidationFieldSettings["focusBand"])}><option value="OFF">Off</option><option value="PERCENT_2">±2%</option><option value="PERCENT_5">±5%</option><option value="PERCENT_10">±10%</option><option value="CUSTOM">Custom</option></select></label>
      {settings.focusBand === "CUSTOM" && <label className="indicator-range-row">Custom Focus<span><input type="range" min={1} max={50} value={settings.customFocusBandPercent} onChange={(event) => update("customFocusBandPercent", Number(event.target.value))} /><strong>{settings.customFocusBandPercent}%</strong></span></label>}
      <label className="indicator-range-row">Cluster Labels<span><input type="range" min={0} max={6} value={settings.maximumClusterLabels} onChange={(event) => update("maximumClusterLabels", Number(event.target.value))} /><strong>{settings.maximumClusterLabels}</strong></span></label>
    </section>
  </div>;
}
