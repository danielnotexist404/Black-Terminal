import type { LiquidationInstrumentRules, LiquidationRiskTier } from "./types.ts";

export interface LiquidationModelInput {
  side: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  positionNotional: number;
  leverage: number;
  marginMode: "ISOLATED" | "CROSS" | "UNKNOWN";
  initialMarginRate: number | null;
  maintenanceMarginRate: number | null;
  maintenanceMarginDeduction: number | null;
  fundingEstimate: number;
  feeReserveEstimate: number;
  additionalCollateralEstimate: number | null;
  contractType: string;
  contractMultiplier: number;
}

export interface LiquidationDistribution {
  mean: number;
  standardDeviation: number;
  lowerBound: number;
  upperBound: number;
  confidence: number;
  assumptions: string[];
  modelVersion: string;
}

function selectTier(rules: LiquidationInstrumentRules, notional: number): LiquidationRiskTier | undefined {
  const sorted = [...rules.riskTiers].sort((a, b) => a.riskLimitValue - b.riskLimitValue);
  return sorted.find((tier) => notional <= tier.riskLimitValue) ?? sorted.at(-1);
}

export function bybitLiquidationInput(
  side: "LONG" | "SHORT",
  entryPrice: number,
  markPrice: number,
  notional: number,
  leverage: number,
  rules: LiquidationInstrumentRules,
  marginMode: "ISOLATED" | "CROSS" | "UNKNOWN" = "UNKNOWN"
): LiquidationModelInput {
  const tier = selectTier(rules, notional);
  return {
    side,
    entryPrice,
    markPrice,
    positionNotional: notional,
    leverage,
    marginMode,
    initialMarginRate: tier?.initialMarginRate ?? 1 / Math.max(1, leverage),
    maintenanceMarginRate: tier?.maintenanceMarginRate ?? null,
    maintenanceMarginDeduction: tier?.maintenanceMarginDeduction ?? null,
    fundingEstimate: 0,
    feeReserveEstimate: 0.0006,
    additionalCollateralEstimate: null,
    contractType: rules.contractType,
    contractMultiplier: rules.contractMultiplier
  };
}

export function estimateBybitLinearLiquidationDistribution(input: LiquidationModelInput): LiquidationDistribution {
  const assumptions: string[] = [
    "USDT-linear mark-price liquidation estimate",
    "Public risk-tier maintenance margin",
    "Account-wide collateral is not observable"
  ];
  const leverage = Math.max(1, input.leverage);
  const maintenance = Math.max(0, input.maintenanceMarginRate ?? 0.005);
  const initial = Math.max(maintenance, input.initialMarginRate ?? 1 / leverage);
  const deductionRatio = input.positionNotional > 0
    ? Math.max(0, input.maintenanceMarginDeduction ?? 0) / input.positionNotional
    : 0;
  const funding = Math.max(-0.02, Math.min(0.02, input.fundingEstimate));
  const fee = Math.max(0, Math.min(0.02, input.feeReserveEstimate));
  const effectiveMargin = Math.max(0.001, initial - maintenance + deductionRatio - funding - fee);
  const direction = input.side === "LONG" ? -1 : 1;
  const mean = input.entryPrice * (1 + direction * effectiveMargin);
  const isolatedSigma = input.entryPrice * (0.0018 + maintenance * 0.12);
  const crossUncertainty = input.marginMode === "CROSS"
    ? input.entryPrice * 0.035
    : input.marginMode === "UNKNOWN"
      ? input.entryPrice * 0.016
      : 0;
  if (input.marginMode !== "ISOLATED") assumptions.push("Cross-margin hypotheses use a deliberately broad distribution");
  const standardDeviation = Math.max(input.entryPrice * 0.0005, isolatedSigma + crossUncertainty);
  return {
    mean,
    standardDeviation,
    lowerBound: Math.max(0, mean - standardDeviation * 2.2),
    upperBound: mean + standardDeviation * 2.2,
    confidence: input.marginMode === "ISOLATED" ? 0.82 : input.marginMode === "CROSS" ? 0.34 : 0.48,
    assumptions,
    modelVersion: "BCLIF_BYBIT_LINEAR_LIQ_V1"
  };
}
