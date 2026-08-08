import type { LiquidationFieldSettings } from "../core/types";
import { BCLIF_MAX_REQUEST_HOURS } from "../core/settings";

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
      <label className="indicator-range-row">Confidence Floor<span><input type="range" min={0} max={90} value={settings.minimumConfidence} onChange={(event) => update("minimumConfidence", Number(event.target.value))} /><strong>{settings.minimumConfidence}%</strong></span></label>
      <label>Side<select value={settings.sideFilter} onChange={(event) => update("sideFilter", event.target.value as LiquidationFieldSettings["sideFilter"])}><option value="BOTH">Both</option><option value="LONG">Longs</option><option value="SHORT">Shorts</option></select></label>
      <label>Leverage Range<span className="liquidation-inline-inputs"><input type="number" min={1} max={125} value={settings.leverageMinimum} onChange={(event) => update("leverageMinimum", Number(event.target.value))} /><input type="number" min={1} max={125} value={settings.leverageMaximum} onChange={(event) => update("leverageMaximum", Number(event.target.value))} /></span></label>
    </section>

    <section className="indicator-settings-section">
      <b>THERMAL FIELD</b>
      <label>Palette<select value={settings.palette} onChange={(event) => update("palette", event.target.value as LiquidationFieldSettings["palette"])}>
        <option value="REFERENCE_THERMAL">Reference Thermal</option><option value="BLACK_TERMINAL_BLOOD">Black Terminal Blood</option>
        <option value="INSTITUTIONAL_MONOCHROME">Institutional Monochrome</option><option value="DIRECTIONAL_SPLIT">Directional Split</option><option value="CONFIDENCE">Confidence</option>
      </select></label>
      <label className="indicator-range-row">Opacity<span><input type="range" min={0} max={100} value={settings.opacity} onChange={(event) => update("opacity", Number(event.target.value))} /><strong>{settings.opacity}</strong></span></label>
      <label className="indicator-range-row">Gamma<span><input type="range" min={35} max={250} value={Math.round(settings.gamma * 100)} onChange={(event) => update("gamma", Number(event.target.value) / 100)} /><strong>{settings.gamma.toFixed(2)}</strong></span></label>
      <label>Smoothing<select value={settings.smoothing} onChange={(event) => update("smoothing", event.target.value as LiquidationFieldSettings["smoothing"])}><option value="SHARP">Sharp</option><option value="BALANCED">Balanced</option><option value="SMOOTH">Smooth</option><option value="CUSTOM">Custom</option></select></label>
      <label>Resolution<select value={`${settings.timeColumns}x${settings.priceRows}`} onChange={(event) => {
        const [timeColumns, priceRows] = event.target.value.split("x").map(Number);
        onChange({ ...settings, preset: "CUSTOM", timeColumns, priceRows });
      }}><option value="256x256">Touch · 256²</option><option value="512x384">Desktop · 512×384</option><option value="1024x512">Research · 1024×512</option></select></label>
      <label>Candles<select value={settings.candlePalette} onChange={(event) => update("candlePalette", event.target.value as LiquidationFieldSettings["candlePalette"])}><option value="BLACK_TERMINAL_HIGH_CONTRAST">Black Terminal High Contrast</option><option value="REFERENCE_CYAN_MAGENTA">Reference Cyan / Magenta</option></select></label>
    </section>

    <section className="indicator-settings-section liquidation-field-toggles">
      <b>OVERLAYS</b>
      <label>Legend<input type="checkbox" checked={settings.legendVisible} onChange={(event) => update("legendVisible", event.target.checked)} /></label>
      <label>Diagnostics<input type="checkbox" checked={settings.diagnosticsVisible} onChange={(event) => update("diagnosticsVisible", event.target.checked)} /></label>
      <label>Confirmed Events<input type="checkbox" checked={settings.confirmedMarkersVisible} onChange={(event) => update("confirmedMarkersVisible", event.target.checked)} /></label>
      <label>Cascade Paths<input type="checkbox" checked={settings.cascadePathsVisible} onChange={(event) => update("cascadePathsVisible", event.target.checked)} /></label>
    </section>
  </div>;
}
