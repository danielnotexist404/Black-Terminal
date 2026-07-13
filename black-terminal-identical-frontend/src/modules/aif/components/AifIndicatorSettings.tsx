import type { AifImplementedProfileType, AifSettings } from "../core/aifTypes";
import { implementedAifProfiles } from "../profiles/aifProfileRegistry";

type Props = { settings: AifSettings; onChange: (next: AifSettings) => void; onClose: () => void };

export function AifIndicatorSettings({ settings, onChange, onClose }: Props) {
  const patch = (value: Partial<AifSettings>) => onChange({ ...settings, ...value });
  const profiles = implementedAifProfiles();
  const horizonPresets = [2000, 5000, 20000, 50000, 100000];
  const horizonPreset = horizonPresets.includes(settings.lookbackBars) ? String(settings.lookbackBars) : "custom";
  return (
    <div className="indicator-settings profile-settings aif-settings" data-testid="aif-settings">
      <div className="indicator-settings-title"><span>A.I.F. SETTINGS</span><button type="button" onClick={onClose}>DONE</button></div>
      <section className="indicator-settings-section"><b>PROFILE</b>
        <label>Primary Profile<select value={settings.primaryProfile} onChange={(event) => patch({ primaryProfile: event.target.value as AifImplementedProfileType })}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>Secondary Profile<select value={settings.secondaryProfile} onChange={(event) => patch({ secondaryProfile: event.target.value as AifSettings["secondaryProfile"] })}><option value="off">Off</option>{profiles.filter((profile) => profile.id !== settings.primaryProfile).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      </section>
      <section className="indicator-settings-section"><b>CALCULATION</b>
        <label>History Horizon<select value={horizonPreset} onChange={(event) => event.target.value !== "custom" && patch({ lookbackBars: Number(event.target.value) })}>{horizonPresets.map((value) => <option key={value} value={value}>{value.toLocaleString()} bars</option>)}<option value="custom">Custom</option></select></label>
        {horizonPreset === "custom" && <label>Custom Bars<input type="number" min={100} max={100000} step={100} value={settings.lookbackBars} onChange={(event) => patch({ lookbackBars: Math.max(100, Math.min(100000, Number(event.target.value))) })} /></label>}
        <label>Bucket Mode<select value={settings.bucketMode} onChange={(event) => patch({ bucketMode: event.target.value as AifSettings["bucketMode"], logarithmic: event.target.value === "logarithmic" })}><option value="fixed-rows">Fixed Row Count</option><option value="fixed-price">Fixed Price Size</option><option value="tick">Tick Size</option><option value="percentage">Percentage</option><option value="logarithmic">Logarithmic</option><option value="atr-normalized">ATR Normalized</option><option value="adaptive">Adaptive Multi-Resolution</option></select></label>
        {(settings.bucketMode === "fixed-rows" || settings.bucketMode === "logarithmic") && <label>Rows<input type="number" min={40} max={2000} value={settings.rowCount} onChange={(event) => patch({ rowCount: Number(event.target.value) })} /></label>}
        {(settings.bucketMode === "fixed-price" || settings.bucketMode === "tick") && <label>{settings.bucketMode === "tick" ? "Tick Size" : "Price Size"}<input type="number" min={0.00000001} step="any" value={settings.fixedPriceSize} onChange={(event) => patch({ fixedPriceSize: Number(event.target.value) })} /></label>}
        {settings.bucketMode === "percentage" && <label>Bucket Percent<input type="number" min={0.0001} max={25} step={0.01} value={settings.percentageBucket} onChange={(event) => patch({ percentageBucket: Number(event.target.value) })} /></label>}
      </section>
      {settings.primaryProfile === "volatility" && <section className="indicator-settings-section"><b>VOLATILITY</b><label>Estimator<select value={settings.volatilityEstimator} onChange={(event) => patch({ volatilityEstimator: event.target.value as AifSettings["volatilityEstimator"] })}><option value="composite">Composite</option><option value="true-range">True Range</option><option value="log-return-variance">Log Return Variance</option><option value="parkinson">Parkinson</option></select></label><label>Allocation<select value={settings.volatilityAllocation} onChange={(event) => patch({ volatilityAllocation: event.target.value as AifSettings["volatilityAllocation"] })}><option value="body-weighted">Body Weighted</option><option value="uniform-range">Uniform Range</option><option value="close-location">Close Location</option></select></label></section>}
      {settings.primaryProfile === "tpo" && <section className="indicator-settings-section"><b>TPO</b><label>Period Minutes<input type="number" min={1} max={1440} value={settings.tpoPeriodMinutes} onChange={(event) => patch({ tpoPeriodMinutes: Number(event.target.value) })} /></label></section>}
      <section className="indicator-settings-section"><b>STRUCTURE</b>
        <label>POC<input type="checkbox" checked={settings.showPoc} onChange={(event) => patch({ showPoc: event.target.checked })} /></label>
        <label>VAH / VAL<input type="checkbox" checked={settings.showValueArea} onChange={(event) => patch({ showValueArea: event.target.checked })} /></label>
        <label>Future LVNs<input type="checkbox" checked={settings.showFutureLvns} onChange={(event) => patch({ showFutureLvns: event.target.checked })} /></label>
        <label>S/R Zones<input type="checkbox" checked={settings.showSupportResistance} onChange={(event) => patch({ showSupportResistance: event.target.checked })} /></label>
        <label>Sensitivity<input type="range" min={0} max={100} value={settings.nodeSensitivity} onChange={(event) => patch({ nodeSensitivity: Number(event.target.value) })} /></label>
      </section>
      <section className="indicator-settings-section"><b>TIMELINE & IMM</b>
        <label>Event Timeline<input type="checkbox" checked={settings.showTimeline} onChange={(event) => patch({ showTimeline: event.target.checked })} /></label>
        <label>Minimum Confidence<input type="range" min={0} max={100} value={settings.minimumConfidence} onChange={(event) => patch({ minimumConfidence: Number(event.target.value) })} /></label>
        <label>IMM Confirmation<input type="checkbox" checked={settings.enableImmConfirmation} onChange={(event) => patch({ enableImmConfirmation: event.target.checked })} /></label>
      </section>
    </div>
  );
}
