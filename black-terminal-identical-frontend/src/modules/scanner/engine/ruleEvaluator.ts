import { resolveOperand } from "./indicatorAdapter";
import type {
  RuleEvaluationContext,
  RuleEvaluationResult,
  ScannerConditionGroup,
  ScannerMatchedCondition,
  ScannerOperator,
  ScannerRule,
  ScanValidationResult,
  ScanConfig,
  ScannerOperand
} from "../types/scanner.types";

const supportedOperators: ScannerOperator[] = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
  "crosses_above",
  "crosses_below",
  "between",
  "not_between",
  "rising",
  "falling",
  "near",
  "percent_above",
  "percent_below"
];

export function evaluateConditionGroup(group: ScannerConditionGroup, ctx: RuleEvaluationContext): RuleEvaluationResult {
  const activeRules = group.rules.filter((rule) => ("enabled" in rule ? rule.enabled !== false : true));
  const matchedConditions: ScannerMatchedCondition[] = [];
  const warnings: string[] = [];

  if (activeRules.length === 0) {
    return { matched: false, matchedConditions, warnings: ["No active scanner rules."] };
  }

  const outcomes = activeRules.map((item) => {
    if ("rules" in item) {
      const result = evaluateConditionGroup(item, ctx);
      matchedConditions.push(...result.matchedConditions);
      warnings.push(...result.warnings);
      return result.matched;
    }

    const result = evaluateRule(item, ctx);
    if (result.warning) warnings.push(result.warning);
    if (result.matched && result.matchedCondition) matchedConditions.push(result.matchedCondition);
    return result.matched;
  });

  const matched = group.type === "OR" ? outcomes.some(Boolean) : outcomes.every(Boolean);
  return { matched, matchedConditions: matched ? matchedConditions : [], warnings };
}

export function evaluateRule(rule: ScannerRule, ctx: RuleEvaluationContext) {
  const left = resolveOperand(ctx, rule.left);
  const right = rule.right ? resolveOperand(ctx, rule.right) : undefined;
  const right2 = rule.right2 ? resolveOperand(ctx, rule.right2) : undefined;
  const previousLeft = resolveOperand(ctx, rule.left, ctx.index - 1);
  const previousRight = rule.right ? resolveOperand(ctx, rule.right, ctx.index - 1) : undefined;
  let matched = false;

  if (left === null || Number.isNaN(left)) {
    return { matched: false, warning: `${rule.label}: left operand unavailable.` };
  }

  switch (rule.operator) {
    case ">":
      matched = right !== undefined && right !== null && left > right;
      break;
    case ">=":
      matched = right !== undefined && right !== null && left >= right;
      break;
    case "<":
      matched = right !== undefined && right !== null && left < right;
      break;
    case "<=":
      matched = right !== undefined && right !== null && left <= right;
      break;
    case "==":
      matched = right !== undefined && right !== null && Math.abs(left - right) < 1e-8;
      break;
    case "!=":
      matched = right !== undefined && right !== null && Math.abs(left - right) >= 1e-8;
      break;
    case "crosses_above":
      matched = previousLeft !== null && previousRight !== undefined && previousRight !== null && right !== undefined && right !== null && previousLeft <= previousRight && left > right;
      break;
    case "crosses_below":
      matched = previousLeft !== null && previousRight !== undefined && previousRight !== null && right !== undefined && right !== null && previousLeft >= previousRight && left < right;
      break;
    case "between":
      matched = right !== undefined && right !== null && right2 !== undefined && right2 !== null && left >= Math.min(right, right2) && left <= Math.max(right, right2);
      break;
    case "not_between":
      matched = right !== undefined && right !== null && right2 !== undefined && right2 !== null && (left < Math.min(right, right2) || left > Math.max(right, right2));
      break;
    case "rising":
      matched = previousLeft !== null && left > previousLeft;
      break;
    case "falling":
      matched = previousLeft !== null && left < previousLeft;
      break;
    case "near": {
      const tolerance = Math.max(0, rule.tolerance ?? 0.5);
      matched = right !== undefined && right !== null && Math.abs(left - right) <= Math.abs(right) * (tolerance / 100);
      break;
    }
    case "percent_above": {
      const percent = Math.max(0, rule.tolerance ?? 1);
      matched = right !== undefined && right !== null && left >= right * (1 + percent / 100);
      break;
    }
    case "percent_below": {
      const percent = Math.max(0, rule.tolerance ?? 1);
      matched = right !== undefined && right !== null && left <= right * (1 - percent / 100);
      break;
    }
    default:
      matched = false;
  }

  return {
    matched,
    matchedCondition: matched
      ? {
          ruleId: rule.id,
          label: rule.label,
          operator: rule.operator,
          leftValue: left,
          rightValue: right ?? null,
          right2Value: right2 ?? null
        }
      : undefined
  };
}

export function validateScanConfig(config: ScanConfig): ScanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.name.trim()) errors.push("Scan name is required.");
  if (!config.timeframes.length) errors.push("Select at least one timeframe.");
  if (config.maxResults <= 0) errors.push("Max results must be greater than zero.");
  if (!config.conditions.rules.length) errors.push("Add at least one scanner condition.");
  if (config.universe.type === "manual" && !(config.universe.symbols?.length || config.symbols?.length)) {
    errors.push("Manual scanner universe requires at least one symbol.");
  }
  if (config.refreshMode !== "manual" && config.refreshIntervalSeconds < 10) {
    warnings.push("Refresh interval below 10 seconds can hit exchange rate limits.");
  }

  validateGroup(config.conditions, errors, warnings);
  return { valid: errors.length === 0, errors, warnings };
}

function validateGroup(group: ScannerConditionGroup, errors: string[], warnings: string[]) {
  if (group.type !== "AND" && group.type !== "OR") errors.push(`Invalid condition group ${group.id}.`);
  for (const item of group.rules) {
    if ("rules" in item) {
      validateGroup(item, errors, warnings);
      continue;
    }
    validateRule(item, errors, warnings);
  }
}

function validateRule(rule: ScannerRule, errors: string[], warnings: string[]) {
  if (!supportedOperators.includes(rule.operator)) errors.push(`${rule.label}: unsupported operator ${rule.operator}.`);
  if (!rule.left) errors.push(`${rule.label}: left operand is required.`);
  if (requiresRight(rule.operator) && !rule.right) errors.push(`${rule.label}: right operand is required.`);
  if ((rule.operator === "between" || rule.operator === "not_between") && !rule.right2) errors.push(`${rule.label}: second right operand is required.`);
  validateOperand(rule.left, `${rule.label} left`, errors);
  if (rule.right) validateOperand(rule.right, `${rule.label} right`, errors);
  if (rule.right2) validateOperand(rule.right2, `${rule.label} second right`, errors);
  if (rule.enabled === false) warnings.push(`${rule.label}: rule is disabled.`);
}

function requiresRight(operator: ScannerOperator) {
  return !["rising", "falling"].includes(operator);
}

function validateOperand(operand: ScannerOperand, label: string, errors: string[]) {
  if (operand.type === "constant" && !Number.isFinite(operand.value)) errors.push(`${label}: constant must be numeric.`);
  if (operand.type === "indicator") {
    const period = Number(operand.params?.period ?? operand.params?.length ?? 14);
    if (!Number.isFinite(period) || period <= 0) errors.push(`${label}: indicator period must be greater than zero.`);
  }
  if ((operand.type === "highestHigh" || operand.type === "lowestLow" || operand.type === "percentChange" || operand.type === "relativeStrength") && operand.lookback <= 0) {
    errors.push(`${label}: lookback must be greater than zero.`);
  }
  if (operand.type === "averageVolume" && operand.period <= 0) errors.push(`${label}: average volume period must be greater than zero.`);
}
