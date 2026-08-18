import type { ManagedPosition, PortfolioPosition, PositionProtectionOrder } from "./types";

const positionMoneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export type EditableProtectionType = "take-profit" | "stop-loss" | "break-even";

export type BybitPositionProtectionDraft = {
  accountId: string;
  symbol: string;
  marketKind: "perpetual";
  category: "linear" | "inverse";
  positionIdx: number;
  takeProfit?: number;
  stopLoss?: number;
  trailingStop?: number;
  cancelTakeProfit?: boolean;
  cancelStopLoss?: boolean;
  cancelTrailingStop?: boolean;
  tpslMode: "full";
  tpTriggerBy: "last";
  slTriggerBy: "last";
  mainnetConfirmed: true;
  liveConfirmation: "LIVE";
};

export function formatPositionMoney(value: number) {
  return positionMoneyFormatter.format(Number.isFinite(value) ? value : 0);
}

export function buildBybitProtectionCancelDraft(
  position: Parameters<typeof buildBybitProtectionDraft>[0],
  type: "take-profit" | "stop-loss" | "trailing-stop"
): BybitPositionProtectionDraft {
  const seed = buildBybitProtectionDraft(position, type === "take-profit" ? "take-profit" : "stop-loss", 1);
  delete seed.takeProfit;
  delete seed.stopLoss;
  if (type === "take-profit") seed.cancelTakeProfit = true;
  else if (type === "stop-loss") seed.cancelStopLoss = true;
  else seed.cancelTrailingStop = true;
  return seed;
}

export function formatSignedPositionMoney(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return positionMoneyFormatter.format(0);
  return `${value > 0 ? "+" : "-"}${positionMoneyFormatter.format(Math.abs(value))}`;
}

export function projectedLinearPositionPnl(
  position: Pick<PortfolioPosition, "direction" | "quantity" | "averagePrice" | "category" | "marketKind" | "symbol">,
  targetPrice: number
) {
  const category = String(position.category || position.marketKind || "linear").toLowerCase();
  const isLinear = category === "linear" || category === "perpetual" || category === "futures";
  const isUsdSettled = /(?:USDT|USDC)$/.test(position.symbol.toUpperCase());
  if (!isLinear || !isUsdSettled) return null;
  if (![position.averagePrice, position.quantity, targetPrice].every((value) => Number.isFinite(value)) || position.quantity <= 0 || targetPrice <= 0) return null;
  const direction = position.direction === "long" ? 1 : -1;
  return (targetPrice - position.averagePrice) * position.quantity * direction;
}

export function quantizeProtectionPrice(price: number, tickSize?: string, pricePrecision = 2) {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Protection price must be a positive number.");
  const tick = Number(tickSize);
  const precision = Math.max(0, Math.min(12, Number.isInteger(pricePrecision) ? pricePrecision : 2));
  if (Number.isFinite(tick) && tick > 0) {
    const tickDecimals = Math.max(0, Math.min(12, (tickSize?.split(".")[1] || "").replace(/0+$/, "").length));
    return Number((Math.round(price / tick) * tick).toFixed(tickDecimals));
  }
  return Number(price.toFixed(precision));
}

export function isEditableNativeProtection(protection: PositionProtectionOrder | undefined): protection is PositionProtectionOrder & { type: EditableProtectionType } {
  return Boolean(protection && ["take-profit", "stop-loss", "break-even"].includes(protection.type));
}

export function buildBybitProtectionDraft(
  position: Pick<ManagedPosition, "accountId" | "exchange" | "symbol" | "marketKind" | "category" | "positionIdx">,
  type: EditableProtectionType,
  price: number
): BybitPositionProtectionDraft {
  if (position.exchange !== "bybit") throw new Error("Chart protection updates are currently certified for Bybit only.");
  if (!Number.isFinite(price) || price <= 0) throw new Error("Protection price must be a positive number.");
  const category = String(position.category || "linear").toLowerCase();
  if (category !== "linear" && category !== "inverse") throw new Error(`Bybit ${category} position protection is not supported.`);
  if (position.positionIdx === undefined || position.positionIdx === null) throw new Error("Bybit position index is required for native TP/SL protection.");
  const positionIdx = Number(position.positionIdx);
  if (![0, 1, 2].includes(positionIdx)) throw new Error("Bybit position index is invalid.");

  return {
    accountId: position.accountId,
    symbol: position.symbol.toUpperCase(),
    marketKind: "perpetual",
    category,
    positionIdx,
    ...(type === "take-profit" ? { takeProfit: price } : { stopLoss: price }),
    tpslMode: "full",
    tpTriggerBy: "last",
    slTriggerBy: "last",
    mainnetConfirmed: true,
    liveConfirmation: "LIVE"
  };
}
