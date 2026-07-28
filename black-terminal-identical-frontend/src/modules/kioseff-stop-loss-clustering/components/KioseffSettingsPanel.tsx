import type { Dispatch, SetStateAction } from "react";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  type KioseffSettingsV1
} from "../core/settings";

type Props = {
  settings: KioseffSettingsV1;
  onChange: Dispatch<SetStateAction<KioseffSettingsV1>>;
  onClose: () => void;
};

const timeframeOptions = ["1m", "3m", "5m", "15m", "30m", "1h", "4h"];

export function KioseffSettingsPanel({ settings, onChange, onClose }: Props) {
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
    <div className="indicator-settings kioseff-settings" role="dialog" aria-label="Stop Loss Clustering settings">
      <div className="indicator-settings-title">
        <span>Stop Loss Clustering</span>
        <button type="button" onClick={onClose}>DONE</button>
      </div>
      <label>
        Model
        <select
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
          <label>X-ray<input type="checkbox" checked={settings.absorbtion.showXRay} onChange={(event) => patchAbsorbtion({ showXRay: event.target.checked })} /></label>
          <label>Set Color Intensity by Stop Cluster Size<input type="checkbox" checked={settings.absorbtion.intensityBySize} onChange={(event) => patchAbsorbtion({ intensityBySize: event.target.checked })} /></label>
          <label>Stop Cluster Buys<input type="number" min={1} value={settings.absorbtion.stopClusterBuys} onChange={(event) => patchAbsorbtion({ stopClusterBuys: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Stop Cluster Sells<input type="number" min={1} value={settings.absorbtion.stopClusterSells} onChange={(event) => patchAbsorbtion({ stopClusterSells: Math.max(1, Number(event.target.value)) })} /></label>
          <label>Old Stop Cluster Sells<input type="number" min={0} value={settings.absorbtion.oldStopClusterSells} onChange={(event) => patchAbsorbtion({ oldStopClusterSells: Math.max(0, Number(event.target.value)) })} /></label>
          <label>Old Stop Clusters Buys<input type="number" min={0} value={settings.absorbtion.oldStopClusterBuys} onChange={(event) => patchAbsorbtion({ oldStopClusterBuys: Math.max(0, Number(event.target.value)) })} /></label>
          <label>
            Lower Timeframe Vol. Data
            <select value={settings.absorbtion.lowerTimeframe} onChange={(event) => patchAbsorbtion({ lowerTimeframe: event.target.value })}>
              {timeframeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Cluster Color<input type="color" value={settings.absorbtion.clusterColor} onChange={(event) => patchAbsorbtion({ clusterColor: event.target.value })} /></label>
          <label>Old Cluster Color<input type="color" value={settings.absorbtion.oldClusterColor} onChange={(event) => patchAbsorbtion({ oldClusterColor: event.target.value })} /></label>
        </div>
      ) : (
        <div className="indicator-settings-section">
          <b>Time-Scaled Volatility</b>
          <label>
            Level Granularity
            <select value={settings.volatilityAtEntry.granularity} onChange={(event) => patchVae({ granularity: event.target.value as "lower" | "higher" })}>
              <option value="lower">Lower</option>
              <option value="higher">Higher (Heavy)</option>
            </select>
          </label>
          <label>
            Time-Scaled Volatility TF
            <select value={settings.volatilityAtEntry.timeScaledVolatilityTimeframe} onChange={(event) => patchVae({ timeScaledVolatilityTimeframe: event.target.value })}>
              {timeframeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Strong Cluster Color<input type="color" value={settings.volatilityAtEntry.strongClusterColor} onChange={(event) => patchVae({ strongClusterColor: event.target.value })} /></label>
          <label>Weak Cluster Color<input type="color" value={settings.volatilityAtEntry.weakClusterColor} onChange={(event) => patchVae({ weakClusterColor: event.target.value })} /></label>
          <label>Show Historical Triggers<input type="checkbox" checked={settings.volatilityAtEntry.showHistoricalTriggers} onChange={(event) => patchVae({ showHistoricalTriggers: event.target.checked })} /></label>
          <label>Show Active Cluster Size<input type="checkbox" checked={settings.volatilityAtEntry.showActiveClusterSize} onChange={(event) => patchVae({ showActiveClusterSize: event.target.checked })} /></label>
        </div>
      )}
      <div className="indicator-settings-section">
        <b>Optionals</b>
        <label>Force Find Typical Move (Less Similar)<input type="checkbox" checked={settings.forceTypicalMove} onChange={(event) => patch({ forceTypicalMove: event.target.checked })} /></label>
        <label>Show Cluster Ratio Meter<input type="checkbox" checked={settings.showClusterRatioMeter} onChange={(event) => patch({ showClusterRatioMeter: event.target.checked })} /></label>
      </div>
      <button type="button" className="tv-defaults" onClick={() => onChange(structuredClone(KIOSEFF_DEFAULT_SETTINGS))}>Defaults</button>
    </div>
  );
}
