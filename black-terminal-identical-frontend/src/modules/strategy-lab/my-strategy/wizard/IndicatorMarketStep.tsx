import { Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getMarketDataEngineAdapter } from "../../../../market-data/engine/marketDataEngine";
import { marketCatalog } from "../../../../market-data/marketCatalog";
import type { MarketSymbol } from "../../../../market-data/types";
import type { StrategyMarketType } from "../../automation/strategyAutomation.types";
import { automationTimeframes } from "../../automation/strategyDefinitionModel";
import type { StrategyIndicatorInstance } from "../state/indicatorManifest";
import { bindIndicator, selectStrategyMarket, type StrategyWizardDraft } from "../state/strategyDraftStore";

const brokerCommandContracts = {
  FUTURES: {
    title: "USDT PERPETUAL FUTURES",
    detail: "Directional contracts · leverage and reduce-only exits",
    commands: [
      ["LONG SIGNAL", "OPEN LONG", "BUY · LINEAR · REDUCE-ONLY FALSE"],
      ["SHORT SIGNAL", "OPEN SHORT", "SELL · LINEAR · REDUCE-ONLY FALSE"],
      ["LONG EXIT", "CLOSE LONG", "SELL · LINEAR · REDUCE-ONLY TRUE"],
      ["SHORT EXIT", "CLOSE SHORT", "BUY · LINEAR · REDUCE-ONLY TRUE"],
    ],
  },
  SPOT: {
    title: "SPOT",
    detail: "Owned asset only · no leverage and no short position",
    commands: [
      ["BUY SIGNAL", "BUY ASSET", "BUY · SPOT · NO LEVERAGE"],
      ["SELL SIGNAL", "SELL ASSET", "SELL · SPOT · OWNED QUANTITY ONLY"],
    ],
  },
} as const;

export function IndicatorMarketStep({ draft, chartTimeframe, indicators, onChange }: { draft: StrategyWizardDraft; chartTimeframe: string; indicators: StrategyIndicatorInstance[]; onChange: (draft: StrategyWizardDraft) => void }) {
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
  const currentIndicator = indicators.find((item) => item.instanceId === draft.definition.indicator?.instanceId);
  const select = (item: StrategyIndicatorInstance) => {
    const next = bindIndicator(draft, item, item.runtimeKind, item.settings);
    onChange({ ...next, name: item.name.slice(0, 80) });
  };
  const selectMarket = (marketType: StrategyMarketType) => {
    const next = selectStrategyMarket(draft, marketType);
    const kind = marketType === "SPOT" ? "spot" : "perpetual";
    const catalogSymbols = marketCatalog.find((row) => row.id === "bybit")?.symbols.filter((symbol) => symbol.marketKind === kind) || [];
    const symbol = catalogSymbols.some((item) => item.rawSymbol === draft.definition.symbol)
      ? draft.definition.symbol
      : catalogSymbols[0]?.rawSymbol || draft.definition.symbol;
    onChange({ ...next, definition: { ...next.definition, symbol } });
  };
  const commandContract = brokerCommandContracts[draft.definition.marketType];
  return <div className="strategy-wizard-section">
    <header><span>01</span><div><h2>Strategy and market</h2><p>Select the saved strategy or indicator, its broker market contract, currency and runtime timeframe. The chosen market controls the API commands available in Signal Mapping.</p></div></header>
    <section className="strategy-market-command-contract" aria-label="Broker market execution contract">
      <header><div><strong>MARKET EXECUTION CONTRACT</strong><span>This is saved with the strategy and checked again before a broker target can be armed.</span></div><b>BYBIT API ROUTING</b></header>
      <div className="strategy-market-selector">
        {(Object.keys(brokerCommandContracts) as StrategyMarketType[]).map((marketType) => {
          const contract = brokerCommandContracts[marketType];
          return <button key={marketType} type="button" aria-pressed={draft.definition.marketType === marketType} className={draft.definition.marketType === marketType ? "active" : ""} onClick={() => selectMarket(marketType)}><span>{marketType}</span><strong>{contract.title}</strong><em>{contract.detail}</em></button>;
        })}
      </div>
      <div className="strategy-broker-command-map">
        <header><span>SCRIPT EVENT</span><span>POSITION COMMAND</span><span>BROKER API ORDER</span></header>
        {commandContract.commands.map(([event, command, api]) => <div key={event}><span>{event}</span><strong>{command}</strong><code>{api}</code></div>)}
      </div>
    </section>
    <div className="strategy-primary-choice-row">
      <label>SELECT INDICATOR OR SCRIPT<select value={currentIndicator?.instanceId || ""} onChange={(event) => { const item = indicators.find((row) => row.instanceId === event.target.value); if (item) select(item); }}><option value="">Nothing selected</option>{indicators.map((item) => <option key={item.instanceId} value={item.instanceId}>{item.instanceName} · {item.alerts.length} EVENTS · {item.runtimeStatus === "CERTIFIED" ? "RUNTIME READY" : "CERTIFICATION REQUIRED"}</option>)}</select><em>{indicators.length ? `${indicators.length} eligible signal source${indicators.length === 1 ? "" : "s"}; none is selected automatically` : "No indicators or scripts with alert events are available"}</em></label>
      <label>CURRENCY PAIR<span className="instrument-search"><Search size={13} /><input aria-label="Search strategy symbol" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbol" /></span><select aria-label="Selected strategy instrument" value={draft.definition.symbol} onChange={(event) => onChange({ ...draft, definition: { ...draft.definition, symbol: event.target.value } })}>{!filtered.some((row) => row.rawSymbol === draft.definition.symbol) ? <option>{draft.definition.symbol}</option> : null}{filtered.map((row) => <option key={`${row.marketKind}:${row.rawSymbol}`} value={row.rawSymbol}>{row.rawSymbol} · {row.baseAsset}/{row.quoteAsset}</option>)}</select><em>{marketStatus} · Signal market only</em></label>
      <label>STRATEGY TF<select value={draft.definition.timeframe} onChange={(event) => onChange({ ...draft, definition: { ...draft.definition, timeframe: event.target.value } })}>{automationTimeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}</select><em>Current chart: {chartTimeframe} · Runtime: {draft.definition.timeframe}</em></label>
    </div>
    {currentIndicator ? <div className="indicator-binding-card"><div><ShieldCheck size={16} /><strong>{currentIndicator.instanceName}</strong><span>Version {currentIndicator.version} · {currentIndicator.alerts.length} strategy alerts · {currentIndicator.runtimeStatus.replaceAll("_", " ")}</span></div><button type="button" onClick={() => setAdvancedOpen((open) => !open)}>REVIEW PINNED INPUTS</button>{advancedOpen ? <pre>{JSON.stringify(Object.fromEntries(Object.entries(currentIndicator.settings).filter(([key]) => key !== "__nativeInputs")), null, 2)}</pre> : null}</div> : null}
  </div>;
}
