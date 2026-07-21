import type { Candle } from "../../../chart-engine/types";
import type { StrategyScriptDefinition, StrategySignal } from "../types/strategy.types";

export async function runPythonStrategyAdapter(
  _script: StrategyScriptDefinition,
  _candles: Candle[],
  _symbol: string
): Promise<StrategySignal[]> {
  // TODO: connect this to the existing Python runtime once strategy scripts expose normalized signals.
  throw new Error("Python strategy backtesting is not wired yet. Use the built-in EMA Cross model for this phase.");
}
