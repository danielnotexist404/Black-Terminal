const positive = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * TradingView reserves strategy.exit quantities in source order. If the
 * requested percentages exceed the open position, later exits are reduced to
 * the unreserved remainder. Persisting the effective percentages keeps seven
 * independently queued Bybit reduce-only orders from over-reserving a
 * position.
 */
export function reserveStrategyTakeProfits(targets, maximumPercent = 100) {
  const ceiling = Math.max(0, Math.min(100, Number(maximumPercent) || 0));
  let reserved = 0;
  return (Array.isArray(targets) ? targets : []).flatMap((target, index) => {
    if (reserved >= ceiling) return [];
    const requested = Math.max(0, Math.min(100, Number(target?.quantityPercent) || 0));
    const quantityPercent = Math.min(requested, ceiling - reserved);
    if (!(quantityPercent > 0)) return [];
    reserved += quantityPercent;
    return [{ ...target, id: String(target?.id || `TP${index + 1}`).toUpperCase(), quantityPercent }];
  });
}

export function shouldQueueStrategyTakeProfits(action) {
  const normalized = String(action || "").toUpperCase();
  return normalized === "ENTRY" || normalized === "REVERSE";
}

/**
 * A TP reservation is a percentage of the entry's final filled quantity, not
 * a percentage of whatever happens to remain when a delayed command retries.
 * The remaining-position cap only protects a venue from a stale/oversized
 * reduce request; it never changes the reservation's original basis.
 */
export function calculateStrategyTakeProfitQuantity(originalQuantity, quantityPercent, remainingQuantity = null) {
  const original = positive(originalQuantity);
  const percentage = positive(quantityPercent);
  if (!original || !percentage) return null;
  const reservedQuantity = original * Math.min(100, percentage) / 100;
  const remaining = positive(remainingQuantity);
  return remaining ? Math.min(reservedQuantity, remaining) : reservedQuantity;
}

/**
 * Market entries may be acknowledged before their IOC lifecycle settles.
 * Wait for a terminal venue report and then freeze every TP reservation to
 * the final cumulative fill (including a partially-filled-then-cancelled IOC).
 */
export function settledStrategyEntryQuantity(orderReport) {
  const status = String(orderReport?.status || "").toLowerCase();
  const finalStatuses = new Set(["filled", "cancelled", "canceled", "rejected", "failed", "expired"]);
  if (!finalStatuses.has(status)) return null;
  return positive(orderReport?.filledQuantity ?? orderReport?.filled_quantity);
}

/**
 * Floors a positive quantity to the venue's step and precision. Returning
 * null is deliberate fail-closed behavior for missing/invalid venue rules or
 * for a quantity that becomes zero after normalization.
 */
export function floorStrategyVenueQuantity(quantity, venue = {}) {
  const parsed = positive(quantity);
  const precision = normalizeQuantityPrecision(venue?.quantityPrecision);
  const configuredStep = positive(venue?.quantityStep);
  if (!parsed || (precision === null && !configuredStep)) return null;

  const step = configuredStep || 10 ** -precision;
  const scalePrecision = Math.max(precision ?? 0, decimalPlaces(step));
  if (scalePrecision > 12) return null;
  const scale = 10 ** scalePrecision;
  const stepUnits = Math.max(1, Math.round(step * scale));
  const quantityUnits = Math.floor(parsed * scale + 1e-9);
  const steppedUnits = Math.floor(quantityUnits / stepUnits) * stepUnits;
  let normalized = steppedUnits / scale;

  if (precision !== null) {
    const precisionScale = 10 ** precision;
    normalized = Math.floor(normalized * precisionScale + 1e-9) / precisionScale;
  }
  return positive(normalized);
}

/**
 * Produces an all-or-nothing executable TP ladder. Every reservation is based
 * on the same cumulative entry fill, floored to venue quantity rules, and
 * checked against per-order minimum quantity/notional plus the total entry
 * quantity. A failed result intentionally exposes no executable targets.
 */
export function evaluateStrategyTakeProfitLadder({ entryQuantity, targets, venue = {} } = {}) {
  const entry = positive(entryQuantity);
  const sourceTargets = Array.isArray(targets) ? targets : [];
  const reasons = [];
  const evaluated = [];
  const minQuantity = Math.max(0, Number(venue?.minQuantity) || 0);
  const minNotional = Math.max(0, Number(venue?.minNotional) || 0);
  let cumulativeQuantity = 0;
  let cumulativePercent = 0;

  if (!entry) reasons.push(reason("ENTRY_QUANTITY_INVALID", null, "Entry quantity must be a positive finite number."));
  if (!sourceTargets.length) reasons.push(reason("TP_LADDER_EMPTY", null, "At least one reserved take-profit target is required."));
  if (normalizeQuantityPrecision(venue?.quantityPrecision) === null && !positive(venue?.quantityStep)) {
    reasons.push(reason("VENUE_QUANTITY_RULE_REQUIRED", null, "A positive quantityStep or integer quantityPrecision is required."));
  }

  if (entry) {
    for (const [index, target] of sourceTargets.entries()) {
      const targetId = String(target?.id || `TP${index + 1}`).toUpperCase();
      const quantityPercent = positive(target?.quantityPercent);
      if (!quantityPercent || quantityPercent > 100) {
        reasons.push(reason("TP_PERCENT_INVALID", targetId, "Target quantityPercent must be greater than 0 and no more than 100."));
        continue;
      }
      cumulativePercent += quantityPercent;
      const quantity = floorStrategyVenueQuantity(entry * quantityPercent / 100, venue);
      if (!quantity) {
        reasons.push(reason("TP_QUANTITY_ROUNDS_TO_ZERO", targetId, "Target quantity becomes zero under venue step/precision rules."));
        continue;
      }
      const price = positive(target?.price ?? target?.targetPrice);
      const notional = price ? quantity * price : null;
      if (minQuantity > 0 && quantity + 1e-12 < minQuantity) {
        reasons.push(reason("TP_BELOW_MIN_QUANTITY", targetId, `Target quantity ${quantity} is below venue minimum ${minQuantity}.`));
      }
      if (minNotional > 0 && !price) {
        reasons.push(reason("TP_PRICE_REQUIRED_FOR_MIN_NOTIONAL", targetId, "A positive target price is required to validate venue minNotional."));
      } else if (minNotional > 0 && notional + 1e-12 < minNotional) {
        reasons.push(reason("TP_BELOW_MIN_NOTIONAL", targetId, `Target notional ${notional} is below venue minimum ${minNotional}.`));
      }
      cumulativeQuantity += quantity;
      evaluated.push({ ...target, id: targetId, quantityPercent, quantity, price, notional });
    }
  }

  if (cumulativePercent > 100 + 1e-12) {
    reasons.push(reason("TP_LADDER_PERCENT_EXCEEDS_100", null, `Cumulative target percentage ${cumulativePercent} exceeds 100.`));
  }
  if (entry && cumulativeQuantity > entry + 1e-12) {
    reasons.push(reason("TP_LADDER_EXCEEDS_ENTRY_QUANTITY", null, `Cumulative target quantity ${cumulativeQuantity} exceeds entry quantity ${entry}.`));
  }

  if (reasons.length) {
    return { ok: false, entryQuantity: entry, totalReservedQuantity: 0, remainingQuantity: entry, legs: [], reasons };
  }
  return {
    ok: true,
    entryQuantity: entry,
    totalReservedQuantity: cumulativeQuantity,
    remainingQuantity: Math.max(0, entry - cumulativeQuantity),
    legs: evaluated,
    reasons: [],
  };
}

/**
 * Revalidates the complete TP contract against the terminal IOC fill. If the
 * venue returned less than the requested entry and seven independent legs are
 * no longer possible, reserve the entire owned remainder at TP1 instead of
 * leaving exposure unprotected or submitting a partial ladder. Callers must
 * emit an operator-visible warning when the aggregate fallback is selected.
 */
export function planStrategyTakeProfitProtection({ entryQuantity, remainingQuantity, targets, venue = {} } = {}) {
  const reservedTargets = reserveStrategyTakeProfits(targets);
  const normalizedEntry = positive(entryQuantity) || 0;
  const normalizedRemaining = remainingQuantity === undefined || remainingQuantity === null
    ? normalizedEntry
    : positive(remainingQuantity) || 0;
  const ownedRemainder = Math.min(normalizedEntry, normalizedRemaining);
  const fullLadder = reservedTargets.length
    ? evaluateStrategyTakeProfitLadder({ entryQuantity, targets: reservedTargets, venue })
    : { ok: false, entryQuantity: positive(entryQuantity), totalReservedQuantity: 0, remainingQuantity: positive(entryQuantity), legs: [], reasons: [reason("TP_LADDER_EMPTY", null, "At least one reserved take-profit target is required.")] };
  const fullLadderFitsOwnedRemainder = fullLadder.ok && fullLadder.totalReservedQuantity <= ownedRemainder + 1e-12;
  if (fullLadderFitsOwnedRemainder) {
    return { mode: "FULL_LADDER", primaryTargetId: reservedTargets[0]?.id || null, fullLadder, aggregateLadder: null, reasons: [] };
  }

  const firstTarget = reservedTargets[0];
  const aggregateTarget = firstTarget ? { ...firstTarget, quantityPercent: 100 } : null;
  const aggregateLadder = aggregateTarget && ownedRemainder > 0
    ? evaluateStrategyTakeProfitLadder({ entryQuantity: ownedRemainder, targets: [aggregateTarget], venue })
    : { ok: false, entryQuantity: positive(ownedRemainder), totalReservedQuantity: 0, remainingQuantity: positive(ownedRemainder), legs: [], reasons: [reason("TP_AGGREGATE_UNAVAILABLE", firstTarget?.id || null, "No executable owned remainder is available for aggregate TP1 protection.")] };
  if (aggregateLadder.ok) {
    return {
      mode: "AGGREGATED_TP1",
      primaryTargetId: firstTarget.id,
      fullLadder,
      aggregateLadder,
      target: aggregateLadder.legs[0],
      reasons: fullLadder.ok && !fullLadderFitsOwnedRemainder
        ? [reason("TP_LADDER_EXCEEDS_OWNED_REMAINDER", null, `The complete ladder reserves ${fullLadder.totalReservedQuantity}, above the currently owned remainder ${ownedRemainder}.`)]
        : fullLadder.reasons,
    };
  }
  return {
    mode: "UNPROTECTABLE",
    primaryTargetId: firstTarget?.id || null,
    fullLadder,
    aggregateLadder,
    target: null,
    reasons: [...fullLadder.reasons, ...aggregateLadder.reasons],
  };
}

/**
 * Resolves a SuperATR target against the authoritative venue average fill.
 * The absolute signal-candle price remains a compatibility fallback for
 * older queued commands, but certified commands carry their ATR/percentage
 * formula so a next-open gap cannot shift every live target incorrectly.
 */
export function resolveStrategyTakeProfitPrice(payload, position) {
  const direction = String(payload?.direction || position?.direction || "").toLowerCase();
  const averagePrice = positive(position?.averagePrice ?? position?.average_price);
  const basis = String(payload?.targetBasis || payload?.basis || "").toUpperCase();
  const value = positive(payload?.targetValue ?? payload?.value);
  const sign = direction === "short" ? -1 : direction === "long" ? 1 : 0;

  if (averagePrice && sign && basis === "PERCENT" && value) {
    return averagePrice * (1 + sign * value / 100);
  }

  const atrValue = positive(payload?.targetAtrValue ?? payload?.atrValue);
  if (averagePrice && sign && basis === "ATR" && value && atrValue) {
    return averagePrice + sign * value * atrValue;
  }

  return positive(payload?.targetPrice);
}

function normalizeQuantityPrecision(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 12 ? parsed : null;
}

function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  if (!text.includes("e")) return (text.split(".")[1] || "").length;
  const [coefficient, exponentText] = text.split("e");
  const exponent = Number(exponentText);
  const fractional = (coefficient.split(".")[1] || "").length;
  return Math.max(0, fractional - exponent);
}

function reason(code, targetId, message) {
  return { code, targetId, message };
}
