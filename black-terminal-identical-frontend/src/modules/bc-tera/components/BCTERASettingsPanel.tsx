import { migrateBCTERASettings } from "../core/settings";
import type { BCTERASettings, BCTERASnapshot } from "../core/types";

type Props = {
  settings: BCTERASettings;
  snapshot: BCTERASnapshot | null;
  status: "IDLE" | "CALCULATING" | "READY" | "DATA_DEGRADED" | "UNAVAILABLE";
  workerMode: "WORKER" | "INLINE" | "NOT_STARTED";
  calculationMs: number | null;
  onChange: (settings: BCTERASettings) => void;
};

export function BCTERASettingsPanel({ settings, snapshot, status, workerMode, calculationMs, onChange }: Props) {
  const patch = <Key extends Exclude<keyof BCTERASettings, "version">>(section: Key, values: Partial<BCTERASettings[Key]>) => {
    onChange(migrateBCTERASettings({
      ...settings,
      [section]: { ...(settings[section] as object), ...values }
    } as BCTERASettings));
  };
  const latest = snapshot?.points.at(-1);
  const unavailable = snapshot?.sourceStatus.filter((source) => source.quality === "UNAVAILABLE") ?? [];

  return <div className="indicator-settings-grid bc-tera-settings">
    <div className="vwap-settings-section-label">Data Sources</div>
    <label>Use On-Chain Evidence<input type="checkbox" checked={settings.dataSources.useOnChain} onChange={(event) => patch("dataSources", { useOnChain: event.target.checked })} /></label>
    <label>Use Spot Flow<input type="checkbox" checked={settings.dataSources.useSpotFlow} onChange={(event) => patch("dataSources", { useSpotFlow: event.target.checked })} /></label>
    <label>Use Order-Book Evidence<input type="checkbox" checked={settings.dataSources.useOrderBook} onChange={(event) => patch("dataSources", { useOrderBook: event.target.checked })} /></label>
    <label>Use Derivatives<input type="checkbox" checked={settings.dataSources.useDerivatives} onChange={(event) => patch("dataSources", { useDerivatives: event.target.checked })} /></label>
    <label>Use Liquidations<input type="checkbox" checked={settings.dataSources.useLiquidations} onChange={(event) => patch("dataSources", { useLiquidations: event.target.checked })} /></label>
    <label>Use Options<input type="checkbox" checked={settings.dataSources.useOptions} onChange={(event) => patch("dataSources", { useOptions: event.target.checked })} /></label>
    <label>Require Multi-Venue Confirmation<input type="checkbox" checked={settings.dataSources.requireMultiVenue} onChange={(event) => patch("dataSources", { requireMultiVenue: event.target.checked })} /></label>
    <label>Minimum Data Confidence<input type="number" min={0} max={100} value={settings.dataSources.minimumConfidence} onChange={(event) => patch("dataSources", { minimumConfidence: Number(event.target.value) })} /></label>

    <div className="vwap-settings-section-label">Time Horizon</div>
    <label>Decision Timeframe<select value={settings.timeHorizon.decisionTimeframe} onChange={(event) => patch("timeHorizon", { decisionTimeframe: event.target.value as BCTERASettings["timeHorizon"]["decisionTimeframe"] })}><option>4H</option><option>12H</option><option>1D</option><option>3D</option><option>1W</option></select></label>
    <label>Confirmation Timeframe<select value={settings.timeHorizon.confirmationTimeframe} onChange={(event) => patch("timeHorizon", { confirmationTimeframe: event.target.value as BCTERASettings["timeHorizon"]["confirmationTimeframe"] })}><option>4H</option><option>12H</option><option>1D</option><option>3D</option><option>1W</option></select></label>
    <label>Hazard Horizon<input type="number" min={1} max={100} value={settings.timeHorizon.hazardHorizon} onChange={(event) => patch("timeHorizon", { hazardHorizon: Number(event.target.value) })} /></label>
    <label>Feature Lookback<input type="number" min={30} max={2000} value={settings.timeHorizon.featureLookback} onChange={(event) => patch("timeHorizon", { featureLookback: Number(event.target.value) })} /></label>
    <label>Regime Duration Lookback<input type="number" min={10} max={1000} value={settings.timeHorizon.regimeLookback} onChange={(event) => patch("timeHorizon", { regimeLookback: Number(event.target.value) })} /></label>

    <div className="vwap-settings-section-label">Extremity</div>
    <label>Valuation Weight<input type="number" min={0} max={3} step={0.1} value={settings.extremity.valuationWeight} onChange={(event) => patch("extremity", { valuationWeight: Number(event.target.value) })} /></label>
    <label>Cost-Basis Weight<input type="number" min={0} max={3} step={0.1} value={settings.extremity.costBasisWeight} onChange={(event) => patch("extremity", { costBasisWeight: Number(event.target.value) })} /></label>
    <label>Holder Distribution Weight<input type="number" min={0} max={3} step={0.1} value={settings.extremity.holderDistributionWeight} onChange={(event) => patch("extremity", { holderDistributionWeight: Number(event.target.value) })} /></label>
    <label>Robust-Z Lookback<input type="number" min={20} max={2000} value={settings.extremity.robustZLookback} onChange={(event) => patch("extremity", { robustZLookback: Number(event.target.value) })} /></label>
    <label>Extremity Percentile<input type="number" min={50} max={99} value={settings.extremity.percentile} onChange={(event) => patch("extremity", { percentile: Number(event.target.value) })} /></label>

    <div className="vwap-settings-section-label">Leverage</div>
    <label>OI Weight<input type="number" min={0} max={3} step={0.1} value={settings.leverage.oiWeight} onChange={(event) => patch("leverage", { oiWeight: Number(event.target.value) })} /></label>
    <label>Funding Weight<input type="number" min={0} max={3} step={0.1} value={settings.leverage.fundingWeight} onChange={(event) => patch("leverage", { fundingWeight: Number(event.target.value) })} /></label>
    <label>Basis Weight<input type="number" min={0} max={3} step={0.1} value={settings.leverage.basisWeight} onChange={(event) => patch("leverage", { basisWeight: Number(event.target.value) })} /></label>
    <label>Liquidation Weight<input type="number" min={0} max={3} step={0.1} value={settings.leverage.liquidationWeight} onChange={(event) => patch("leverage", { liquidationWeight: Number(event.target.value) })} /></label>
    <label>Fragility Threshold<input type="number" min={0} max={100} value={settings.leverage.fragilityThreshold} onChange={(event) => patch("leverage", { fragilityThreshold: Number(event.target.value) })} /></label>

    <div className="vwap-settings-section-label">Exhaustion and Absorption</div>
    <label>Flow Lookback<input type="number" min={5} max={500} value={settings.exhaustion.flowLookback} onChange={(event) => patch("exhaustion", { flowLookback: Number(event.target.value) })} /></label>
    <label>Minimum Aggressive Flow<input type="number" min={0} max={100} value={settings.exhaustion.minimumAggressiveFlow} onChange={(event) => patch("exhaustion", { minimumAggressiveFlow: Number(event.target.value) })} /></label>
    <label>Impact Lookback<input type="number" min={5} max={500} value={settings.exhaustion.impactLookback} onChange={(event) => patch("exhaustion", { impactLookback: Number(event.target.value) })} /></label>
    <label>Impact-Collapse Threshold<input type="number" min={0} max={100} value={settings.exhaustion.impactCollapseThreshold} onChange={(event) => patch("exhaustion", { impactCollapseThreshold: Number(event.target.value) })} /></label>
    <label>Absorption Persistence<input type="number" min={1} max={20} value={settings.exhaustion.absorptionPersistence} onChange={(event) => patch("exhaustion", { absorptionPersistence: Number(event.target.value) })} /></label>
    <label>Multi-Venue Agreement<input type="number" min={0} max={100} value={settings.exhaustion.multiVenueAgreement} onChange={(event) => patch("exhaustion", { multiVenueAgreement: Number(event.target.value) })} /></label>

    <div className="vwap-settings-section-label">Change Point</div>
    <label>Detection Method<select value={settings.changePoint.method} onChange={(event) => patch("changePoint", { method: event.target.value as BCTERASettings["changePoint"]["method"] })}><option value="DIRECTIONAL_CUSUM">Directional CUSUM</option><option value="BAYESIAN_ONLINE" disabled>Bayesian Online (Phase II)</option></select></label>
    <label>Sensitivity<input type="number" min={0.25} max={8} step={0.05} value={settings.changePoint.sensitivity} onChange={(event) => patch("changePoint", { sensitivity: Number(event.target.value) })} /></label>
    <label>Minimum Run Length<input type="number" min={1} max={20} value={settings.changePoint.minimumRunLength} onChange={(event) => patch("changePoint", { minimumRunLength: Number(event.target.value) })} /></label>
    <label>Confirmation Probability<input type="number" min={1} max={100} value={settings.changePoint.confirmationProbability} onChange={(event) => patch("changePoint", { confirmationProbability: Number(event.target.value) })} /></label>
    <label>Structure-Break Requirement<input type="checkbox" checked={settings.changePoint.requireStructureBreak} onChange={(event) => patch("changePoint", { requireStructureBreak: event.target.checked })} /></label>

    <div className="vwap-settings-section-label">Signal Confirmation</div>
    <label>Top Hazard Threshold<input type="number" min={1} max={100} value={settings.confirmation.topHazardThreshold} onChange={(event) => patch("confirmation", { topHazardThreshold: Number(event.target.value) })} /></label>
    <label>Bottom Hazard Threshold<input type="number" min={1} max={100} value={settings.confirmation.bottomHazardThreshold} onChange={(event) => patch("confirmation", { bottomHazardThreshold: Number(event.target.value) })} /></label>
    <label>Directional Evidence Margin<input type="number" min={0} max={100} value={settings.confirmation.directionalEvidenceMargin} onChange={(event) => patch("confirmation", { directionalEvidenceMargin: Number(event.target.value) })} /></label>
    <label>Minimum State Duration<input type="number" min={1} max={20} value={settings.confirmation.minimumStateDuration} onChange={(event) => patch("confirmation", { minimumStateDuration: Number(event.target.value) })} /></label>
    <label>Cooldown Bars<input type="number" min={0} max={100} value={settings.confirmation.cooldownBars} onChange={(event) => patch("confirmation", { cooldownBars: Number(event.target.value) })} /></label>
    <label>Confirmed Candles Only<input type="checkbox" checked disabled /></label>
    <label>One Signal per Terminal Episode<input type="checkbox" checked disabled /></label>

    <div className="vwap-settings-section-label">Automation Readiness</div>
    <div className="vwap-mode-note">Research Only: YES · Alerts Certified: NO · Shadow Strategy: NO · Paper Strategy: NO</div>
    <div className="vwap-mode-note">LIVE EXECUTION LOCKED · no broker or order path exists in BC-TERA.</div>
    <div className="vwap-mode-note">{status} · {workerMode} · {calculationMs == null ? "--" : calculationMs.toFixed(2)} ms · {snapshot?.modelVersion ?? "awaiting model"}</div>
    <div className="vwap-mode-note">{latest ? `${latest.state} · top ${latest.topHazard.toFixed(0)} · bottom ${latest.bottomHazard.toFixed(0)} · confidence ${latest.dataConfidence.toFixed(0)}` : "Awaiting bounded higher-timeframe feature payload"}</div>
    {unavailable.map((source) => <div className="vwap-mode-note" key={source.family}>{source.family.replaceAll("_", " ")}: UNAVAILABLE — contributes no score</div>)}
  </div>;
}
