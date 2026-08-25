const MINIMUM_TOPIC_FRESHNESS_MS = 45_000;

/**
 * Transport pongs only prove that the websocket is open. They do not prove
 * that an individual subscribed data topic is still delivering observations.
 */
export function isBclifTradeTopicFresh(
  lastTradeAt: number | null,
  evaluatedAt: number,
  frameCadenceMs: number
) {
  if (!Number.isFinite(lastTradeAt) || !Number.isFinite(evaluatedAt)) return false;
  const maximumAgeMs = Math.max(MINIMUM_TOPIC_FRESHNESS_MS, Math.max(1_000, frameCadenceMs) * 3);
  const ageMs = evaluatedAt - Number(lastTradeAt);
  return ageMs >= 0 && ageMs <= maximumAgeMs;
}

