import {
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  normalizeCapitalPolicy,
} from "./domain.js";
import {
  evaluateStrategyTakeProfitLadder,
  floorStrategyVenueQuantity,
  reserveStrategyTakeProfits,
} from "./superatr-execution.js";

/**
 * Pure, network-free preview of the quantity path used by Black Cloud for a
 * futures strategy entry. This function reports the smallest entry that could
 * satisfy the venue and the complete TP ladder, but it never substitutes that
 * minimum for the risk-bounded configured entry.
 */
export function preflightTargetExecution(input = {}) {
  const reasonDetails = [];
  const direction = normalizeDirection(input.direction, reasonDetails);
  const referencePrice = positive(input.referencePrice);
  const requestedPercentages = normalizePercentages(input.takeProfitPercentages);
  const ladderConfigured = requestedPercentages.length > 0;
  const hasExplicitTakeProfitReferencePrice = Object.prototype.hasOwnProperty.call(input, "takeProfitReferencePrice");
  const hasExplicitTakeProfitReferencePrices = Object.prototype.hasOwnProperty.call(input, "takeProfitReferencePrices");
  const explicitTakeProfitReferencePrice = positive(input.takeProfitReferencePrice);
  const explicitTakeProfitReferencePrices = Array.isArray(input.takeProfitReferencePrices)
    ? input.takeProfitReferencePrices.map(positive)
    : null;
  if (ladderConfigured && hasExplicitTakeProfitReferencePrice && !explicitTakeProfitReferencePrice) {
    addReason(reasonDetails, "TAKE_PROFIT_REFERENCE_PRICE_INVALID", "The explicit take-profit reference price must be positive and finite.");
  }
  if (ladderConfigured && hasExplicitTakeProfitReferencePrices
    && (!explicitTakeProfitReferencePrices
      || explicitTakeProfitReferencePrices.length !== requestedPercentages.length
      || explicitTakeProfitReferencePrices.some((price) => !price))) {
    addReason(reasonDetails, "TAKE_PROFIT_REFERENCE_PRICES_INVALID", "Every configured take-profit leg requires one positive finite reference price.");
  }
  const explicitPriceVectorValid = ladderConfigured
    && hasExplicitTakeProfitReferencePrices
    && explicitTakeProfitReferencePrices?.length === requestedPercentages.length
    && explicitTakeProfitReferencePrices.every(Boolean);
  const explicitSinglePriceValid = ladderConfigured
    && hasExplicitTakeProfitReferencePrice
    && Boolean(explicitTakeProfitReferencePrice);
  const takeProfitReferencePrice = explicitPriceVectorValid
    ? Math.min(...explicitTakeProfitReferencePrices)
    : explicitSinglePriceValid
      ? explicitTakeProfitReferencePrice
      : (!hasExplicitTakeProfitReferencePrice && !hasExplicitTakeProfitReferencePrices ? referencePrice : null);
  const takeProfitPriceBasis = explicitPriceVectorValid || explicitSinglePriceValid
    ? String(input.takeProfitPriceBasis || "TAKE_PROFIT_REFERENCE_PRICE").trim().toUpperCase()
    : (!hasExplicitTakeProfitReferencePrice && !hasExplicitTakeProfitReferencePrices ? "REFERENCE_PRICE" : "INVALID_EXPLICIT_TAKE_PROFIT_PRICE");
  const equity = nonNegative(input.equity);
  const availableBalance = nonNegative(input.availableBalance);
  const venue = normalizeVenue(input.venue);

  if (!referencePrice) addReason(reasonDetails, "REFERENCE_PRICE_INVALID", "A positive reference price is required to estimate an executable order.");
  if (equity === null) addReason(reasonDetails, "EQUITY_INVALID", "Account equity must be a non-negative finite number.");
  if (availableBalance === null) addReason(reasonDetails, "AVAILABLE_BALANCE_INVALID", "Available balance must be a non-negative finite number.");
  if (!venue.quantityStep) addReason(reasonDetails, "VENUE_QUANTITY_STEP_INVALID", "A positive venue quantity step is required.");

  let policy = null;
  try {
    policy = normalizeCapitalPolicy(input.capitalPolicy || {}, "FUTURES", { allowZeroAllocation: true });
  } catch (error) {
    addReason(reasonDetails, "CAPITAL_POLICY_INVALID", error instanceof Error ? error.message : "The capital policy is invalid.");
  }

  const selectedCaps = direction
    ? selectDirectionCaps(input.directionSpecificLeverageCaps, direction)
    : {};
  const effectiveLeverage = policy && direction
    ? calculateEffectiveLeverage({
        requested: direction === "short"
          ? policy.requestedShortLeverage || policy.requestedLeverage
          : policy.requestedLongLeverage || policy.requestedLeverage,
        targetMaximum: positive(selectedCaps.targetMaximum) || policy.maximumLeverage,
        accountRiskCap: selectedCaps.accountRiskCap,
        groupMandateCap: selectedCaps.groupMandateCap,
        emsRiskCap: selectedCaps.emsRiskCap,
        providerCap: minimumPositive(selectedCaps.providerCap, selectedCaps.riskTierCap),
      })
    : null;

  let allocatedStrategyCapital = null;
  let rawEntryQuantity = null;
  let riskBoundedEntryQuantity = null;
  let entryQuantity = null;
  let entryNotional = null;
  let entryMargin = null;
  let maximumPositionNotional = null;
  let maximumExposureNotional = null;

  if (policy && referencePrice && equity !== null && availableBalance !== null && effectiveLeverage) {
    const preview = calculateCapitalPreview({
      equity,
      availableBalance,
      policy: { ...policy, requestedLeverage: effectiveLeverage },
      marketType: "FUTURES",
    });
    allocatedStrategyCapital = preview.allocatedStrategyCapital;
    rawEntryQuantity = policy.tradeAmountMode === "FIXED_QUANTITY"
      ? policy.tradeAmountValue
      : preview.estimatedNotional / referencePrice;
    maximumPositionNotional = allocatedStrategyCapital * policy.maximumPositionPercent / 100 * effectiveLeverage;
    maximumExposureNotional = allocatedStrategyCapital * policy.maximumExposurePercent / 100 * effectiveLeverage;
    const riskBoundedNotional = Math.min(
      rawEntryQuantity * referencePrice,
      maximumPositionNotional,
      maximumExposureNotional,
    );
    riskBoundedEntryQuantity = riskBoundedNotional / referencePrice;
    entryQuantity = floorStrategyVenueQuantity(riskBoundedEntryQuantity, venue);
    if (entryQuantity) {
      entryNotional = entryQuantity * referencePrice;
      entryMargin = entryNotional / effectiveLeverage;
    }
  }

  const entryReasons = evaluateEntry({
    quantity: entryQuantity,
    notional: entryNotional,
    margin: entryMargin,
    availableBalance,
    venue,
  });
  reasonDetails.push(...entryReasons);

  const reservedTargets = reserveStrategyTakeProfits(requestedPercentages.map((quantityPercent, index) => ({
    id: `TP${index + 1}`,
    quantityPercent,
    price: explicitPriceVectorValid ? explicitTakeProfitReferencePrices[index] : takeProfitReferencePrice,
  })));
  const ladder = ladderConfigured
    ? evaluateStrategyTakeProfitLadder({ entryQuantity, targets: reservedTargets, venue })
    : emptyLadder(entryQuantity);
  const ladderMaximumReasonDetails = ladderConfigured && ladder.ok
    ? evaluateTakeProfitMaximums(ladder.legs, venue)
    : [];
  const ladderReasonDetails = ladderConfigured
    ? [
        ...ladder.reasons.map((item) => ({ ...item, scope: "TAKE_PROFIT_LADDER" })),
        ...ladderMaximumReasonDetails,
      ]
    : [];
  reasonDetails.push(...ladderReasonDetails);

  const minimumExecutable = calculateMinimumExecutable({
    policy,
    equity,
    availableBalance,
    allocatedStrategyCapital,
    effectiveLeverage,
    referencePrice,
    takeProfitReferencePrice,
    takeProfitPriceBasis,
    venue,
    reservedTargets,
    ladderConfigured,
    maximumPositionNotional,
    maximumExposureNotional,
    configuredEntryQuantity: entryQuantity,
  });
  reasonDetails.push(...minimumExecutable.reasonDetails);

  const entryFeasible = entryReasons.length === 0;
  const fullLadderFeasible = entryFeasible
    && (!ladderConfigured || (ladder.ok && ladderMaximumReasonDetails.length === 0));
  const deduplicated = deduplicateReasons(reasonDetails);

  return {
    ok: fullLadderFeasible,
    direction,
    effectiveLeverage,
    pricing: {
      entryReferencePrice: referencePrice,
      entryPriceBasis: "REFERENCE_PRICE",
      takeProfitReferencePrice,
      takeProfitReferencePrices: explicitPriceVectorValid ? explicitTakeProfitReferencePrices : null,
      takeProfitPriceBasis,
      takeProfitReferencePriceFallback: ladderConfigured
        ? !hasExplicitTakeProfitReferencePrice && !hasExplicitTakeProfitReferencePrices
        : true,
    },
    leverageCaps: {
      requested: policy && direction === "short"
        ? policy.requestedShortLeverage
        : policy?.requestedLongLeverage,
      targetMaximum: positive(selectedCaps.targetMaximum) || policy?.maximumLeverage || null,
      accountRiskCap: positive(selectedCaps.accountRiskCap),
      groupMandateCap: positive(selectedCaps.groupMandateCap),
      emsRiskCap: positive(selectedCaps.emsRiskCap),
      providerCap: minimumPositive(selectedCaps.providerCap, selectedCaps.riskTierCap),
    },
    estimated: {
      rawEntryQuantity,
      riskBoundedEntryQuantity,
      entryQuantity,
      entryNotional,
      entryMargin,
      allocatedStrategyCapital,
      maximumPositionNotional,
      maximumExposureNotional,
      configuredTradeAmountMode: policy?.tradeAmountMode || null,
      configuredTradeAmountValue: policy?.tradeAmountValue ?? null,
    },
    fullLadder: {
      configured: ladderConfigured,
      feasible: fullLadderFeasible,
      priceBasis: takeProfitPriceBasis,
      referencePrice: takeProfitReferencePrice,
      referencePrices: reservedTargets.map((target) => target.price),
      requestedPercentages,
      effectivePercentages: reservedTargets.map((target) => target.quantityPercent),
      totalReservedQuantity: ladder.ok && ladderMaximumReasonDetails.length === 0 ? ladder.totalReservedQuantity : 0,
      remainingQuantity: ladder.remainingQuantity ?? entryQuantity,
      legs: ladder.ok && ladderMaximumReasonDetails.length === 0 ? ladder.legs : [],
      reasons: ladderReasonDetails.map((item) => item.message),
      reasonDetails: ladderReasonDetails,
    },
    minimumExecutable,
    reasons: [...new Set(deduplicated.map((item) => item.message))],
    reasonDetails: deduplicated,
  };
}

function calculateMinimumExecutable({
  policy,
  equity,
  availableBalance,
  allocatedStrategyCapital,
  effectiveLeverage,
  referencePrice,
  takeProfitReferencePrice,
  takeProfitPriceBasis,
  venue,
  reservedTargets,
  ladderConfigured,
  maximumPositionNotional,
  maximumExposureNotional,
  configuredEntryQuantity,
}) {
  const reasons = [];
  if (!policy || equity === null || availableBalance === null || !effectiveLeverage || !referencePrice || !venue.quantityStep) {
    addReason(reasons, "MINIMUM_EXECUTABLE_UNAVAILABLE", "The minimum executable order cannot be calculated until capital, leverage, price, and venue quantity rules are valid.", "MINIMUM_EXECUTABLE");
    return unavailableMinimum(policy, reasons, { referencePrice, takeProfitReferencePrice, takeProfitPriceBasis });
  }

  if (ladderConfigured && !reservedTargets.length) {
    addReason(reasons, "TP_LADDER_EMPTY", "No positive take-profit percentage remains after reservation.", "MINIMUM_EXECUTABLE");
    return unavailableMinimum(policy, reasons, { referencePrice, takeProfitReferencePrice, takeProfitPriceBasis });
  }

  const entryMinimumQuantity = Math.max(
    venue.quantityStep,
    venue.minQuantity,
    venue.minNotional > 0 ? venue.minNotional / referencePrice : 0,
  );
  let theoreticalQuantity = entryMinimumQuantity;
  for (const target of reservedTargets) {
    const targetPrice = positive(target?.price ?? target?.targetPrice);
    const legMinimumQuantity = ceilToVenueStep(Math.max(
      venue.quantityStep,
      venue.minQuantity,
      venue.minNotional > 0 && targetPrice ? venue.minNotional / targetPrice : 0,
    ), venue);
    theoreticalQuantity = Math.max(theoreticalQuantity, legMinimumQuantity * 100 / target.quantityPercent);
  }

  let entryQuantity = ceilToVenueStep(theoreticalQuantity, venue);
  let ladder = ladderConfigured
    ? evaluateStrategyTakeProfitLadder({ entryQuantity, targets: reservedTargets, venue })
    : emptyLadder(entryQuantity);
  let entryValidation = evaluateEntry({
    quantity: entryQuantity,
    notional: entryQuantity ? entryQuantity * referencePrice : null,
    margin: entryQuantity ? entryQuantity * referencePrice / effectiveLeverage : null,
    availableBalance: Number.POSITIVE_INFINITY,
    venue,
    enforceMaximum: false,
  });

  // The closed-form threshold lands at the correct step. The short bounded
  // verification loop only absorbs floating-point boundary representation and
  // always uses the same floor/all-or-nothing helpers as the live worker.
  for (let attempt = 0; attempt < 32 && (entryValidation.length || !ladder.ok); attempt += 1) {
    entryQuantity = ceilToVenueStep((entryQuantity || 0) + venue.quantityStep, venue);
    ladder = ladderConfigured
      ? evaluateStrategyTakeProfitLadder({ entryQuantity, targets: reservedTargets, venue })
      : emptyLadder(entryQuantity);
    entryValidation = evaluateEntry({
      quantity: entryQuantity,
      notional: entryQuantity ? entryQuantity * referencePrice : null,
      margin: entryQuantity ? entryQuantity * referencePrice / effectiveLeverage : null,
      availableBalance: Number.POSITIVE_INFINITY,
      venue,
      enforceMaximum: false,
    });
  }

  if (!entryQuantity || entryValidation.length || !ladder.ok) {
    addReason(reasons, "MINIMUM_EXECUTABLE_NOT_FOUND", "No venue-aligned entry was found that makes every take-profit leg executable.", "MINIMUM_EXECUTABLE");
    return unavailableMinimum(policy, reasons, { referencePrice, takeProfitReferencePrice, takeProfitPriceBasis });
  }

  const entryNotional = entryQuantity * referencePrice;
  const entryMargin = entryNotional / effectiveLeverage;
  const venueMaximumReasons = evaluateEntry({
    quantity: entryQuantity,
    notional: entryNotional,
    margin: entryMargin,
    availableBalance: Number.POSITIVE_INFINITY,
    venue,
  }).filter((reason) => reason.code === "ENTRY_ABOVE_MAX_MARKET_QUANTITY");
  const minimumLadderMaximumReasons = ladderConfigured && ladder.ok
    ? evaluateTakeProfitMaximums(ladder.legs, venue)
    : [];
  reasons.push(...venueMaximumReasons, ...minimumLadderMaximumReasons.map((reason) => ({ ...reason, scope: "MINIMUM_EXECUTABLE" })));
  const tradePercentOfAccountEquity = equity > 0 ? entryMargin / equity * 100 : null;
  const tradePercentOfStrategyAllocation = allocatedStrategyCapital > 0
    ? entryMargin / allocatedStrategyCapital * 100
    : null;
  const { tradePercent, tradePercentBasis } = selectTradePercent(
    policy,
    tradePercentOfAccountEquity,
    tradePercentOfStrategyAllocation,
  );
  const fitsAvailableBalance = entryMargin <= availableBalance + 1e-12;
  const fitsPositionLimit = maximumPositionNotional !== null && entryNotional <= maximumPositionNotional + 1e-12;
  const fitsExposureLimit = maximumExposureNotional !== null && entryNotional <= maximumExposureNotional + 1e-12;
  const withinConfiguredRiskBoundedSize = Boolean(configuredEntryQuantity && configuredEntryQuantity + 1e-12 >= entryQuantity);
  const fitsVenueMaximums = venueMaximumReasons.length === 0 && minimumLadderMaximumReasons.length === 0;

  if (!fitsAvailableBalance) addReason(reasons, "MINIMUM_EXCEEDS_AVAILABLE_BALANCE", `The minimum ladder needs ${entryMargin} margin, above the available balance ${availableBalance}.`, "MINIMUM_EXECUTABLE");
  if (!fitsPositionLimit) addReason(reasons, "MINIMUM_EXCEEDS_POSITION_LIMIT", `The minimum ladder notional ${entryNotional} exceeds the configured maximum-position notional ${maximumPositionNotional}.`, "MINIMUM_EXECUTABLE");
  if (!fitsExposureLimit) addReason(reasons, "MINIMUM_EXCEEDS_EXPOSURE_LIMIT", `The minimum ladder notional ${entryNotional} exceeds the configured maximum-exposure notional ${maximumExposureNotional}.`, "MINIMUM_EXECUTABLE");
  if (!withinConfiguredRiskBoundedSize) addReason(reasons, "MINIMUM_EXCEEDS_CONFIGURED_ENTRY", `The configured risk-bounded quantity ${configuredEntryQuantity || 0} is below the minimum full-ladder quantity ${entryQuantity}; preflight will not increase it.`, "MINIMUM_EXECUTABLE");

  return {
    available: true,
    entryQuantity,
    entryNotional,
    entryMargin,
    tradePercent,
    tradePercentBasis,
    tradePercentOfAccountEquity,
    tradePercentOfStrategyAllocation,
    fitsAvailableBalance,
    fitsRiskCaps: fitsPositionLimit && fitsExposureLimit,
    fitsVenueMaximums,
    withinConfiguredRiskBoundedSize,
    executableUnderCurrentLimits: fitsAvailableBalance && fitsPositionLimit && fitsExposureLimit && fitsVenueMaximums && withinConfiguredRiskBoundedSize,
    priceBasis: "REFERENCE_PRICE",
    referencePrice,
    takeProfitPriceBasis,
    takeProfitReferencePrice,
    reasons: reasons.map((item) => item.message),
    reasonDetails: reasons,
  };
}

function evaluateEntry({ quantity, notional, margin, availableBalance, venue, enforceMaximum = true }) {
  const reasons = [];
  if (!positive(quantity)) {
    addReason(reasons, "ENTRY_QUANTITY_ROUNDS_TO_ZERO", "The risk-bounded entry quantity is zero after applying the venue quantity step.", "ENTRY");
    return reasons;
  }
  if (venue.minQuantity > 0 && quantity + 1e-12 < venue.minQuantity) {
    addReason(reasons, "ENTRY_BELOW_MIN_QUANTITY", `Entry quantity ${quantity} is below the venue minimum ${venue.minQuantity}.`, "ENTRY");
  }
  if (venue.minNotional > 0 && (!positive(notional) || notional + 1e-12 < venue.minNotional)) {
    addReason(reasons, "ENTRY_BELOW_MIN_NOTIONAL", `Entry notional ${notional || 0} is below the venue minimum ${venue.minNotional}.`, "ENTRY");
  }
  if (enforceMaximum && venue.maxMarketQuantity && quantity > venue.maxMarketQuantity + 1e-12) {
    addReason(reasons, "ENTRY_ABOVE_MAX_MARKET_QUANTITY", `Market entry quantity ${quantity} exceeds the venue maximum ${venue.maxMarketQuantity}.`, "ENTRY");
  }
  if (Number.isFinite(availableBalance) && positive(margin) && margin > availableBalance + 1e-12) {
    addReason(reasons, "INSUFFICIENT_AVAILABLE_MARGIN", `Estimated entry margin ${margin} exceeds the available balance ${availableBalance}.`, "ENTRY");
  }
  return reasons;
}

function evaluateTakeProfitMaximums(legs, venue) {
  if (!venue.maxQuantity) return [];
  const reasons = [];
  for (const leg of Array.isArray(legs) ? legs : []) {
    const quantity = positive(leg?.quantity);
    if (quantity && quantity > venue.maxQuantity + 1e-12) {
      reasons.push({
        code: "TAKE_PROFIT_ABOVE_MAX_QUANTITY",
        targetId: leg?.id || null,
        scope: "TAKE_PROFIT_LADDER",
        message: `${leg?.id || "Take-profit"} quantity ${quantity} exceeds the venue limit-order maximum ${venue.maxQuantity}.`,
      });
    }
  }
  return reasons;
}

function selectDirectionCaps(value, direction) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const selected = value[direction];
  return selected && typeof selected === "object" && !Array.isArray(selected) ? selected : {};
}

function normalizeDirection(value, reasons) {
  const direction = String(value || "").trim().toLowerCase();
  if (direction === "long" || direction === "short") return direction;
  addReason(reasons, "DIRECTION_INVALID", "Direction must be either long or short.");
  return null;
}

function normalizeVenue(value = {}) {
  const maxQuantity = positive(value?.maxQuantity);
  const maxMarketQuantity = positive(value?.maxMarketQuantity) || maxQuantity;
  return {
    quantityStep: positive(value?.quantityStep),
    quantityPrecision: normalizePrecision(value?.quantityPrecision),
    minQuantity: Math.max(0, finiteOr(value?.minQuantity, 0)),
    minNotional: Math.max(0, finiteOr(value?.minNotional, 0)),
    // Entries are market orders, while the strategy's protective TP children
    // are reduce-only limit orders. Bybit publishes separate ceilings.
    maxQuantity,
    maxMarketQuantity,
  };
}

function normalizePercentages(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function ceilToVenueStep(quantity, venue) {
  const step = venue.quantityStep;
  if (!positive(quantity) || !step) return null;
  const units = Math.max(1, Math.ceil(quantity / step - 1e-12));
  return floorStrategyVenueQuantity(units * step, venue);
}

function selectTradePercent(policy, accountPercent, allocationPercent) {
  if (policy.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY") {
    return { tradePercent: accountPercent, tradePercentBasis: "ACCOUNT_EQUITY" };
  }
  if (["PERCENT_STRATEGY_ALLOCATION", "RISK_PERCENT", "VOLATILITY_TARGET"].includes(policy.tradeAmountMode)) {
    return { tradePercent: allocationPercent, tradePercentBasis: "STRATEGY_ALLOCATION" };
  }
  return { tradePercent: accountPercent, tradePercentBasis: "ACCOUNT_EQUITY_EQUIVALENT" };
}

function emptyLadder(entryQuantity) {
  return {
    ok: true,
    entryQuantity,
    totalReservedQuantity: 0,
    remainingQuantity: entryQuantity,
    legs: [],
    reasons: [],
  };
}

function unavailableMinimum(policy, reasons, pricing = {}) {
  return {
    available: false,
    entryQuantity: null,
    entryNotional: null,
    entryMargin: null,
    tradePercent: null,
    tradePercentBasis: policy ? selectTradePercent(policy, null, null).tradePercentBasis : null,
    tradePercentOfAccountEquity: null,
    tradePercentOfStrategyAllocation: null,
    fitsAvailableBalance: false,
    fitsRiskCaps: false,
    fitsVenueMaximums: false,
    withinConfiguredRiskBoundedSize: false,
    executableUnderCurrentLimits: false,
    priceBasis: "REFERENCE_PRICE",
    referencePrice: pricing.referencePrice || null,
    takeProfitPriceBasis: pricing.takeProfitPriceBasis || null,
    takeProfitReferencePrice: pricing.takeProfitReferencePrice || null,
    reasons: reasons.map((item) => item.message),
    reasonDetails: reasons,
  };
}

function deduplicateReasons(reasons) {
  const seen = new Set();
  return reasons.filter((item) => {
    const key = `${item.code}|${item.targetId || ""}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addReason(reasons, code, message, scope = "PREFLIGHT") {
  reasons.push({ code, targetId: null, scope, message });
}

function minimumPositive(...values) {
  const positives = values.map(positive).filter(Boolean);
  return positives.length ? Math.min(...positives) : null;
}

function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePrecision(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 12 ? parsed : null;
}
