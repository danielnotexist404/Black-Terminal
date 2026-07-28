import type {
  ExchangeId,
  MarketKind,
  SymbolAssetClass,
  SymbolMetadata
} from "./types";

const DECIMAL_STEP = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export type SymbolMetadataInput = {
  exchange: ExchangeId;
  rawSymbol: string;
  normalizedSymbol: string;
  assetClass?: SymbolAssetClass;
  marketKind?: MarketKind;
  tickSize: string;
  quantityStep?: string;
  pricePrecision?: number;
  quantityPrecision?: number;
  source: string;
  sourceRevision?: string;
  timezone?: string;
  sessionPolicy?: string;
};

export function assertDecimalStep(value: string, field: "tickSize" | "quantityStep") {
  if (!DECIMAL_STEP.test(value) || Number(value) <= 0 || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid authoritative ${field}: ${value}`);
  }
  return value;
}

export function decimalPlaces(value: string) {
  const normalized = value.replace(/0+$/, "").replace(/\.$/, "");
  const decimal = normalized.indexOf(".");
  return decimal < 0 ? 0 : normalized.length - decimal - 1;
}

export function createSymbolMetadata(input: SymbolMetadataInput): SymbolMetadata {
  const tickSize = assertDecimalStep(input.tickSize, "tickSize");
  const quantityStep = input.quantityStep
    ? assertDecimalStep(input.quantityStep, "quantityStep")
    : undefined;

  return {
    exchange: input.exchange,
    rawSymbol: input.rawSymbol,
    normalizedSymbol: input.normalizedSymbol,
    assetClass: input.assetClass ?? "crypto",
    marketKind: input.marketKind,
    tickSize,
    quantityStep,
    pricePrecision: input.pricePrecision ?? decimalPlaces(tickSize),
    quantityPrecision: input.quantityPrecision ?? (quantityStep ? decimalPlaces(quantityStep) : undefined),
    timezone: input.timezone ?? "UTC",
    sessionPolicy: input.sessionPolicy ?? "continuous-utc",
    source: input.source,
    sourceRevision: input.sourceRevision
  };
}

export function requireSymbolMetadata(metadata: SymbolMetadata | undefined) {
  if (!metadata) throw new Error("missing-authoritative-tick-size");
  assertDecimalStep(metadata.tickSize, "tickSize");
  return metadata;
}

