import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Database,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { getMarketDataEngineAdapter } from "../../../market-data/engine/marketDataEngine";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { MarketSymbol } from "../../../market-data/types";
import type {
  StrategyRuntimeKind,
  StrategySettings,
} from "../types/strategy.types";
import type { StrategyAutomationDefinition } from "./strategyAutomation.types";
import {
  automationTimeframes,
  certifiedStrategyEngines,
  validateAutomationDefinition,
} from "./strategyDefinitionModel";

type Props = {
  definition: StrategyAutomationDefinition;
  locked: boolean;
  dirty: boolean;
  onChange: (definition: StrategyAutomationDefinition) => void;
};

type NumericSetting = {
  key: keyof StrategySettings;
  label: string;
  min: number;
  max?: number;
  step?: number;
  fallback: number;
};

type NumericExecution = {
  key: string;
  label: string;
  min: number;
  max?: number;
  step?: number;
  fallback: number;
  suffix?: string;
};

const commonSettings: NumericSetting[] = [
  { key: "stopLossPercent", label: "Stop distance", min: 0.05, max: 25, step: 0.05, fallback: 0.85 },
  { key: "takeProfitRatio", label: "Take-profit R", min: 0.1, max: 20, step: 0.1, fallback: 2.1 },
  { key: "trailingStopPercent", label: "Trailing stop", min: 0, max: 25, step: 0.05, fallback: 0 },
  { key: "breakEvenAtR", label: "Break-even at R", min: 0, max: 20, step: 0.25, fallback: 1 },
  { key: "partialExitAtR", label: "Partial exit at R", min: 0, max: 20, step: 0.25, fallback: 1.5 },
  { key: "partialExitPercent", label: "Partial exit size", min: 0, max: 100, step: 5, fallback: 0 },
  { key: "sessionStartHour", label: "Session start UTC", min: 0, max: 23, step: 1, fallback: 0 },
  { key: "sessionEndHour", label: "Session end UTC", min: 1, max: 24, step: 1, fallback: 24 },
];

const adaptiveSettings: NumericSetting[] = [
  { key: "swingLookback", label: "Swing lookback", min: 16, max: 500, step: 1, fallback: 36 },
  { key: "atrLength", label: "ATR length", min: 8, max: 500, step: 1, fallback: 21 },
  { key: "regimeEmaLength", label: "Regime EMA", min: 34, max: 1000, step: 1, fallback: 200 },
  { key: "rsiLength", label: "RSI length", min: 5, max: 200, step: 1, fallback: 14 },
  { key: "rsiOversold", label: "RSI oversold", min: 5, max: 50, step: 1, fallback: 42 },
  { key: "rsiOverbought", label: "RSI overbought", min: 50, max: 95, step: 1, fallback: 58 },
  { key: "atrStopMultiplier", label: "ATR stop multiplier", min: 0.5, max: 20, step: 0.05, fallback: 1.55 },
  { key: "swingRetestAtr", label: "Swing retest ATR", min: 0.05, max: 10, step: 0.05, fallback: 0.8 },
  { key: "minTrendQuality", label: "Min trend quality", min: 0, max: 1, step: 0.01, fallback: 0.16 },
  { key: "maxChopRatio", label: "Max chop ratio", min: 0.05, max: 1, step: 0.01, fallback: 0.24 },
  { key: "volumeLookback", label: "Volume lookback", min: 5, max: 1000, step: 1, fallback: 50 },
  { key: "minVolumeMultiplier", label: "Min volume multiplier", min: 0, max: 20, step: 0.05, fallback: 0.5 },
];

const emaSettings: NumericSetting[] = [
  { key: "emaFastLength", label: "Fast EMA", min: 2, max: 1000, step: 1, fallback: 20 },
  { key: "emaSlowLength", label: "Slow EMA", min: 3, max: 2000, step: 1, fallback: 50 },
  { key: "volumeLookback", label: "Volume lookback", min: 5, max: 1000, step: 1, fallback: 50 },
  { key: "minVolumeMultiplier", label: "Min volume multiplier", min: 0, max: 20, step: 0.05, fallback: 0.5 },
];

const executionSettings: NumericExecution[] = [
  { key: "feeRate", label: "Fee rate", min: 0, max: 1, step: 0.0001, fallback: 0.0004 },
  { key: "slippageTicks", label: "Slippage ticks", min: 0, max: 1000, step: 1, fallback: 2 },
  { key: "tickSize", label: "Tick size", min: 0.00000001, step: 0.00000001, fallback: 0.1 },
  { key: "spreadBps", label: "Modeled spread", min: 0, max: 10000, step: 0.1, fallback: 1.5, suffix: "BPS" },
  { key: "maxTradesPerDay", label: "Max trades / day", min: 1, max: 1000, step: 1, fallback: 8 },
  { key: "maxDailyLoss", label: "Max daily loss", min: 0, step: 1, fallback: 250, suffix: "USDT" },
  { key: "maxDrawdown", label: "Max drawdown", min: 0, max: 1, step: 0.01, fallback: 0.2 },
  { key: "maxOpenPositions", label: "Max open positions", min: 1, max: 100, step: 1, fallback: 1 },
  { key: "maxLeverage", label: "Maximum leverage", min: 1, max: 100, step: 1, fallback: 3, suffix: "X" },
  { key: "cooldownAfterLosses", label: "Cooldown after losses", min: 0, max: 100, step: 1, fallback: 3 },
  { key: "disableOnHighSpreadBps", label: "High-spread guard", min: 0, max: 10000, step: 0.1, fallback: 8, suffix: "BPS" },
  { key: "fundingRatePerDay", label: "Funding / day", min: -1, max: 1, step: 0.0001, fallback: 0 },
];

const unavailableEngines = [
  "BC-RDA — certified automation adapter required",
  "Python Script — sandbox adapter required",
  "External Signals — signed webhook adapter required",
];

function fallbackSymbols(marketType: StrategyAutomationDefinition["marketType"]) {
  const wantedKind = marketType === "SPOT" ? "spot" : "perpetual";
  return (
    marketCatalog.find((item) => item.id === "bybit")?.symbols.filter(
      (item) => item.marketKind === wantedKind,
    ) || []
  );
}

function mergeCurrentSymbol(
  symbols: MarketSymbol[],
  definition: StrategyAutomationDefinition,
) {
  const byRaw = new Map(symbols.map((item) => [item.rawSymbol, item]));
  if (!byRaw.has(definition.symbol)) {
    const normalized = definition.symbol.toUpperCase();
    byRaw.set(normalized, {
      exchange: "bybit",
      rawSymbol: normalized,
      baseAsset: normalized.replace(/USDT$/i, ""),
      quoteAsset: normalized.endsWith("USDT") ? "USDT" : "",
      marketKind: definition.marketType === "SPOT" ? "spot" : "perpetual",
    });
  }
  return [...byRaw.values()].sort((left, right) =>
    left.rawSymbol.localeCompare(right.rawSymbol),
  );
}

export function StrategyDefinitionBuilder({
  definition,
  locked,
  dirty,
  onChange,
}: Props) {
  const [symbols, setSymbols] = useState<MarketSymbol[]>(() =>
    mergeCurrentSymbol(fallbackSymbols(definition.marketType), definition),
  );
  const [symbolFilter, setSymbolFilter] = useState("");
  const [marketStatus, setMarketStatus] = useState("LOADING BYBIT MARKETS");
  const issue = validateAutomationDefinition(definition);

  useEffect(() => {
    let cancelled = false;
    const fallback = mergeCurrentSymbol(
      fallbackSymbols(definition.marketType),
      definition,
    );
    setSymbols(fallback);
    setMarketStatus("LOADING BYBIT MARKETS");
    const adapter = getMarketDataEngineAdapter("bybit");
    const marketKind = definition.marketType === "SPOT" ? "spot" : "perpetual";
    if (!adapter.getSymbols) {
      setMarketStatus(`${fallback.length} FALLBACK MARKETS`);
      return () => {
        cancelled = true;
      };
    }
    void adapter
      .getSymbols(marketKind)
      .then((rows) => {
        if (cancelled) return;
        const next = mergeCurrentSymbol(rows, definition);
        setSymbols(next);
        setMarketStatus(`${next.length} BYBIT MARKETS LIVE`);
      })
      .catch(() => {
        if (cancelled) return;
        setMarketStatus(`${fallback.length} CATALOG MARKETS · LIVE LIST UNAVAILABLE`);
      });
    return () => {
      cancelled = true;
    };
  }, [definition.marketType, definition.symbol]);

  const visibleSymbols = useMemo(() => {
    const query = symbolFilter.trim().toUpperCase();
    const rows = query
      ? symbols.filter((item) =>
          `${item.rawSymbol} ${item.baseAsset} ${item.quoteAsset}`.includes(query),
        )
      : symbols;
    const current = symbols.find((item) => item.rawSymbol === definition.symbol);
    if (current && !rows.some((item) => item.rawSymbol === current.rawSymbol)) {
      return [current, ...rows];
    }
    return rows;
  }, [definition.symbol, symbolFilter, symbols]);

  const patch = (value: Partial<StrategyAutomationDefinition>) =>
    onChange({ ...definition, ...value });
  const patchSetting = (key: keyof StrategySettings, value: number) =>
    patch({ settings: { ...definition.settings, [key]: value } });
  const patchExecution = (key: string, value: unknown) =>
    patch({ execution: { ...definition.execution, [key]: value } });

  const selectSymbol = (rawSymbol: string) => {
    const selected = symbols.find((item) => item.rawSymbol === rawSymbol);
    patch({
      symbol: rawSymbol,
      execution: {
        ...definition.execution,
        ...(selected?.metadata?.tickSize
          ? { tickSize: Number(selected.metadata.tickSize) }
          : {}),
      },
    });
  };

  const selectedEngine = certifiedStrategyEngines.find(
    (item) => item.value === definition.runtimeKind,
  );

  return (
    <section className={`strategy-definition-builder${locked ? " locked" : ""}`}>
      <header>
        <div>
          <SlidersHorizontal size={16} />
          <span>STRATEGY DEFINITION</span>
          <strong>INDICATOR, MARKET &amp; EXECUTION BUILDER</strong>
        </div>
        <div className="strategy-builder-state">
          {dirty ? <b className="dirty">UNSAVED SETTINGS</b> : <b>SAVED DEFINITION</b>}
          <span>PAPER-ONLY WORKER · LIVE EXECUTION LOCKED</span>
        </div>
      </header>

      {locked ? (
        <div className="strategy-builder-warning">
          <AlertTriangle size={14} /> Disconnect every live target before changing
          the strategy definition. Saving a new immutable version creates a fresh
          Paper Target and ten empty live slots.
        </div>
      ) : null}
      {issue ? (
        <div className="strategy-builder-warning">
          <AlertTriangle size={14} /> {issue}
        </div>
      ) : null}

      <fieldset disabled={locked}>
        <div className="strategy-builder-section">
          <div className="strategy-builder-section-head">
            <BarChart3 size={14} />
            <div><strong>SIGNAL ENGINE</strong><span>Only certified, closed-candle engines can be saved.</span></div>
          </div>
          <div className="strategy-engine-grid">
            {certifiedStrategyEngines.map((engine) => (
              <button
                key={engine.value}
                type="button"
                className={definition.runtimeKind === engine.value ? "active" : ""}
                onClick={() => patch({ runtimeKind: engine.value })}
              >
                <strong>{engine.label}</strong>
                <span>{engine.description}</span>
                <b>{definition.runtimeKind === engine.value ? "SELECTED" : "SELECT ENGINE"}</b>
              </button>
            ))}
          </div>
          <label className="strategy-builder-field unavailable">
            Adapter roadmap
            <select aria-label="Unavailable signal engines" value="" disabled>
              <option value="">ADDITIONAL ENGINES REQUIRE CERTIFICATION</option>
              {unavailableEngines.map((engine) => <option key={engine}>{engine}</option>)}
            </select>
          </label>
          {selectedEngine ? <p className="strategy-builder-engine-note">{selectedEngine.description}</p> : null}
        </div>

        <div className="strategy-builder-section">
          <div className="strategy-builder-section-head">
            <Database size={14} />
            <div><strong>MARKET SOURCE</strong><span>Authoritative Bybit mainnet public candles; execution remains paper-only.</span></div>
          </div>
          <div className="strategy-builder-market-grid">
            <label className="strategy-builder-field">
              Provider
              <input aria-label="Strategy provider" value="BYBIT MAINNET · CERTIFIED" readOnly />
            </label>
            <label className="strategy-builder-field">
              Market type
              <select
                aria-label="Strategy market type"
                value={definition.marketType}
                onChange={(event) => {
                  setSymbolFilter("");
                  patch({ marketType: event.target.value as StrategyAutomationDefinition["marketType"] });
                }}
              >
                <option value="FUTURES">USDT PERPETUAL FUTURES</option>
                <option value="SPOT">SPOT</option>
              </select>
            </label>
            <label className="strategy-builder-field">
              Timeframe
              <select
                aria-label="Strategy timeframe"
                value={definition.timeframe}
                onChange={(event) => patch({ timeframe: event.target.value })}
              >
                {automationTimeframes.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="strategy-builder-field strategy-symbol-filter">
              Find coin
              <span><Search size={12} /><input aria-label="Filter Bybit symbols" value={symbolFilter} placeholder="BTC, ETH, XMR…" onChange={(event) => setSymbolFilter(event.target.value)} /></span>
            </label>
            <label className="strategy-builder-field strategy-symbol-select">
              Coin / contract <em>{marketStatus}</em>
              <select
                aria-label="Strategy symbol"
                value={definition.symbol}
                onChange={(event) => selectSymbol(event.target.value)}
              >
                {visibleSymbols.map((item) => (
                  <option key={`${item.marketKind}:${item.rawSymbol}`} value={item.rawSymbol}>
                    {item.rawSymbol} · {item.baseAsset}/{item.quoteAsset || "USD"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="strategy-builder-section">
          <div className="strategy-builder-section-head">
            <Settings2 size={14} />
            <div><strong>INDICATOR PARAMETERS</strong><span>Every value is persisted in the immutable strategy definition.</span></div>
          </div>
          <div className="strategy-builder-parameter-grid">
            {(definition.runtimeKind === "builtin-adaptive-swing" ? adaptiveSettings : emaSettings).map((field) => (
              <NumberSetting key={field.key} field={field} settings={definition.settings} onChange={patchSetting} />
            ))}
          </div>
        </div>

        <div className="strategy-builder-section">
          <div className="strategy-builder-section-head">
            <ShieldCheck size={14} />
            <div><strong>EXITS &amp; SESSION</strong><span>Position-management rules consumed by backtest and paper runtime.</span></div>
          </div>
          <div className="strategy-builder-parameter-grid">
            {commonSettings.map((field) => (
              <NumberSetting key={field.key} field={field} settings={definition.settings} onChange={patchSetting} />
            ))}
          </div>
        </div>

        <div className="strategy-builder-section">
          <div className="strategy-builder-section-head">
            <SlidersHorizontal size={14} />
            <div><strong>EXECUTION &amp; RISK GUARDS</strong><span>Simulation assumptions and hard paper-runtime circuit breakers.</span></div>
          </div>
          <div className="strategy-builder-parameter-grid">
            {executionSettings
              .filter((field) => definition.marketType === "FUTURES" || !["maxLeverage", "fundingRatePerDay"].includes(field.key))
              .map((field) => (
                <NumberExecution key={field.key} field={field} execution={definition.execution} onChange={patchExecution} />
              ))}
            <ToggleExecution label="Bid / ask execution" field="useBidAskExecution" fallback={true} execution={definition.execution} onChange={patchExecution} />
            <ToggleExecution label="Disable on low liquidity" field="disableOnLowLiquidity" fallback={true} execution={definition.execution} onChange={patchExecution} />
            <ToggleExecution label="Disable on abnormal volatility" field="disableOnAbnormalVolatility" fallback={true} execution={definition.execution} onChange={patchExecution} />
          </div>
        </div>
      </fieldset>
    </section>
  );
}

function NumberSetting({
  field,
  settings,
  onChange,
}: {
  field: NumericSetting;
  settings: StrategySettings;
  onChange: (key: keyof StrategySettings, value: number) => void;
}) {
  const value = settings[field.key];
  return (
    <label className="strategy-builder-field">
      {field.label}
      <input
        aria-label={field.label}
        type="number"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={typeof value === "number" ? value : field.fallback}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(field.key, next);
        }}
      />
    </label>
  );
}

function NumberExecution({
  field,
  execution,
  onChange,
}: {
  field: NumericExecution;
  execution: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const value = execution[field.key];
  return (
    <label className="strategy-builder-field">
      {field.label}{field.suffix ? <em>{field.suffix}</em> : null}
      <input
        aria-label={field.label}
        type="number"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={typeof value === "number" ? value : field.fallback}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(field.key, next);
        }}
      />
    </label>
  );
}

function ToggleExecution({
  label,
  field,
  fallback,
  execution,
  onChange,
}: {
  label: string;
  field: string;
  fallback: boolean;
  execution: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const value = execution[field];
  return (
    <label className="strategy-builder-toggle">
      <span>{label}</span>
      <input
        aria-label={label}
        type="checkbox"
        checked={typeof value === "boolean" ? value : fallback}
        onChange={(event) => onChange(field, event.target.checked)}
      />
    </label>
  );
}
