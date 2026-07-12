import type { ConnectionDiagnostics } from "../connectivity/types";
import type { MarketKind } from "../market-data/types";
import type { ExchangeAccountSyncPayload } from "../portfolio/portfolioApiClient";
import { listReadyExecutionAlgorithms, type ExecutionAlgorithmDefinition } from "./executionAlgorithmRegistry.ts";
import type { MarginMode, OrderType, SizingMethod, TimeInForce } from "./types";

export type VenueInstrumentRules = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  tickSize: number;
  quantityStep: number;
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
  minLeverage: number;
  maxLeverage: number;
  leverageStep: number;
  riskTierId: number;
  riskLimitValue: number;
  maximumBuyPrice: number;
  minimumSellPrice: number;
};

export type VenueOrderMode = {
  id: "market" | "limit" | "conditional";
  label: string;
  orderTypes: OrderType[];
  nativeOrSynthetic: "native" | "black-core";
  fields: Array<"quantity" | "price" | "triggerPrice" | "triggerBy" | "executionType" | "timeInForce" | "postOnly" | "reduceOnly" | "tpSl" | "slippageTolerance">;
};

export type VenueExecutionSchema = {
  venue: string;
  venueLabel: string;
  product: MarketKind;
  marketType: string;
  network: string;
  accountType: string;
  accountLabel: string;
  executionReady: boolean;
  readinessReason: string | null;
  capabilities: string[];
  supportedOrderModes: VenueOrderMode[];
  supportedSizingModes: SizingMethod[];
  supportedTimeInForce: TimeInForce[];
  supportedProtectionModes: string[];
  supportedMarginModes: MarginMode[];
  supportedPositionModes: string[];
  supportedAlgoStrategies: ExecutionAlgorithmDefinition[];
  instrumentRules: VenueInstrumentRules;
  currentLeverage: number;
  currentMarginMode: MarginMode;
  currentPositionMode: "one-way" | "hedge";
  maxOrderNotionalUsd: number;
  accountMetrics: ExchangeAccountSyncPayload["accountMetrics"] | null;
  featureFlags: {
    showLeverage: boolean;
    showMarginMode: boolean;
    showReduceOnly: boolean;
    showPostOnly: boolean;
    showTpSl: boolean;
  };
};

export type VenueExecutionSchemaInput = {
  connection: ConnectionDiagnostics;
  product: MarketKind;
  symbol: string;
  sync: ExchangeAccountSyncPayload | null;
};

export type VenueSchemaProvider = (input: VenueExecutionSchemaInput) => VenueExecutionSchema;

const providers = new Map<string, VenueSchemaProvider>();

providers.set("bybit", buildBybitSchema);

export function registerVenueExecutionSchemaProvider(venue: string, provider: VenueSchemaProvider) {
  providers.set(venue, provider);
}

export function buildVenueExecutionSchema(input: VenueExecutionSchemaInput): VenueExecutionSchema {
  return (providers.get(input.connection.provider) ?? buildFallbackSchema)(input);
}

export function calculateVenueOrderPreview(input: {
  schema: VenueExecutionSchema;
  sizingMethod: SizingMethod;
  size: number;
  referencePrice: number;
  leverage: number;
  side: "buy" | "sell";
  stopLoss?: number;
  takeProfit?: number;
}) {
  const { schema } = input;
  const notional = input.sizingMethod === "usd" ? input.size : input.size * input.referencePrice;
  const requiredMargin = schema.product === "spot" ? notional : notional / Math.max(1, input.leverage);
  const entryFee = notional * 0.0006;
  const exitFee = notional * 0.0006;
  const available = Number(schema.accountMetrics?.availableBalanceUsd || 0);
  const riskToStop = input.stopLoss && input.referencePrice > 0
    ? Math.abs(input.referencePrice - input.stopLoss) * (notional / input.referencePrice)
    : null;
  const rewardToTarget = input.takeProfit && input.referencePrice > 0
    ? Math.abs(input.takeProfit - input.referencePrice) * (notional / input.referencePrice)
    : null;

  return {
    notional,
    requiredMargin,
    entryFee,
    exitFee,
    availableAfter: available - requiredMargin - entryFee,
    riskToStop,
    rewardToTarget,
    rewardRiskRatio: riskToStop && rewardToTarget ? rewardToTarget / riskToStop : null
  };
}

export function sizeFromEquityPercent(input: {
  schema: VenueExecutionSchema;
  percent: number;
  referencePrice: number;
  leverage: number;
  sizingMethod: SizingMethod;
}) {
  const available = Number(input.schema.accountMetrics?.availableBalanceUsd || 0);
  const feeRate = 0.0006;
  const marginRate = input.schema.product === "spot" ? 1 : 1 / Math.max(1, input.leverage);
  const buyingPower = available / (marginRate + feeRate);
  const cappedBuyingPower = input.schema.maxOrderNotionalUsd > 0
    ? Math.min(buyingPower, input.schema.maxOrderNotionalUsd)
    : buyingPower;
  const notional = Math.max(0, cappedBuyingPower * clamp(input.percent, 0, 1));
  if (input.sizingMethod === "usd") return roundToPrecision(notional, 2);
  if (input.referencePrice <= 0) return 0;
  return floorToStep(notional / input.referencePrice, input.schema.instrumentRules.quantityStep, input.schema.instrumentRules.quantityPrecision);
}

export function sizeFromPositionPercent(schema: VenueExecutionSchema, positionQuantity: number, percent: number) {
  return floorToStep(
    Math.max(0, positionQuantity) * clamp(percent, 0, 1),
    schema.instrumentRules.quantityStep,
    schema.instrumentRules.quantityPrecision
  );
}

export function validateVenueOrderDraft(input: {
  schema: VenueExecutionSchema;
  orderType: OrderType;
  sizingMethod: SizingMethod;
  size: number;
  referencePrice: number;
  limitPrice?: number;
  triggerPrice?: number;
  leverage: number;
  side: "buy" | "sell";
  reduceOnly: boolean;
  tpSlEnabled: boolean;
}) {
  const reasons: string[] = [];
  const rules = input.schema.instrumentRules;
  const quantity = input.sizingMethod === "usd"
    ? floorToStep(input.size / Math.max(input.referencePrice, 1), rules.quantityStep, rules.quantityPrecision)
    : input.size;
  const notional = input.sizingMethod === "usd" ? input.size : input.size * input.referencePrice;

  if (!input.schema.executionReady) reasons.push(input.schema.readinessReason || `${input.schema.venueLabel} trading is unavailable.`);
  if (!Number.isFinite(input.size) || input.size <= 0) reasons.push("Enter an order size greater than zero.");
  if (rules.minQuantity > 0 && quantity < rules.minQuantity) reasons.push(`Minimum ${rules.symbol} quantity is ${rules.minQuantity}.`);
  if (rules.maxQuantity > 0 && quantity > rules.maxQuantity) reasons.push(`Maximum ${rules.symbol} quantity is ${rules.maxQuantity}.`);
  if (rules.quantityStep > 0 && quantity > 0 && !isStepAligned(quantity, rules.quantityStep)) reasons.push(`Quantity must use increments of ${rules.quantityStep}.`);
  if (rules.minNotional > 0 && notional < rules.minNotional) reasons.push(`Minimum ${rules.symbol} order value is ${rules.minNotional} ${rules.quoteAsset}.`);
  if (input.schema.maxOrderNotionalUsd > 0 && notional > input.schema.maxOrderNotionalUsd) reasons.push(`Maximum order value for this account is ${input.schema.maxOrderNotionalUsd} USD.`);
  if (["limit", "stop-limit"].includes(input.orderType) && (!input.limitPrice || input.limitPrice <= 0)) reasons.push("Enter a valid limit price.");
  if (input.limitPrice && rules.tickSize > 0 && !isStepAligned(input.limitPrice, rules.tickSize)) reasons.push(`Price must use increments of ${rules.tickSize}.`);
  if (input.side === "buy" && input.limitPrice && rules.maximumBuyPrice > 0 && input.limitPrice > rules.maximumBuyPrice) reasons.push(`Buy price exceeds the current Bybit price limit of ${rules.maximumBuyPrice}.`);
  if (input.side === "sell" && input.limitPrice && rules.minimumSellPrice > 0 && input.limitPrice < rules.minimumSellPrice) reasons.push(`Sell price is below the current Bybit price limit of ${rules.minimumSellPrice}.`);
  if (["stop-market", "stop-limit"].includes(input.orderType) && (!input.triggerPrice || input.triggerPrice <= 0)) reasons.push("Enter a valid trigger price.");
  if (input.leverage < rules.minLeverage || input.leverage > rules.maxLeverage) reasons.push(`Leverage must be between ${rules.minLeverage}x and ${rules.maxLeverage}x.`);
  if (rules.leverageStep > 0 && !isStepAligned(input.leverage, rules.leverageStep)) reasons.push(`Leverage must use increments of ${rules.leverageStep}x.`);
  if (input.reduceOnly && input.tpSlEnabled) reasons.push("Bybit does not allow attached TP/SL on a Reduce-Only order.");

  return { valid: reasons.length === 0, reasons, normalizedQuantity: quantity, notional };
}

function buildBybitSchema(input: VenueExecutionSchemaInput): VenueExecutionSchema {
  const instrument = input.sync?.instrumentRules;
  const position = input.sync?.selectedPosition;
  const product = input.product === "spot" ? "spot" : "perpetual";
  const executionState = input.sync?.executionState;
  const activeRiskTier = input.sync?.riskLimits?.find((tier) => tier.id === position?.riskId) || input.sync?.riskLimits?.find((tier) => tier.lowestRisk) || null;
  const readinessReason = normalizeReadinessReason(executionState?.readinessReason || input.connection.metadata.readinessReason);
  const executionReady = input.connection.health.permissions.trading === true && executionState?.tradingEnabled !== false;
  const algorithms = listReadyExecutionAlgorithms("bybit", product);

  return {
    venue: "bybit",
    venueLabel: "Bybit",
    product,
    marketType: product === "spot" ? "Spot" : "USDT Perpetual",
    network: String(input.connection.metadata.network || "mainnet"),
    accountType: String(input.sync?.accountMetrics.accountType || "UNIFIED"),
    accountLabel: input.connection.label,
    executionReady,
    readinessReason: executionReady ? null : readinessReason || "Bybit trading is unavailable for this account.",
    capabilities: input.connection.capabilities,
    supportedOrderModes: algorithms.flatMap((algorithm): VenueOrderMode[] => {
      if (algorithm.id === "bybit.market") return [{ id: "market", label: "Market", orderTypes: ["market"], nativeOrSynthetic: "native", fields: ["quantity", "slippageTolerance", "reduceOnly", "tpSl"] }];
      if (algorithm.id === "bybit.limit") return [{ id: "limit", label: "Limit", orderTypes: ["limit"], nativeOrSynthetic: "native", fields: ["quantity", "price", "timeInForce", "postOnly", "reduceOnly", "tpSl"] }];
      if (algorithm.id === "bybit.conditional") return [{ id: "conditional", label: "Conditional", orderTypes: ["stop-market", "stop-limit"], nativeOrSynthetic: "native", fields: ["quantity", "triggerPrice", "triggerBy", "executionType", "price", "timeInForce", "postOnly", "reduceOnly", "tpSl"] }];
      return [];
    }),
    supportedSizingModes: ["quantity", "usd", "equityPct"],
    supportedTimeInForce: ["gtc", "ioc", "fok"],
    supportedProtectionModes: product === "spot" ? ["take-profit", "stop-loss"] : ["take-profit", "stop-loss", "trailing-stop"],
    supportedMarginModes: product === "spot" ? [] : input.sync?.accountState?.marginMode === "portfolio" ? ["portfolio", "cross", "isolated"] : ["cross", "isolated"],
    supportedPositionModes: product === "spot" ? [] : ["one-way", "hedge"],
    supportedAlgoStrategies: algorithms,
    instrumentRules: {
      symbol: String(instrument?.nativeSymbol || input.symbol).toUpperCase(),
      baseAsset: String(instrument?.canonicalBase || baseAsset(input.symbol)),
      quoteAsset: String(instrument?.canonicalQuote || "USDT"),
      settlementAsset: String(instrument?.settlementAsset || "USDT"),
      tickSize: Number(instrument?.tickSize || 0),
      quantityStep: Number(instrument?.quantityStep || 0),
      minQuantity: Number(instrument?.minQuantity || 0),
      maxQuantity: Number(instrument?.maxQuantity || 0),
      minNotional: Number(instrument?.minNotional || 0),
      pricePrecision: Number(instrument?.pricePrecision ?? 2),
      quantityPrecision: Number(instrument?.quantityPrecision ?? 8),
      minLeverage: product === "spot" ? 1 : Number(instrument?.leverageLimits?.min || 1),
      maxLeverage: product === "spot" ? 1 : Math.min(Number(instrument?.leverageLimits?.max || 1), Number(activeRiskTier?.maxLeverage || Number.POSITIVE_INFINITY)),
      leverageStep: product === "spot" ? 1 : Number(instrument?.leverageLimits?.step || 1),
      riskTierId: Number(activeRiskTier?.id || 0),
      riskLimitValue: Number(activeRiskTier?.riskLimitValue || 0),
      maximumBuyPrice: Number(input.sync?.priceLimit?.maximumBuyPrice || 0),
      minimumSellPrice: Number(input.sync?.priceLimit?.minimumSellPrice || 0)
    },
    currentLeverage: Number(position?.leverage || 1),
    currentMarginMode: input.sync?.accountState?.marginMode || "cross",
    currentPositionMode: position?.positionMode === "hedge" ? "hedge" : "one-way",
    maxOrderNotionalUsd: Number(executionState?.maxNotionalUsd || 0),
    accountMetrics: input.sync?.accountMetrics || null,
    featureFlags: {
      showLeverage: product !== "spot" && input.sync?.accountState?.marginMode !== "portfolio",
      showMarginMode: product !== "spot",
      showReduceOnly: product !== "spot",
      showPostOnly: true,
      showTpSl: true
    }
  };
}

function buildFallbackSchema(input: VenueExecutionSchemaInput): VenueExecutionSchema {
  const rules = defaultRules(input.symbol);
  return {
    venue: input.connection.provider,
    venueLabel: input.connection.label,
    product: input.product,
    marketType: input.product,
    network: String(input.connection.metadata.network || "mainnet"),
    accountType: "ACCOUNT",
    accountLabel: input.connection.label,
    executionReady: input.connection.health.permissions.trading === true,
    readinessReason: normalizeReadinessReason(input.connection.metadata.readinessReason) || "Trading is unavailable for this connection.",
    capabilities: input.connection.capabilities,
    supportedOrderModes: [{ id: "market", label: "Market", orderTypes: ["market"], nativeOrSynthetic: "native", fields: ["quantity"] }],
    supportedSizingModes: ["quantity", "usd"],
    supportedTimeInForce: ["gtc"],
    supportedProtectionModes: [],
    supportedMarginModes: [],
    supportedPositionModes: [],
    supportedAlgoStrategies: [],
    instrumentRules: rules,
    currentLeverage: 1,
    currentMarginMode: "cross",
    currentPositionMode: "one-way",
    maxOrderNotionalUsd: 0,
    accountMetrics: input.sync?.accountMetrics || null,
    featureFlags: { showLeverage: false, showMarginMode: false, showReduceOnly: false, showPostOnly: false, showTpSl: false }
  };
}

function defaultRules(symbol: string): VenueInstrumentRules {
  return {
    symbol: symbol.toUpperCase(), baseAsset: baseAsset(symbol), quoteAsset: "USDT", settlementAsset: "USDT",
    tickSize: 0, quantityStep: 0, minQuantity: 0, maxQuantity: 0, minNotional: 0,
    pricePrecision: 2, quantityPrecision: 8, minLeverage: 1, maxLeverage: 1, leverageStep: 1,
    riskTierId: 0, riskLimitValue: 0, maximumBuyPrice: 0, minimumSellPrice: 0
  };
}

function normalizeReadinessReason(value: unknown) {
  const text = typeof value === "string" ? value : "";
  if (!text) return null;
  if (/private stream/i.test(text)) return "Bybit trading is unavailable: private account synchronization is reconnecting.";
  if (/permission/i.test(text)) return "Bybit trading is unavailable: the connected API key does not permit order placement.";
  if (/symbol/i.test(text)) return "Bybit trading is unavailable for this market.";
  return "Bybit trading is temporarily unavailable. Open Runtime & Certification for technical details.";
}

function baseAsset(symbol: string) {
  return String(symbol || "").toUpperCase().replace(/(?:USDT|USDC|USD|PERP)$/i, "") || "COIN";
}

function floorToStep(value: number, step: number, precision: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!step || step <= 0) return roundToPrecision(value, precision);
  return roundToPrecision(Math.floor((value + 1e-12) / step) * step, precision);
}

function roundToPrecision(value: number, precision: number) {
  return Number(value.toFixed(Math.max(0, precision)));
}

function isStepAligned(value: number, step: number) {
  if (!step || step <= 0) return true;
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-8;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
