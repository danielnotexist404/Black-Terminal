import { getBybitServerTime } from "../exchanges/bybit.js";

export const WORKER_CLOCK_STATUSES = Object.freeze({
  HEALTHY: "HEALTHY",
  WARNING: "WARNING",
  UNSAFE: "UNSAFE"
});

export function classifyWorkerClockHealth({
  systemTimestamp = Date.now(),
  referenceTimestamp,
  maxDriftMs = 3_000,
  warningDriftMs = Math.max(250, Math.floor(maxDriftMs / 2)),
  source = "bybit-public-time"
} = {}) {
  const system = Number(systemTimestamp);
  const reference = referenceTimestamp == null ? Number.NaN : Number(referenceTimestamp);
  if (!Number.isFinite(system) || !Number.isFinite(reference)) {
    return {
      systemTimestamp: Number.isFinite(system) ? system : Date.now(),
      referenceTimestamp: Number.isFinite(reference) ? reference : null,
      estimatedDriftMs: null,
      maxDriftMs,
      source,
      status: WORKER_CLOCK_STATUSES.UNSAFE,
      checkedAt: new Date().toISOString()
    };
  }
  const estimatedDriftMs = system - reference;
  const absoluteDriftMs = Math.abs(estimatedDriftMs);
  const status = absoluteDriftMs > maxDriftMs
    ? WORKER_CLOCK_STATUSES.UNSAFE
    : absoluteDriftMs > warningDriftMs
      ? WORKER_CLOCK_STATUSES.WARNING
      : WORKER_CLOCK_STATUSES.HEALTHY;
  return {
    systemTimestamp: system,
    referenceTimestamp: reference,
    estimatedDriftMs,
    maxDriftMs,
    source,
    status,
    checkedAt: new Date().toISOString()
  };
}

export async function measureBybitClockHealth({ executionEnvironment, endpointProfile, maxDriftMs } = {}) {
  try {
    const measured = await getBybitServerTime({ executionEnvironment, endpointProfile });
    return classifyWorkerClockHealth({
      systemTimestamp: measured.localTimeMs,
      referenceTimestamp: measured.serverTimeMs,
      maxDriftMs
    });
  } catch {
    return classifyWorkerClockHealth({
      systemTimestamp: Date.now(),
      referenceTimestamp: null,
      maxDriftMs
    });
  }
}
