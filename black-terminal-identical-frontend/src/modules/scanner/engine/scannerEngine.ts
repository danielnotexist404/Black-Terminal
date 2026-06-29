import type { Candle } from "../../../chart-engine/types";
import type { MarketSymbol, Timeframe } from "../../../market-data/types";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type {
  ScanConfig,
  ScannerDataAdapter,
  ScannerProgress,
  ScannerResult,
  ScannerRunOptions,
  ScannerRunOutput
} from "../types/scanner.types";
import { requiredCandleHistory } from "./lookback";
import { evaluateConditionGroup, validateScanConfig } from "./ruleEvaluator";
import { calculateScannerScore, relativeVolume } from "./scoreCalculator";

function resultId(symbol: MarketSymbol, timeframe: Timeframe) {
  return `${symbol.exchange}:${symbol.rawSymbol}:${timeframe}`;
}

function displayName(symbol: MarketSymbol) {
  return `${symbol.baseAsset}${symbol.quoteAsset}`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export class ScannerEngine {
  private dataAdapter: ScannerDataAdapter;

  constructor(dataAdapter: ScannerDataAdapter) {
    this.dataAdapter = dataAdapter;
  }

  async runScan(config: ScanConfig, symbols: MarketSymbol[], options: ScannerRunOptions = {}): Promise<ScannerRunOutput> {
    const validation = validateScanConfig(config);
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    const startedAt = Date.now();
    const tasks = expandTasks(symbols, config.timeframes);
    const limit = requiredCandleHistory(config);
    const results: ScannerResult[] = [];
    const errors: ScannerResult[] = [];
    let completed = 0;
    let cancelled = false;
    const concurrency = Math.max(1, Math.min(12, options.concurrency ?? 4));
    let cursor = 0;

    const progress = (current?: string): ScannerProgress => ({
      completed,
      total: tasks.length,
      current,
      errors: errors.length
    });

    const worker = async () => {
      while (cursor < tasks.length) {
        if (options.signal?.aborted) {
          cancelled = true;
          return;
        }

        const task = tasks[cursor++];
        if (!task) continue;
        const { symbol, timeframe } = task;
        options.onProgress?.(progress(`${displayName(symbol)} ${timeframe}`));

        try {
          const candles = await this.dataAdapter.fetchCandles(symbol, timeframe, limit, options.signal);
          if (candles.length < Math.min(50, limit)) {
            throw new Error(`Insufficient candle history: received ${candles.length}, needed at least ${Math.min(50, limit)}.`);
          }

          const result = evaluateSymbol(config, symbol, timeframe, candles);
          if (result.status === "match" || options.includeNonMatches) results.push(result);
        } catch (error) {
          if (isAbortError(error) || options.signal?.aborted) {
            cancelled = true;
            return;
          }
          errors.push(errorResult(symbol, timeframe, error));
        } finally {
          completed += 1;
          options.onProgress?.(progress());
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

    const sorted = sortResults(results, config).slice(0, config.maxResults);
    return {
      configId: config.id,
      startedAt,
      completedAt: Date.now(),
      results: sorted,
      errors,
      scanned: completed,
      cancelled
    };
  }
}

export function resolveUniverseSymbols(config: ScanConfig, currentWatchlist: MarketSymbol[] = []) {
  const allSymbols = marketCatalog
    .filter((exchange) => exchange.status === "REST LIVE")
    .flatMap((exchange) => exchange.symbols);

  if (config.universe.type === "current-watchlist") return currentWatchlist.length ? currentWatchlist : allSymbols.slice(0, 12);
  if (config.universe.type === "exchange") {
    const exchanges = config.universe.exchangeIds?.length ? config.universe.exchangeIds : marketCatalog.filter((exchange) => exchange.status === "REST LIVE").map((exchange) => exchange.id);
    return allSymbols.filter((symbol) => exchanges.includes(symbol.exchange));
  }
  if (config.universe.type === "manual") {
    const wanted = new Set([...(config.universe.symbols ?? []), ...(config.symbols ?? [])].map((item) => normalizeSymbolToken(item)));
    return allSymbols.filter((symbol) => wanted.has(normalizeSymbolToken(symbol.rawSymbol)) || wanted.has(normalizeSymbolToken(displayName(symbol))) || wanted.has(normalizeSymbolToken(symbol.baseAsset)));
  }
  return allSymbols;
}

export function evaluateSymbol(config: ScanConfig, symbol: MarketSymbol, timeframe: Timeframe, candles: Candle[]): ScannerResult {
  const index = candles.length - 1;
  const last = candles[index];
  const previous = candles[index - 1];
  if (!last || !previous) throw new Error("Missing latest candle.");

  const indicatorCache = new Map<string, number[]>();
  const evaluation = evaluateConditionGroup(config.conditions, {
    candles,
    index,
    symbol,
    timeframe,
    indicatorCache
  });

  const changePercent = previous.close ? ((last.close - previous.close) / Math.abs(previous.close)) * 100 : 0;
  const relVolume = relativeVolume(candles);
  const score = calculateScannerScore(candles, config.scoring);

  return {
    id: resultId(symbol, timeframe),
    status: evaluation.matched ? "match" : "no-match",
    symbol: displayName(symbol),
    displayName: displayName(symbol),
    rawSymbol: symbol.rawSymbol,
    exchange: symbol.exchange,
    marketKind: symbol.marketKind,
    timeframe,
    lastPrice: last.close,
    changePercent,
    volume: last.volume,
    relativeVolume: relVolume,
    matchedConditions: evaluation.matchedConditions,
    score,
    updatedAt: Date.now(),
    error: evaluation.matched ? undefined : "Ranked candidate"
  };
}

export function sortResults(results: ScannerResult[], config: ScanConfig) {
  const direction = config.sortDirection === "asc" ? 1 : -1;
  return [...results].sort((a, b) => {
    if (config.sortBy === "symbol") return a.symbol.localeCompare(b.symbol) * direction;
    const left = sortableValue(a, config.sortBy);
    const right = sortableValue(b, config.sortBy);
    return (left - right) * direction;
  });
}

function sortableValue(result: ScannerResult, field: ScanConfig["sortBy"]) {
  if (field === "score") return result.score;
  if (field === "volume") return result.volume ?? 0;
  if (field === "changePercent") return result.changePercent ?? 0;
  if (field === "relativeVolume") return result.relativeVolume ?? 0;
  if (field === "lastPrice") return result.lastPrice ?? 0;
  if (field === "updatedAt") return result.updatedAt;
  return 0;
}

function expandTasks(symbols: MarketSymbol[], timeframes: Timeframe[]) {
  return symbols.flatMap((symbol) => timeframes.map((timeframe) => ({ symbol, timeframe })));
}

function errorResult(symbol: MarketSymbol, timeframe: Timeframe, error: unknown): ScannerResult {
  return {
    id: resultId(symbol, timeframe),
    status: "error",
    symbol: displayName(symbol),
    displayName: displayName(symbol),
    rawSymbol: symbol.rawSymbol,
    exchange: symbol.exchange,
    marketKind: symbol.marketKind,
    timeframe,
    lastPrice: null,
    changePercent: null,
    volume: null,
    relativeVolume: null,
    matchedConditions: [],
    score: 0,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error)
  };
}

function normalizeSymbolToken(symbol: string) {
  return symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
}
