import type { QalcClockState } from "./contracts.ts";

export type QalcClockSample = {
  state: QalcClockState;
  offsetMs: number;
  driftMsPerMinute: number;
  roundTripMs: number;
  sampledAt: number;
  reason?: string;
};

export class QalcClockMonitor {
  private readonly safeOffsetMs: number;
  private readonly degradedOffsetMs: number;
  private readonly safeDriftMsPerMinute: number;
  private readonly maximumSampleAgeMs: number;
  private samples: Array<{ localMidpoint: number; offset: number; roundTrip: number }> = [];
  private last: QalcClockSample = {
    state: "CLOCK_UNSAFE",
    offsetMs: Number.POSITIVE_INFINITY,
    driftMsPerMinute: Number.POSITIVE_INFINITY,
    roundTripMs: Number.POSITIVE_INFINITY,
    sampledAt: 0,
    reason: "NO_CLOCK_SAMPLE",
  };

  constructor(safeOffsetMs = 100, degradedOffsetMs = 250, safeDriftMsPerMinute = 20, maximumSampleAgeMs = 30_000) {
    this.safeOffsetMs = safeOffsetMs;
    this.degradedOffsetMs = degradedOffsetMs;
    this.safeDriftMsPerMinute = safeDriftMsPerMinute;
    this.maximumSampleAgeMs = maximumSampleAgeMs;
  }

  observe(serverTimeMs: number, requestSentAt: number, responseReceivedAt: number): QalcClockSample {
    const roundTrip = Math.max(0, responseReceivedAt - requestSentAt);
    const localMidpoint = requestSentAt + roundTrip / 2;
    const offset = serverTimeMs - localMidpoint;
    this.samples.push({ localMidpoint, offset, roundTrip });
    if (this.samples.length > 12) this.samples.shift();
    const drift = calculateDrift(this.samples);
    const absoluteOffset = Math.abs(offset);
    const state: QalcClockState = absoluteOffset <= this.safeOffsetMs && Math.abs(drift) <= this.safeDriftMsPerMinute
      ? "CLOCK_SAFE"
      : absoluteOffset <= this.degradedOffsetMs && roundTrip <= 1_000
        ? "CLOCK_DEGRADED"
        : "CLOCK_UNSAFE";
    this.last = { state, offsetMs: offset, driftMsPerMinute: drift, roundTripMs: roundTrip, sampledAt: responseReceivedAt, reason: state === "CLOCK_SAFE" ? undefined : "CLOCK_OFFSET_OR_DRIFT_OUTSIDE_SAFE_BOUND" };
    return this.last;
  }

  status(now = Date.now()): QalcClockSample {
    if (!this.last.sampledAt || now - this.last.sampledAt > this.maximumSampleAgeMs) {
      return { ...this.last, state: "CLOCK_UNSAFE", reason: "CLOCK_SAMPLE_STALE" };
    }
    return { ...this.last };
  }

  mayQuote(now = Date.now()) { return this.status(now).state === "CLOCK_SAFE"; }
}

function calculateDrift(samples: Array<{ localMidpoint: number; offset: number }>) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const minutes = (last.localMidpoint - first.localMidpoint) / 60_000;
  return minutes > 0 ? (last.offset - first.offset) / minutes : 0;
}
