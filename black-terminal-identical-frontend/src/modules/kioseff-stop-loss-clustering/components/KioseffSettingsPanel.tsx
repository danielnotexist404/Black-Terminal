import type { Dispatch, SetStateAction } from "react";
import {
  KIOSEFF_DEFAULT_SETTINGS,
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
  return (
    <div className="indicator-settings kioseff-settings" role="dialog" aria-label="Stop Loss Clustering settings" data-testid="kioseff-settings-panel">
      <div className="indicator-settings-title">
        <span>Stop Loss Clustering</span>
        <button type="button" onClick={onClose}>DONE</button>
      </div>
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
          <label>Set Color Intensity by Stop Cluster Size<input data-kioseff-field="absorbtion.intensityBySize" type="checkbox" checked={settings.absorbtion.intensityBySize} onChange={(event) => patchAbsorbtion({ intensityBySize: event.target.checked })} /></label>
          <label>Stop Cluster Buys<input data-kioseff-field="absorbtion.stopClusterBuys" type="number" min={1} value={settings.absorbtion.stopClusterBuys} onChange={(event) => patchAbsorbtion({ stopClusterBuys: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Stop Cluster Sells<input data-kioseff-field="absorbtion.stopClusterSells" type="number" min={1} value={settings.absorbtion.stopClusterSells} onChange={(event) => patchAbsorbtion({ stopClusterSells: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Old Stop Cluster Sells<input data-kioseff-field="absorbtion.oldStopClusterSells" type="number" min={0} value={settings.absorbtion.oldStopClusterSells} onChange={(event) => patchAbsorbtion({ oldStopClusterSells: Math.max(0, Number(event.target.value)) })} /></label>
          <label>Old Stop Clusters Buys<input data-kioseff-field="absorbtion.oldStopClusterBuys" type="number" min={0} value={settings.absorbtion.oldStopClusterBuys} onChange={(event) => patchAbsorbtion({ oldStopClusterBuys: Math.max(0, Number(event.target.value)) })} /></label>
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
          <label>Cluster Color<input data-kioseff-field="absorbtion.clusterColor" type="color" value={settings.absorbtion.clusterColor} onChange={(event) => patchAbsorbtion({ clusterColor: event.target.value })} /></label>
          <label>Old Cluster Color<input data-kioseff-field="absorbtion.oldClusterColor" type="color" value={settings.absorbtion.oldClusterColor} onChange={(event) => patchAbsorbtion({ oldClusterColor: event.target.value })} /></label>
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
                const supported = isKioseffLowerTimeframeSupported(option.value, chartTimeframe);
                return <option key={option.value} value={option.value} disabled={!supported} title={supported ? option.label : `Must be lower than ${chartTimeframe}`}>{option.value} · {option.label}{supported ? "" : " (unsupported)"}</option>;
              })}
            </select>
            <small>Lower-timeframe history cost increases with the selected chart depth.</small>
          </label>
          <label>Strong Cluster Color<input data-kioseff-field="volatilityAtEntry.strongClusterColor" type="color" value={settings.volatilityAtEntry.strongClusterColor} onChange={(event) => patchVae({ strongClusterColor: event.target.value })} /></label>
          <label>Weak Cluster Color<input data-kioseff-field="volatilityAtEntry.weakClusterColor" type="color" value={settings.volatilityAtEntry.weakClusterColor} onChange={(event) => patchVae({ weakClusterColor: event.target.value })} /></label>
          <label>Show Historical Triggers<input data-kioseff-field="volatilityAtEntry.showHistoricalTriggers" type="checkbox" checked={settings.volatilityAtEntry.showHistoricalTriggers} onChange={(event) => patchVae({ showHistoricalTriggers: event.target.checked })} /></label>
          <label>Show Active Cluster Size<input data-kioseff-field="volatilityAtEntry.showActiveClusterSize" type="checkbox" checked={settings.volatilityAtEntry.showActiveClusterSize} onChange={(event) => patchVae({ showActiveClusterSize: event.target.checked })} /></label>
        </div>
      )}
      <div className="indicator-settings-section">
        <b>Optionals</b>
        <label>Force Find Typical Move (Less Similar)<input data-kioseff-field="forceTypicalMove" type="checkbox" checked={settings.forceTypicalMove} onChange={(event) => patch({ forceTypicalMove: event.target.checked })} /></label>
        <label>Show Cluster Ratio Meter<input data-kioseff-field="showClusterRatioMeter" type="checkbox" checked={settings.showClusterRatioMeter} onChange={(event) => patch({ showClusterRatioMeter: event.target.checked })} /></label>
      </div>
      <button type="button" className="tv-defaults" onClick={() => onChange(structuredClone(KIOSEFF_DEFAULT_SETTINGS))}>Defaults</button>
    </div>
  );
}
