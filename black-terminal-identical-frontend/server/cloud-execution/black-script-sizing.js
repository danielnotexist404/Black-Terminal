function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Resolve the script's entry sizing before account/mandate/venue caps. */
export function resolveBlackScriptEntryQuantity({ payload = {}, policy, preview, equity, referencePrice }) {
  const price = positive(referencePrice);
  if (!price) throw new Error("BLACK_SCRIPT_REFERENCE_PRICE_INVALID");
  const fixed = positive(payload.quantity);
  if (fixed) return fixed;
  const percent = positive(payload.quantityPercent);
  if (percent) return Math.max(0, Number(equity || 0)) * Math.min(100, percent) / 100 / price;
  const cash = positive(payload.cashAmount);
  if (cash) return cash / price;
  if (String(policy?.tradeAmountMode || "").toUpperCase() === "FIXED_QUANTITY") {
    return Math.max(0, Number(policy?.tradeAmountValue || 0));
  }
  return Math.max(0, Number(preview?.estimatedNotional || 0)) / price;
}

/** Resolve an exact fixed or percentage close without exceeding the venue position. */
export function resolveBlackScriptCloseQuantity({ payload = {}, positionQuantity }) {
  const available = Math.max(0, Number(positionQuantity || 0));
  const fixed = positive(payload.closeQuantity);
  const percent = positive(payload.closeQuantityPercent);
  const requested = fixed || (percent ? available * Math.min(100, percent) / 100 : available);
  return Math.min(available, Math.max(0, requested));
}
