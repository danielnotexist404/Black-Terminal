import { Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getMarketDataEngineAdapter } from "../../../../market-data/engine/marketDataEngine";
import { marketCatalog } from "../../../../market-data/marketCatalog";
import type { MarketSymbol } from "../../../../market-data/types";
import { automationTimeframes } from "../../automation/strategyDefinitionModel";
import type { StrategyIndicatorInstance } from "../state/indicatorManifest";
import { bindIndicator, defaultWizardPaperPolicy, type StrategyWizardDraft } from "../state/strategyDraftStore";

export function IndicatorMarketStep({ draft, chartTimeframe, indicators, templates, onChange }: { draft: StrategyWizardDraft; chartTimeframe: string; indicators: StrategyIndicatorInstance[]; templates: StrategyIndicatorInstance[]; onChange: (draft: StrategyWizardDraft) => void }) {
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<MarketSymbol[]>([]);
  const [marketStatus, setMarketStatus] = useState("Loading markets");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const kind = draft.definition.marketType === "SPOT" ? "spot" : "perpetual";
    const fallback = marketCatalog.find((row) => row.id === "bybit")?.symbols.filter((symbol) => symbol.marketKind === kind) || [];
    setSymbols(fallback);
    const adapter = getMarketDataEngineAdapter("bybit");
    if (!adapter.getSymbols) { setMarketStatus(`${fallback.length} catalog markets`); return; }
    void adapter.getSymbols(kind).then((rows) => { if (!cancelled) { setSymbols(rows); setMarketStatus(`${rows.length} Bybit markets`); } }).catch(() => !cancelled && setMarketStatus("Live list unavailable · catalog restored"));
    return () => { cancelled = true; };
  }, [draft.definition.marketType]);
  const filtered = useMemo(() => symbols.filter((row) => `${row.rawSymbol} ${row.baseAsset} ${row.quoteAsset}`.toUpperCase().includes(query.toUpperCase())).slice(0, 500), [query, symbols]);
  const currentIndicator = [...indicators, ...templates].find((item) => item.instanceId === draft.definition.indicator?.instanceId);
  const select = (item: StrategyIndicatorInstance) => onChange(bindIndicator(draft, item, item.runtimeKind, item.settings));
  return <div className="strategy-wizard-section">
    <header><span>02</span><div><h2>Indicator and market</h2><p>Pin the signal source, instrument and independent strategy timeframe.</p></div></header>
    <div className="strategy-primary-choice-row">
      <label>SELECT INDICATOR<select value={currentIndicator?.instanceId || ""} onChange={(event) => { const item = indicators.find((row) => row.instanceId === event.target.value); if (item) select(item); }}><option value="">Choose an active chart indicator</option>{indicators.map((item) => <option key={item.instanceId} value={item.instanceId}>{item.instanceName} · {item.runtimeStatus === "CERTIFIED" ? "VPS READY" : "CERTIFICATION REQUIRED"}</option>)}</select><em>{indicators.length ? `${indicators.length} active chart instance${indicators.length === 1 ? "" : "s"}` : "No active indicators on the chart"}</em></label>
      <label>CURRENCY PAIR<span className="instrument-search"><Search size={13} /><input aria-label="Search strategy symbol" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbol" /></span><select aria-label="Selected strategy instrument" value={draft.definition.symbol} onChange={(event) => onChange({ ...draft, definition: { ...draft.definition, symbol: event.target.value } })}>{!filtered.some((row) => row.rawSymbol === draft.definition.symbol) ? <option>{draft.definition.symbol}</option> : null}{filtered.map((row) => <option key={`${row.marketKind}:${row.rawSymbol}`} value={row.rawSymbol}>{row.rawSymbol} · {row.baseAsset}/{row.quoteAsset}</option>)}</select><em>{marketStatus} · Signal market only</em></label>
      <label>STRATEGY TF<select value={draft.definition.timeframe} onChange={(event) => onChange({ ...draft, definition: { ...draft.definition, timeframe: event.target.value } })}>{automationTimeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}</select><em>Current chart: {chartTimeframe} · Runtime: {draft.definition.timeframe}</em></label>
    </div>
    <div className="strategy-market-kind-cards">
      {(["SPOT", "FUTURES"] as const).map((marketType) => <button key={marketType} type="button" className={draft.definition.marketType === marketType ? "active" : ""} onClick={() => onChange({ ...draft, paperPolicy: defaultWizardPaperPolicy(marketType), definition: { ...draft.definition, marketType, paper: { ...draft.definition.paper, modelFunding: marketType === "FUTURES" } } })}><strong>{marketType}</strong><span>{marketType === "SPOT" ? "Buy and sell the underlying asset" : "Open long and short leveraged positions"}</span></button>)}
    </div>
    <details className="strategy-template-picker"><summary>START FROM A TEMPLATE <span>Optional</span></summary><div>{templates.map((item) => <button key={item.instanceId} type="button" onClick={() => select(item)}><strong>{item.name}</strong><span>{item.name.includes("EMA") ? "Fast/slow EMA confirmed-bar crossover." : "Adaptive regime, swing, RSI, ATR and volume model."}</span></button>)}</div></details>
    {currentIndicator ? <div className="indicator-binding-card"><div><ShieldCheck size={16} /><strong>{currentIndicator.instanceName}</strong><span>Version {currentIndicator.version} · {currentIndicator.alerts.length} strategy alerts · {currentIndicator.runtimeStatus.replaceAll("_", " ")}</span></div><label><input type="checkbox" checked={draft.definition.indicator?.useCurrentChartSettings !== false} onChange={(event) => onChange({ ...draft, definition: { ...draft.definition, indicator: { ...draft.definition.indicator!, useCurrentChartSettings: event.target.checked } } })} /> USE CURRENT CHART SETTINGS</label><button type="button" onClick={() => setAdvancedOpen((open) => !open)}>REVIEW SETTINGS</button>{advancedOpen ? <pre>{JSON.stringify(currentIndicator.settings, null, 2)}</pre> : null}</div> : null}
  </div>;
}
