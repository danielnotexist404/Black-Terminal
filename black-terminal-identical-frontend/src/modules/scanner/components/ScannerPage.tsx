import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Copy, Download, Play, Save, Search, Square, Trash2, X } from "lucide-react";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { ExchangeOption } from "../../../market-data/marketCatalog";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import { PublicMarketScannerDataAdapter } from "../data/marketScannerDataAdapter";
import { getBuiltInPresets } from "../engine/presets";
import { ScannerEngine, resolveUniverseSymbols } from "../engine/scannerEngine";
import { validateScanConfig } from "../engine/ruleEvaluator";
import { deleteScanPreset, duplicateScanPreset, exportResultsCsv, getAllScannerPresets, saveScanPreset } from "../state/scannerStorage";
import type {
  IndicatorName,
  ScanConfig,
  ScannerOperand,
  ScannerProgress,
  ScannerResult,
  ScannerRule,
  ScannerSortBy,
  ScannerSortDirection,
  ScannerUniverseType
} from "../types/scanner.types";

type ScannerPageProps = {
  currentSymbol: MarketSymbol;
  selectedExchange: ExchangeOption;
  timeframe: Timeframe;
  onClose: () => void;
  onOpenChart: (symbol: MarketSymbol, timeframe: Timeframe) => void;
  onCreateAlert: (result: ScannerResult) => void;
};

const supportedTimeframes: { value: Timeframe; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" }
];

const indicatorChoices: { label: string; operand: ScannerOperand }[] = [
  { label: "Close", operand: { type: "price", field: "close" } },
  { label: "Volume", operand: { type: "price", field: "volume" } },
  { label: "Range", operand: { type: "price", field: "range" } },
  { label: "EMA", operand: { type: "indicator", name: "EMA", params: { period: 50 } } },
  { label: "RSI", operand: { type: "indicator", name: "RSI", params: { period: 14 } } },
  { label: "ATR", operand: { type: "indicator", name: "ATR", params: { period: 14 } } },
  { label: "Volume SMA", operand: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } } },
  { label: "Highest High", operand: { type: "indicator", name: "HIGHEST_HIGH", params: { period: 20, includeCurrent: false } } },
  { label: "Lowest Low", operand: { type: "indicator", name: "LOWEST_LOW", params: { period: 20, includeCurrent: false } } },
  { label: "ROC", operand: { type: "indicator", name: "ROC", params: { period: 20 } } }
];

const operatorOptions = [">", ">=", "<", "<=", "crosses_above", "crosses_below", "between", "rising", "falling", "percent_above", "percent_below", "near"] as const;

function cloneConfig(config: ScanConfig): ScanConfig {
  return structuredClone(config);
}

function makeRule(): ScannerRule {
  return {
    id: `rule-${Date.now()}`,
    label: "Close above EMA",
    left: { type: "price", field: "close" },
    operator: ">",
    right: { type: "indicator", name: "EMA", params: { period: 50 } },
    enabled: true
  };
}

function operandKey(operand: ScannerOperand) {
  if (operand.type === "price") return operand.field === "close" ? "Close" : operand.field === "volume" ? "Volume" : "Range";
  if (operand.type === "indicator") {
    const found = indicatorChoices.find((choice) => choice.operand.type === "indicator" && choice.operand.name === operand.name);
    return found?.label ?? operand.name;
  }
  if (operand.type === "constant") return "Constant";
  if (operand.type === "previous") return "Previous Close";
  return "Close";
}

function operandPeriod(operand: ScannerOperand) {
  if (operand.type === "indicator") return Number(operand.params?.period ?? operand.params?.length ?? 14);
  if (operand.type === "averageVolume") return operand.period;
  if (operand.type === "highestHigh" || operand.type === "lowestLow" || operand.type === "percentChange" || operand.type === "relativeStrength") return operand.lookback;
  return 0;
}

function withOperandPeriod(operand: ScannerOperand, period: number): ScannerOperand {
  if (operand.type === "indicator") return { ...operand, params: { ...operand.params, period } };
  if (operand.type === "averageVolume") return { ...operand, period };
  if (operand.type === "highestHigh" || operand.type === "lowestLow" || operand.type === "percentChange" || operand.type === "relativeStrength") return { ...operand, lookback: period };
  return operand;
}

function findSymbol(result: ScannerResult) {
  return marketCatalog.flatMap((exchange) => exchange.symbols).find((symbol) => symbol.exchange === result.exchange && symbol.rawSymbol === result.rawSymbol);
}

export function ScannerPage({ currentSymbol, selectedExchange, timeframe, onClose, onOpenChart, onCreateAlert }: ScannerPageProps) {
  const [presets, setPresets] = useState(() => getAllScannerPresets());
  const [config, setConfig] = useState<ScanConfig>(() => {
    const preset = getBuiltInPresets()[0]!;
    return { ...cloneConfig(preset), timeframes: [timeframe], universe: { type: "exchange", exchangeIds: [selectedExchange.id] } };
  });
  const [results, setResults] = useState<ScannerResult[]>([]);
  const [errors, setErrors] = useState<ScannerResult[]>([]);
  const [progress, setProgress] = useState<ScannerProgress>({ completed: 0, total: 0, errors: 0 });
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string>();
  const [includeRankedCandidates, setIncludeRankedCandidates] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const engine = useMemo(() => new ScannerEngine(new PublicMarketScannerDataAdapter()), []);
  const validation = useMemo(() => validateScanConfig(config), [config]);
  const universeSymbols = useMemo(() => resolveUniverseSymbols(config, selectedExchange.symbols), [config, selectedExchange.symbols]);
  const filteredResults = useMemo(() => {
    let list = results;
    if (!includeRankedCandidates) {
      list = list.filter((r) => r.status === "match");
    }
    const query = search.trim().toLowerCase();
    if (!query) return list;
    return list.filter((result) => [result.symbol, result.exchange, result.timeframe, result.error, result.matchedConditions.map((item) => item.label).join(" ")].join(" ").toLowerCase().includes(query));
  }, [results, search, includeRankedCandidates]);

  const updateConfig = (patch: Partial<ScanConfig>) => setConfig((current) => ({ ...current, ...patch, updatedAt: Date.now() }));

  const runScan = async () => {
    if (!validation.valid) {
      setMessage(validation.errors[0]);
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setMessage(undefined);
    setProgress({ completed: 0, total: universeSymbols.length * config.timeframes.length, errors: 0 });
    try {
      const output = await engine.runScan(config, universeSymbols, {
        signal: abort.signal,
        concurrency: 4,
        includeNonMatches: includeRankedCandidates,
        onProgress: setProgress
      });
      setResults(output.results);
      setErrors(output.errors);
      const matches = output.results.filter((result) => result.status === "match").length;
      setMessage(output.cancelled ? "Scan stopped." : `${matches} strict matches, ${output.results.length} ranked rows from ${output.scanned} symbol/timeframe checks.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stopScan = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  useEffect(() => {
    if (config.refreshMode !== "interval") return undefined;
    const intervalMs = Math.max(10, config.refreshIntervalSeconds) * 1000;
    const timer = window.setInterval(() => {
      if (!running && validation.valid) void runScan();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [config.refreshMode, config.refreshIntervalSeconds, running, validation.valid, universeSymbols.length]);

  const selectPreset = (id: string) => {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    setConfig(cloneConfig(preset));
    setResults([]);
    setErrors([]);
    setMessage(undefined);
  };

  const savePreset = () => {
    const saved = saveScanPreset(config);
    setConfig(saved);
    setPresets(getAllScannerPresets());
    setMessage("Scanner preset saved.");
  };

  const duplicatePreset = () => {
    const saved = duplicateScanPreset(config);
    setConfig(saved);
    setPresets(getAllScannerPresets());
    setMessage("Preset duplicated.");
  };

  const deletePreset = () => {
    if (config.readOnly) return;
    deleteScanPreset(config.id);
    const next = getAllScannerPresets();
    setPresets(next);
    setConfig(cloneConfig(next[0]!));
    setMessage("Preset deleted.");
  };

  const exportCsv = () => {
    const csv = exportResultsCsv(filteredResults);
    void navigator.clipboard?.writeText(csv);
    setMessage("CSV copied to clipboard.");
  };

  const updateRule = (ruleId: string, patch: Partial<ScannerRule>) => {
    setConfig((current) => ({
      ...current,
      conditions: {
        ...current.conditions,
        rules: current.conditions.rules.map((item) => ("rules" in item || item.id !== ruleId ? item : { ...item, ...patch }))
      }
    }));
  };

  const removeRule = (ruleId: string) => {
    setConfig((current) => ({
      ...current,
      conditions: { ...current.conditions, rules: current.conditions.rules.filter((item) => "rules" in item || item.id !== ruleId) }
    }));
  };

  const setTimeframeEnabled = (value: Timeframe, enabled: boolean) => {
    updateConfig({
      timeframes: enabled
        ? [...new Set([...config.timeframes, value])]
        : config.timeframes.filter((item) => item !== value)
    });
  };

  return (
    <div className="scanner-workspace">
      <div className="scanner-head">
        <div>
          <strong>MARKET SCANNER</strong>
          <span>{universeSymbols.length} SYMBOLS / {config.timeframes.length} TF / {running ? "RUNNING" : "READY"}</span>
        </div>
        <button type="button" aria-label="Close Scanner" onClick={onClose}><X size={18} /></button>
      </div>

      <div className="scanner-body">
        <aside className="scanner-sidebar-panel">
          <div className="scanner-section">
            <div className="scanner-section-head">Preset</div>
            <select value={config.id} onChange={(event) => selectPreset(event.target.value)}>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
            <input value={config.name} onChange={(event) => updateConfig({ name: event.target.value, readOnly: false })} />
            <div className="scanner-button-row">
              <button type="button" onClick={duplicatePreset}><Copy size={13} /> Duplicate</button>
              <button type="button" onClick={savePreset}><Save size={13} /> Save</button>
              <button type="button" disabled={config.readOnly} onClick={deletePreset}><Trash2 size={13} /> Delete</button>
            </div>
          </div>

          <div className="scanner-section">
            <div className="scanner-section-head">Universe</div>
            <select value={config.universe.type} onChange={(event) => updateConfig({ universe: { ...config.universe, type: event.target.value as ScannerUniverseType } })}>
              <option value="current-watchlist">Current Watchlist</option>
              <option value="all-symbols">All REST Symbols</option>
              <option value="exchange">Selected Exchange</option>
              <option value="manual">Manual Symbols</option>
            </select>
            {config.universe.type === "exchange" && (
              <select
                value={config.universe.exchangeIds?.[0] ?? selectedExchange.id}
                onChange={(event) => updateConfig({ universe: { ...config.universe, exchangeIds: [event.target.value as typeof selectedExchange.id] } })}
              >
                {marketCatalog.filter((exchange) => exchange.status === "REST LIVE").map((exchange) => (
                  <option key={exchange.id} value={exchange.id}>{exchange.label}</option>
                ))}
              </select>
            )}
            {config.universe.type === "manual" && (
              <textarea
                rows={3}
                placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
                value={(config.universe.symbols ?? []).join(", ")}
                onChange={(event) => updateConfig({ universe: { ...config.universe, symbols: event.target.value.split(/[,\s]+/).filter(Boolean) } })}
              />
            )}
          </div>

          <div className="scanner-section">
            <div className="scanner-section-head">Timeframes</div>
            <div className="scanner-timeframes">
              {supportedTimeframes.map((item) => (
                <label key={item.value}>
                  <input type="checkbox" checked={config.timeframes.includes(item.value)} onChange={(event) => setTimeframeEnabled(item.value, event.target.checked)} />
                  {item.label}
                </label>
              ))}
            </div>
          </div>

          <div className="scanner-section">
            <div className="scanner-section-head">Refresh</div>
            <select value={config.refreshMode} onChange={(event) => updateConfig({ refreshMode: event.target.value as ScanConfig["refreshMode"] })}>
              <option value="manual">Manual</option>
              <option value="interval">Interval</option>
              <option value="realtime">Realtime Hook</option>
            </select>
            <label>
              Interval
              <input type="number" min={10} value={config.refreshIntervalSeconds} onChange={(event) => updateConfig({ refreshIntervalSeconds: Number(event.target.value) })} />
            </label>
            <label>
              Max Results
              <input type="number" min={1} max={500} value={config.maxResults} onChange={(event) => updateConfig({ maxResults: Number(event.target.value) })} />
            </label>
          </div>
        </aside>

        <section className="scanner-main-panel">
          <div className="scanner-controls">
            <button type="button" className="scanner-primary" disabled={running || !validation.valid} onClick={runScan}><Play size={14} /> Run Scan</button>
            <button type="button" disabled={!running} onClick={stopScan}><Square size={13} /> Stop</button>
            <label className="scanner-search"><Search size={13} /><input value={search} placeholder="Filter results" onChange={(event) => setSearch(event.target.value)} /></label>
            <label className="scanner-ranked-toggle">
              <input type="checkbox" checked={includeRankedCandidates} onChange={(event) => setIncludeRankedCandidates(event.target.checked)} />
              Ranked universe
            </label>
            <select value={config.sortBy} onChange={(event) => updateConfig({ sortBy: event.target.value as ScannerSortBy })}>
              <option value="score">Score</option>
              <option value="volume">Volume</option>
              <option value="changePercent">Change %</option>
              <option value="relativeVolume">Relative Volume</option>
              <option value="symbol">Symbol</option>
            </select>
            <select value={config.sortDirection} onChange={(event) => updateConfig({ sortDirection: event.target.value as ScannerSortDirection })}>
              <option value="desc">Desc</option>
              <option value="asc">Asc</option>
            </select>
            <button type="button" onClick={exportCsv}><Download size={13} /> CSV</button>
            <span>{progress.completed}/{progress.total} scanned</span>
            <b>{errors.length} errors</b>
          </div>

          <div className="scanner-grid">
            <div className="scanner-rules">
              <div className="scanner-panel-head">
                <span>Rule Builder</span>
                <button type="button" onClick={() => setConfig((current) => ({ ...current, conditions: { ...current.conditions, rules: [...current.conditions.rules, makeRule()] } }))}>Add Rule</button>
              </div>
              {config.conditions.rules.map((item) => {
                if ("rules" in item) return null;
                const leftPeriod = operandPeriod(item.left);
                const rightPeriod = item.right ? operandPeriod(item.right) : 0;
                return (
                  <div className="scanner-rule-row" key={item.id}>
                    <input value={item.label} onChange={(event) => updateRule(item.id, { label: event.target.value })} />
                    <select
                      value={operandKey(item.left)}
                      onChange={(event) => updateRule(item.id, { left: cloneOperand(event.target.value) })}
                    >
                      {indicatorChoices.map((choice) => <option key={choice.label}>{choice.label}</option>)}
                    </select>
                    {leftPeriod > 0 && <input type="number" min={1} value={leftPeriod} onChange={(event) => updateRule(item.id, { left: withOperandPeriod(item.left, Number(event.target.value)) })} />}
                    <select value={item.operator} onChange={(event) => updateRule(item.id, { operator: event.target.value as ScannerRule["operator"] })}>
                      {operatorOptions.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                    </select>
                    {item.operator !== "rising" && item.operator !== "falling" && (
                      <select
                        value={item.right?.type === "constant" ? "Constant" : item.right ? operandKey(item.right) : "Constant"}
                        onChange={(event) => updateRule(item.id, { right: event.target.value === "Constant" ? { type: "constant", value: 0 } : cloneOperand(event.target.value) })}
                      >
                        <option>Constant</option>
                        {indicatorChoices.map((choice) => <option key={choice.label}>{choice.label}</option>)}
                      </select>
                    )}
                    {item.right?.type === "constant" ? (
                      <input type="number" value={item.right.value} onChange={(event) => updateRule(item.id, { right: { type: "constant", value: Number(event.target.value) } })} />
                    ) : rightPeriod > 0 ? (
                      <input type="number" min={1} value={rightPeriod} onChange={(event) => item.right && updateRule(item.id, { right: withOperandPeriod(item.right, Number(event.target.value)) })} />
                    ) : null}
                    {(item.operator === "percent_above" || item.operator === "percent_below" || item.operator === "near") && (
                      <input type="number" value={item.tolerance ?? 1} onChange={(event) => updateRule(item.id, { tolerance: Number(event.target.value) })} />
                    )}
                    <button type="button" onClick={() => removeRule(item.id)}><Trash2 size={13} /></button>
                  </div>
                );
              })}
              {[...validation.errors, ...validation.warnings, ...(config.notes ?? [])].map((item) => <div className="scanner-note" key={item}>{item}</div>)}
            </div>

            <div className="scanner-results">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Exchange</th>
                    <th>TF</th>
                    <th>Last</th>
                    <th>Chg %</th>
                    <th>Volume</th>
                    <th>Rel Vol</th>
                    <th>Score</th>
                    <th>Matched Rules</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((result) => (
                    <tr key={result.id} className={result.status === "match" ? "scanner-match-row" : "scanner-ranked-row"}>
                      <td>{result.symbol}</td>
                      <td>{result.exchange}</td>
                      <td>{result.timeframe}</td>
                      <td>{formatNumber(result.lastPrice)}</td>
                      <td className={(result.changePercent ?? 0) >= 0 ? "green" : "red"}>{formatNumber(result.changePercent, 2)}%</td>
                      <td>{formatCompact(result.volume)}</td>
                      <td>{formatNumber(result.relativeVolume, 2)}x</td>
                      <td><b>{formatNumber(result.score, 1)}</b></td>
                      <td>{result.matchedConditions.map((item) => item.label).join(", ") || (result.status === "no-match" ? "ranked candidate" : result.error)}</td>
                      <td>{new Date(result.updatedAt).toLocaleTimeString()}</td>
                      <td>
                        <button type="button" onClick={() => { const match = findSymbol(result); if (match) onOpenChart(match, result.timeframe); }}>Open</button>
                        <button type="button" onClick={() => onCreateAlert(result)}><Bell size={12} /></button>
                      </td>
                    </tr>
                  ))}
                  {filteredResults.length === 0 && (
                    <tr><td colSpan={11}>{running ? "Scanning markets..." : "No scanner results yet."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {message ? <div className="scanner-status-line">{message}</div> : null}
        </section>
      </div>
    </div>
  );
}

function cloneOperand(label: string): ScannerOperand {
  return structuredClone(indicatorChoices.find((choice) => choice.label === label)?.operand ?? { type: "price", field: "close" });
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (!Number.isFinite(value ?? NaN)) return "-";
  return value!.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatCompact(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) return "-";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value!);
}
