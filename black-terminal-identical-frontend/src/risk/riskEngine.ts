import type { OrderRequest } from "../execution/types";
import type { PortfolioAccount } from "../portfolio/types";
import type { AccountRiskControls, RiskCheckResult } from "./types";

export function evaluateOrderRisk(
  order: OrderRequest,
  account: PortfolioAccount,
  controls: AccountRiskControls,
  referencePrice: number
): RiskCheckResult {
  const reasons: string[] = [];
  const notional = order.sizingMethod === "usd" ? order.quantity : order.quantity * referencePrice;
  const requiredMargin = order.marketKind === "spot" ? notional : notional / Math.max(1, Number(order.leverage || 1));
  const estimatedFees = notional * 0.0006;

  if (controls.emergencyStop) reasons.push("Emergency stop is active.");
  if (controls.readOnlyMode) reasons.push("Account is in read-only mode.");
  if (!controls.tradingEnabled) reasons.push("Trading is disabled for this account.");
  if (controls.allowedSymbols.length > 0 && !controls.allowedSymbols.includes(order.symbol)) {
    reasons.push(`${order.symbol} is not in the allowed symbols list.`);
  }
  if (notional > controls.maxPositionUsd) {
    reasons.push(`Order notional exceeds maximum position size.`);
  }
  if (account.dailyPnl <= -Math.abs(controls.maxDailyLossUsd)) {
    reasons.push("Maximum daily loss has been reached.");
  }
  if (account.marginUsed + notional > controls.maxPortfolioExposureUsd) {
    reasons.push("Portfolio exposure limit would be exceeded.");
  }
  if (!order.reduceOnly && account.availableMargin > 0 && requiredMargin + estimatedFees > account.availableMargin) {
    reasons.push(`Order requires approximately ${(requiredMargin + estimatedFees).toFixed(2)} USD collateral but only ${account.availableMargin.toFixed(2)} USD is available.`);
  }

  return {
    status: reasons.length > 0 ? "blocked" : "approved",
    reasons
  };
}
