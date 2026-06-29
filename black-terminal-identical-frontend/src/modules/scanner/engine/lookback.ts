import type { ScanConfig, ScannerConditionGroup, ScannerOperand, ScannerRule } from "../types/scanner.types";

export function requiredCandleHistory(config: ScanConfig) {
  const lookback = Math.max(260, maxGroupLookback(config.conditions) + 80);
  return Math.min(1000, lookback);
}

function maxGroupLookback(group: ScannerConditionGroup): number {
  return group.rules.reduce((max, item) => {
    if ("rules" in item) return Math.max(max, maxGroupLookback(item));
    return Math.max(max, maxRuleLookback(item));
  }, 0);
}

function maxRuleLookback(rule: ScannerRule) {
  return Math.max(
    operandLookback(rule.left),
    rule.right ? operandLookback(rule.right) : 0,
    rule.right2 ? operandLookback(rule.right2) : 0,
    rule.operator === "crosses_above" || rule.operator === "crosses_below" || rule.operator === "rising" || rule.operator === "falling" ? 2 : 0
  );
}

function operandLookback(operand: ScannerOperand): number {
  if (operand.type === "indicator") {
    const period = Number(operand.params?.period ?? operand.params?.length ?? operand.params?.slow ?? 14);
    if (operand.name === "MACD") return Math.max(35, Number(operand.params?.slow ?? 26) + Number(operand.params?.signal ?? 9));
    if (operand.name === "ATR_SMA") return Number(operand.params?.atrPeriod ?? 14) + period;
    return period;
  }
  if (operand.type === "averageVolume") return operand.period;
  if (operand.type === "highestHigh" || operand.type === "lowestLow" || operand.type === "percentChange" || operand.type === "relativeStrength") return operand.lookback + 1;
  return 2;
}
