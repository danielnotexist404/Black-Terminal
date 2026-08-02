import { useState, type Dispatch, type SetStateAction } from "react";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  KIOSEFF_HISTORY_LOOKBACK_OPTIONS,
  KIOSEFF_TIMEFRAME_INPUTS,
  isKioseffLowerTimeframeSupported,
  type KioseffSettingsV1
} from "../core/settings";
import type { Timeframe } from "../../../market-data/types";

type Props = {
  settings: KioseffSettingsV1;
  chartTimeframe: Timeframe;
  onChange: Dispatch<SetStateAction<KioseffSettingsV1>>;
  onClose: () => void;
};

export function KioseffSettingsPanel({
  settings,
  chartTimeframe,
  onChange,
  onClose
}: Props) {
  const [tab, setTab] = useState<"inputs" | "style" | "visibility">("inputs");
  const patch = (value: Partial<KioseffSettingsV1>) =>
    onChange((current) => ({ ...current, ...value }));
  const patchAbsorbtion = (value: Partial<KioseffSettingsV1["absorbtion"]>) =>
    onChange((current) => ({
      ...current,
      absorbtion: { ...current.absorbtion, ...value }
    }));
  const patchVae = (value: Partial<KioseffSettingsV1["volatilityAtEntry"]>) =>
    onChange((current) => ({
      ...current,
      volatilityAtEntry: { ...current.volatilityAtEntry, ...value }
    }));
  const patchStyle = (value: Partial<KioseffSettingsV1["style"]>) =>
    onChange((current) => ({
      ...current,
      style: { ...current.style, ...value }
    }));
  const patchVisibility = (value: Partial<KioseffSettingsV1["visibility"]>) =>
    onChange((current) => ({
      ...current,
      visibility: { ...current.visibility, ...value }
    }));
  return (
    <div className="indicator-settings kioseff-settings" role="dialog" aria-label="Market Maker Heatmap settings" data-testid="kioseff-settings-panel">
      <div className="indicator-settings-title">
        <span>Market Maker Heatmap</span>
        <button type="button" onClick={onClose}>DONE</button>
      </div>
      <label>
        Engine Mode
        <select data-kioseff-field="engineMode" value={settings.engineMode} disabled>
          <option value="pine-compatibility">Compatibility Engine</option>
          <option value="black-core-enhanced" disabled>Black Core Tick Engine — future integration</option>
        </select>
        <small>Black Core tick-data enhancement remains reserved for the future native feed.</small>
      </label>
      <div className="indicator-settings-tabs" role="tablist" aria-label="Market Maker Heatmap settings groups">
        {(["inputs", "style", "visibility"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {tab === "inputs" && <>
      <label>
        Default Bar Lookback Calculation
        <select
          data-kioseff-field="historyLookbackBars"
          value={settings.historyLookbackBars}
          onChange={(event) => patch({
            historyLookbackBars: Number(event.target.value) as KioseffSettingsV1["historyLookbackBars"]
          })}
        >
          {KIOSEFF_HISTORY_LOOKBACK_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <small>Sets the maximum chart-bar warmup and ordered intrabar request. If the venue has fewer bars on a large timeframe, all available bars are used. Larger windows take longer and use more memory.</small>
      </label>
      <label>
        Model
        <select
          data-kioseff-field="model"
          value={settings.model}
          onChange={(event) =>
            patch({ model: event.target.value as KioseffSettingsV1["model"] })
          }
        >
          <option value="absorbtion-extremes">Absorbtion Extremes</option>
          <option value="volatility-at-entry">Volatility-At-Entry</option>
        </select>
      </label>
      {settings.model === "absorbtion-extremes" ? (
        <div className="indicator-settings-section">
          <b>Absorbtion Extremes</b>
          <label>X-ray<input data-kioseff-field="absorbtion.showXRay" type="checkbox" checked={settings.absorbtion.showXRay} onChange={(event) => patchAbsorbtion({ showXRay: event.target.checked })} /></label>
          <label>Scale Intensity by Wall Size<input data-kioseff-field="absorbtion.intensityBySize" type="checkbox" checked={settings.absorbtion.intensityBySize} onChange={(event) => patchAbsorbtion({ intensityBySize: event.target.checked })} /></label>
          <label>Buy Wall Depth<input data-kioseff-field="absorbtion.stopClusterBuys" type="number" min={1} value={settings.absorbtion.stopClusterBuys} onChange={(event) => patchAbsorbtion({ stopClusterBuys: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Sell Wall Depth<input data-kioseff-field="absorbtion.stopClusterSells" type="number" min={1} value={settings.absorbtion.stopClusterSells} onChange={(event) => patchAbsorbtion({ stopClusterSells: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Historical Sell Wall Depth<input data-kioseff-field="absorbtion.oldStopClusterSells" type="number" min={0} value={settings.absorbtion.oldStopClusterSells} onChange={(event) => patchAbsorbtion({ oldStopClusterSells: Math.max(0, Number(event.target.value)) })} /></label>
          <label>Historical Buy Wall Depth<input data-kioseff-field="absorbtion.oldStopClusterBuys" type="number" min={0} value={settings.absorbtion.oldStopClusterBuys} onChange={(event) => patchAbsorbtion({ oldStopClusterBuys: Math.max(0, Number(event.target.value)) })} /></label>
          <label>
            Lower Timeframe Vol. Data
            <select data-kioseff-field="absorbtion.lowerTimeframe" value={settings.absorbtion.lowerTimeframe} onChange={(event) => patchAbsorbtion({ lowerTimeframe: event.target.value })}>
              {KIOSEFF_TIMEFRAME_INPUTS.map((option) => {
                const supported = isKioseffLowerTimeframeSupported(option.value, chartTimeframe);
                return <option key={option.value} value={option.value} disabled={!supported} title={supported ? option.label : `Must be lower than ${chartTimeframe}`}>{option.value} · {option.label}{supported ? "" : " (unsupported)"}</option>;
              })}
            </select>
            <small>Must be lower than the active {chartTimeframe} chart.</small>
          </label>
          <label>Active Wall Color<input data-kioseff-field="absorbtion.clusterColor" type="color" value={settings.absorbtion.clusterColor} onChange={(event) => patchAbsorbtion({ clusterColor: event.target.value })} /></label>
          <label>Historical Wall Color<input data-kioseff-field="absorbtion.oldClusterColor" type="color" value={settings.absorbtion.oldClusterColor} onChange={(event) => patchAbsorbtion({ oldClusterColor: event.target.value })} /></label>
        </div>
      ) : (
        <div className="indicator-settings-section">
          <b>Time-Scaled Volatility</b>
          <label>
            Level Granularity
            <select data-kioseff-field="volatilityAtEntry.granularity" title="Higher (Heavy) uses the full price-level map and requires substantially more calculation and memory." value={settings.volatilityAtEntry.granularity} onChange={(event) => patchVae({ granularity: event.target.value as "lower" | "higher" })}>
              <option value="lower">Lower</option>
              <option value="higher">Higher (Heavy)</option>
            </select>
            <small>Higher (Heavy) uses the full price-level map and costs more CPU and memory.</small>
          </label>
          <label>
            Time-Scaled Volatility TF
            <select data-kioseff-field="volatilityAtEntry.timeScaledVolatilityTimeframe" value={settings.volatilityAtEntry.timeScaledVolatilityTimeframe} onChange={(event) => patchVae({ timeScaledVolatilityTimeframe: event.target.value })}>
              {KIOSEFF_TIMEFRAME_INPUTS.map((option) => {
                return <option key={option.value} value={option.value}>{option.value} · {option.label}</option>;
              })}
            </select>
            <small>Pine always consumes ordered 1m data here; this input changes the volatility scaling baseline only.</small>
          </label>
          <label>Strong Wall Color<input data-kioseff-field="volatilityAtEntry.strongClusterColor" type="color" value={settings.volatilityAtEntry.strongClusterColor} onChange={(event) => patchVae({ strongClusterColor: event.target.value })} /></label>
          <label>Weak Wall Color<input data-kioseff-field="volatilityAtEntry.weakClusterColor" type="color" value={settings.volatilityAtEntry.weakClusterColor} onChange={(event) => patchVae({ weakClusterColor: event.target.value })} /></label>
          <label>Show Historical Triggers<input data-kioseff-field="volatilityAtEntry.showHistoricalTriggers" type="checkbox" checked={settings.volatilityAtEntry.showHistoricalTriggers} onChange={(event) => patchVae({ showHistoricalTriggers: event.target.checked })} /></label>
          <label>Show Active Wall Size<input data-kioseff-field="volatilityAtEntry.showActiveClusterSize" type="checkbox" checked={settings.volatilityAtEntry.showActiveClusterSize} onChange={(event) => patchVae({ showActiveClusterSize: event.target.checked })} /></label>
        </div>
      )}
      <div className="indicator-settings-section">
        <b>Optionals</b>
        <label>Force Find Typical Move (Less Similar)<input data-kioseff-field="forceTypicalMove" type="checkbox" checked={settings.forceTypicalMove} onChange={(event) => patch({ forceTypicalMove: event.target.checked })} /></label>
        <label>Show Activity Dashboard<input data-kioseff-field="style.showSummaryTable" type="checkbox" checked={settings.style.showSummaryTable} onChange={(event) => patchStyle({ showSummaryTable: event.target.checked })} /></label>
        <label>Show Wall Balance Meter<input data-kioseff-field="showClusterRatioMeter" type="checkbox" checked={settings.showClusterRatioMeter} onChange={(event) => patch({ showClusterRatioMeter: event.target.checked })} /></label>
      </div>
      </>}
      {tab === "style" && (
        <div className="indicator-settings-section">
          <b>Style</b>
          <label>Chart Background Reference<input data-kioseff-field="style.chartBackgroundColor" type="color" value={settings.style.chartBackgroundColor} onChange={(event) => patchStyle({ chartBackgroundColor: event.target.value })} /></label>
          <label>Active Line Width<input data-kioseff-field="style.activeLineWidth" type="number" min={0.5} max={4} step={0.5} value={settings.style.activeLineWidth} onChange={(event) => patchStyle({ activeLineWidth: Number(event.target.value) })} /></label>
          <label>Hot Line Width<input data-kioseff-field="style.hotLineWidth" type="number" min={1} max={10} step={1} value={settings.style.hotLineWidth} onChange={(event) => patchStyle({ hotLineWidth: Number(event.target.value) })} /></label>
          <label>Label Font Size<input data-kioseff-field="style.labelFontSize" type="number" min={7} max={14} step={1} value={settings.style.labelFontSize} onChange={(event) => patchStyle({ labelFontSize: Number(event.target.value) })} /></label>
          <label>Powerful Buy Wall Color<input data-kioseff-field="style.buyWallColor" type="color" value={settings.style.buyWallColor} onChange={(event) => patchStyle({ buyWallColor: event.target.value })} /></label>
          <label>Show Oscillator<input data-kioseff-field="style.showOscillator" type="checkbox" checked={settings.style.showOscillator} onChange={(event) => patchStyle({ showOscillator: event.target.checked })} /></label>
          <label>Oscillator Buy Color<input data-kioseff-field="style.oscillatorBuyColor" type="color" value={settings.style.oscillatorBuyColor} onChange={(event) => patchStyle({ oscillatorBuyColor: event.target.value })} /></label>
          <label>Oscillator Sell Color<input data-kioseff-field="style.oscillatorSellColor" type="color" value={settings.style.oscillatorSellColor} onChange={(event) => patchStyle({ oscillatorSellColor: event.target.value })} /></label>
          <label>Activity Dashboard Width ({settings.style.activityDashboardWidth}px)<input data-kioseff-field="style.activityDashboardWidth" type="range" min={440} max={760} step={20} value={settings.style.activityDashboardWidth} onChange={(event) => patchStyle({ activityDashboardWidth: Number(event.target.value) })} /></label>
          <small>Foundation inputs remain authoritative; these controls affect presentation only.</small>
        </div>
      )}
      {tab === "visibility" && (
        <div className="indicator-settings-section">
          <b>Visibility</b>
          <label>Ticks<input data-kioseff-field="visibility.ticks" type="checkbox" checked={settings.visibility.ticks} onChange={(event) => patchVisibility({ ticks: event.target.checked })} /></label>
          <label>Seconds<input data-kioseff-field="visibility.seconds" type="checkbox" checked={settings.visibility.seconds} onChange={(event) => patchVisibility({ seconds: event.target.checked })} /></label>
          <label>Minutes<input data-kioseff-field="visibility.minutes" type="checkbox" checked={settings.visibility.minutes} onChange={(event) => patchVisibility({ minutes: event.target.checked })} /></label>
          <label>Hours<input data-kioseff-field="visibility.hours" type="checkbox" checked={settings.visibility.hours} onChange={(event) => patchVisibility({ hours: event.target.checked })} /></label>
          <label>Days<input data-kioseff-field="visibility.days" type="checkbox" checked={settings.visibility.days} onChange={(event) => patchVisibility({ days: event.target.checked })} /></label>
          <label>Weeks<input data-kioseff-field="visibility.weeks" type="checkbox" checked={settings.visibility.weeks} onChange={(event) => patchVisibility({ weeks: event.target.checked })} /></label>
          <label>Months<input data-kioseff-field="visibility.months" type="checkbox" checked={settings.visibility.months} onChange={(event) => patchVisibility({ months: event.target.checked })} /></label>
          <label>
            Price Scale
            <select data-kioseff-field="visibility.priceScalePolicy" value={settings.visibility.priceScalePolicy} onChange={(event) => patchVisibility({ priceScalePolicy: event.target.value as KioseffSettingsV1["visibility"]["priceScalePolicy"] })}>
              <option value="candles-only">Candles Only</option>
              <option value="candles-active-clusters">Candles + Active Clusters</option>
              <option value="candles-visible-geometry">Candles + Visible Cluster Geometry</option>
              <option value="fixed-manual">Fixed Manual Scale</option>
            </select>
          </label>
        </div>
      )}
      <button type="button" className="tv-defaults" onClick={() => onChange(structuredClone(KIOSEFF_DEFAULT_SETTINGS))}>Defaults</button>
    </div>
  );
}
