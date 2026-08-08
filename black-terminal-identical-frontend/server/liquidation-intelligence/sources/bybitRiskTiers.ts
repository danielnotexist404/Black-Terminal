import type { LiquidationInstrumentRules, LiquidationRiskTier } from "../../../src/modules/liquidation-field/core/types.ts";
import { normalizeSymbol } from "../normalization/canonicalEnvelope.ts";
import { bybitPublicGet } from "./bybitTransport.ts";
import type { fetchBybitInstrumentInfo } from "./bybitInstrumentInfo.ts";

interface RiskResult {
  list: Array<{
    id: number;
    symbol?: string;
    riskLimitValue: string;
    maintenanceMargin: string | number;
    initialMargin: string | number;
    maxLeverage: string;
    mmDeduction: string;
  }>;
  nextPageCursor?: string;
}

type InstrumentInfo = Awaited<ReturnType<typeof fetchBybitInstrumentInfo>>;

export async function fetchBybitRiskRules(symbolValue: string, instrument: InstrumentInfo, sourceVersion: string, signal?: AbortSignal): Promise<LiquidationInstrumentRules> {
  const symbol = normalizeSymbol(symbolValue);
  const tiers: LiquidationRiskTier[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 1_000; page++) {
    const params = new URLSearchParams({ category: "linear", symbol });
    if (cursor) params.set("cursor", cursor);
    const result = await bybitPublicGet<RiskResult>("/v5/market/risk-limit", params, { signal });
    for (const row of result.list || []) {
      if (row.symbol && normalizeSymbol(row.symbol) !== symbol) continue;
      tiers.push({
        tierId: String(row.id),
        riskLimitValue: positive(row.riskLimitValue, "risk limit"),
        maintenanceMarginRate: normalizeRate(row.maintenanceMargin),
        initialMarginRate: normalizeRate(row.initialMargin),
        maintenanceMarginDeduction: nonNegative(row.mmDeduction),
        maxLeverage: positive(row.maxLeverage, "max leverage"),
        certainty: "OBSERVED"
      });
    }
    const next = String(result.nextPageCursor || "");
    if (!next || seen.has(next) || !result.list?.length) break;
    seen.add(next);
    cursor = next;
  }
  if (!tiers.length) throw new Error(`Bybit risk tiers unavailable for ${symbol}`);
  tiers.sort((a, b) => a.riskLimitValue - b.riskLimitValue || a.tierId.localeCompare(b.tierId));
  return {
    venue: "BYBIT",
    symbol,
    contractType: instrument.contractType,
    contractMultiplier: 1,
    maxLeverage: Math.min(instrument.maxLeverage, Math.max(...tiers.map((tier) => tier.maxLeverage))),
    leverageStep: instrument.leverageStep,
    fundingIntervalMinutes: instrument.fundingIntervalMinutes,
    riskTiers: tiers,
    fetchedAt: Date.now(),
    sourceVersion,
    certainty: "OBSERVED"
  };
}

function normalizeRate(value: unknown) { const numeric = positive(value, "margin rate"); return numeric > 0.2 ? numeric / 100 : numeric; }
function positive(value: unknown, label: string) { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid ${label}`); return numeric; }
function nonNegative(value: unknown) { const numeric = Number(value || 0); if (!Number.isFinite(numeric) || numeric < 0) throw new Error("Invalid maintenance margin deduction"); return numeric; }
