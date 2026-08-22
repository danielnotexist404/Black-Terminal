import { useState } from "react";
import type { StrategyWizardDraft } from "../state/strategyDraftStore";
import { NumberField } from "./ExecutionStep";

export function FiltersStep({ draft, onChange }: { draft: StrategyWizardDraft; onChange: (draft: StrategyWizardDraft) => void }) {
  const [advanced, setAdvanced] = useState(false);
  const filters = draft.definition.filters || {};
  const schedule = draft.definition.schedule || {};
  const patchFilters = (key: string, value: unknown) => onChange({ ...draft, definition: { ...draft.definition, filters: { ...filters, [key]: value } } });
  const patchSchedule = (key: string, value: unknown) => onChange({ ...draft, definition: { ...draft.definition, schedule: { ...schedule, [key]: value } } });
  const days = Array.isArray(filters.tradingDays) ? filters.tradingDays as number[] : [0, 1, 2, 3, 4, 5, 6];
  return <div className="strategy-wizard-section"><header><span>06</span><div><h2>Filters and schedule</h2><p>Control when the strategy is allowed to accept otherwise valid signals.</p></div></header>
    <div className="wizard-risk-section"><h3>TRADING SCHEDULE</h3><div className="trading-days">{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day, index) => <button key={day} type="button" className={days.includes(index) ? "active" : ""} onClick={() => patchFilters("tradingDays", days.includes(index) ? days.filter((value) => value !== index) : [...days, index].sort())}>{day}</button>)}</div><div className="strategy-form-grid"><NumberField label="START HOUR" value={Number(schedule.startHour || 0)} suffix="UTC" min={0} max={23} onChange={(value) => patchSchedule("startHour", value)} /><NumberField label="END HOUR" value={Number(schedule.endHour || 24)} suffix="UTC" min={1} max={24} onChange={(value) => patchSchedule("endHour", value)} /><label>TIMEZONE<select value={String(filters.timezone || "UTC")} onChange={(event) => patchFilters("timezone", event.target.value)}><option>UTC</option><option>Europe/Athens</option><option>Asia/Singapore</option><option>America/New_York</option></select></label><NumberField label="MINIMUM BARS BETWEEN TRADES" value={Number(filters.minimumBarsBetweenTrades || 1)} suffix="bars" min={0} onChange={(value) => patchFilters("minimumBarsBetweenTrades", value)} /><NumberField label="COOLDOWN AFTER LOSS" value={Number(filters.cooldownAfterLoss || 0)} suffix="bars" min={0} onChange={(value) => patchFilters("cooldownAfterLoss", value)} /><NumberField label="COOLDOWN AFTER STOP" value={Number(filters.cooldownAfterStop || 0)} suffix="bars" min={0} onChange={(value) => patchFilters("cooldownAfterStop", value)} /></div></div>
    <button type="button" className="advanced-disclosure" onClick={() => setAdvanced((open) => !open)}>{advanced ? "HIDE" : "SHOW"} ADVANCED FILTERS</button>
    {advanced ? <div className="advanced-filter-grid">{["Second Indicator", "Higher-Timeframe Signal", "Trend", "Volatility", "Volume", "Spread", "Funding", "Open Interest", "Market Data Health", "BC-RDA Risk State"].map((label) => { const key = label.toLowerCase().replaceAll(/[^a-z]+/g, "_"); return <label key={key}><input type="checkbox" checked={filters[key] === true} onChange={(event) => patchFilters(key, event.target.checked)} /><span><strong>{label}</strong><em>Optional entry gate · disabled by default</em></span></label>; })}</div> : null}
  </div>;
}
