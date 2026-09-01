import type { Candle } from "../../../chart-engine/types";
import {
  compileAndRunScript,
  type ScriptInputValue,
} from "../../../components/ScriptCompiler.ts";
import type {
  StrategyIntrabarSeries,
  StrategyRuntimeConfig,
} from "../../../components/ScriptStrategyEngine.ts";
import { buildDrawdownCurve, calculatePerformanceMetrics } from "../engine/metricsCalculator.ts";
import type {
  BacktestConfig,
  BacktestResult,
  ExitReason,
  TradeResult,
} from "../types/backtest.types.ts";

export type BlackScriptBacktestRequest = {
  source: string;
  candles: Candle[];
  config: BacktestConfig;
  inputValues?: Readonly<Record<string, ScriptInputValue>>;
  runtimeConfig?: Partial<StrategyRuntimeConfig>;
  intrabars?: StrategyIntrabarSeries;
};

function exitReason(value: string): ExitReason {
  if (/:STOP$/.test(value)) return "stopLoss";
  if (/:LIMIT$/.test(value)) return "takeProfit";
  if (/TRAIL/i.test(value)) return "trailingStop";
  return "signal";
}

/**
 * Run an owned Black Script strategy through the same deterministic engine
 * used by the Script Editor. This deliberately bypasses the legacy
 * signal-only backtester so partial exits, reversals and fill timing cannot be
 * reinterpreted by a second execution model.
 */
export function runBlackScriptBacktest(request: BlackScriptBacktestRequest): BacktestResult {
  const compiled = compileAndRunScript(
    request.source,
    request.candles,
    request.inputValues || {},
    { intrabars: request.intrabars, runtimeConfig: request.runtimeConfig },
  );
  if (!compiled.success) {
    const detail = compiled.errors.map((error) => `Line ${error.line}: ${error.message}`).join("\n");
    throw new Error(detail || "Black Script strategy compilation failed.");
  }
  if (!compiled.strategy) {
    throw new Error("The selected script is an indicator. A backtest requires at least one strategy order instruction.");
  }

  const report = compiled.strategy;
  const partialCounts = new Map<string, number>();
  const trades: TradeResult[] = report.trades.map((trade) => {
    const key = `${trade.entryId}:${trade.entryTime}:${trade.side}`;
    const partialExitCount = (partialCounts.get(key) || 0) + 1;
    partialCounts.set(key, partialExitCount);
    const notional = trade.entryPrice * trade.quantity;
    return {
      id: trade.id,
      symbol: request.config.symbol,
      direction: trade.side,
      entryTime: trade.entryTime,
      entryPrice: trade.entryPrice,
      exitTime: trade.exitTime,
      exitPrice: trade.exitPrice,
      quantity: trade.quantity,
      notional,
      fees: trade.commission,
      slippage: Math.max(0, request.runtimeConfig?.slippageTicks ?? report.config.slippageTicks)
        * Math.max(1e-12, request.runtimeConfig?.tickSize ?? report.config.tickSize)
        * 2,
      fundingCost: 0,
      pnl: trade.netPnl,
      pnlPercent: notional > 0 ? trade.netPnl / notional : 0,
      rMultiple: 0,
      exitReason: exitReason(trade.exitReason),
      durationSeconds: Math.max(0, trade.exitTime - trade.entryTime),
      signalName: trade.exitReason,
      partialExitCount,
    };
  });
  const equityCurve = report.times.flatMap((time, index) => {
    const equity = report.equityCurve[index];
    if (equity === null || !Number.isFinite(equity)) return [];
    return [{
      time,
      equity,
      realizedPnl: report.netProfit[index] ?? 0,
    }];
  });
  const warnings: string[] = [];
  if (request.candles.length < 100) warnings.push("Not enough historical candles for a reliable strategy backtest.");
  if (request.config.useBidAskExecution && request.config.spreadBps > 0) {
    warnings.push("Black Script parity mode applies script commission and slippage but does not add a synthetic bid/ask spread.");
  }
  if ((request.config.fundingRatePerDay || 0) !== 0) {
    warnings.push("Funding is not included in Black Script parity results yet.");
  }
  if (report.openPosition) {
    warnings.push(`The backtest ends with an open ${report.openPosition.side} position; it is marked to market and is not force-closed.`);
  }

  return {
    trades,
    equityCurve,
    drawdownCurve: buildDrawdownCurve(equityCurve),
    metrics: calculatePerformanceMetrics(trades, equityCurve, report.initialCapital),
    settings: {
      runtimeVersion: compiled.runtimeVersion,
      sourceHash: compiled.sourceHash,
      inputs: { ...(request.inputValues || {}) },
      runtime: report.config,
    },
    warnings,
    candlesTested: request.candles.length,
  };
}

/** Backward-compatible adapter name retained for older Strategy Lab imports. */
export async function runPythonStrategyAdapter(request: BlackScriptBacktestRequest) {
  return runBlackScriptBacktest(request);
}
