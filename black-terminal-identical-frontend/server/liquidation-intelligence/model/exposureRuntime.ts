import type { ConfirmedLiquidationEvent, LiquidationExposureParticle, LiquidationMarketFrame } from "../../../src/modules/liquidation-field/core/types.ts";
import type { BclifCausalNormalizerState, BclifConfirmedIntensityState } from "../contracts.ts";
import { collectorFrameConfidence } from "./confidenceRuntime.ts";
import type { BclifModelColumn } from "../tiles/tileBuilder.ts";

export class BclifCausalNormalizer {
  private state: BclifCausalNormalizerState;

  constructor(trailingColumns = 64) {
    this.state = { schemaVersion: 1, trailingColumns: Math.max(1, Math.min(512, trailingColumns)), recentLogColumns: [], lastLow: 0, lastHigh: 1e-6 };
  }

  process(exposure: Float32Array, validity: Uint8Array) {
    const values: number[] = [];
    for (let index = 0; index < exposure.length; index += 1) {
      if (!validity[index] || exposure[index]! <= 0) continue;
      values.push(Math.log1p(exposure[index]!));
    }
    values.sort((a, b) => a - b);
    this.state.recentLogColumns.push(values);
    if (this.state.recentLogColumns.length > this.state.trailingColumns) this.state.recentLogColumns.shift();
    const window = this.state.recentLogColumns.flat().sort((a, b) => a - b);
    if (window.length) {
      this.state.lastLow = quantile(window, 0.03);
      this.state.lastHigh = Math.max(this.state.lastLow + 1e-6, quantile(window, 0.997));
    }
    return { low: this.state.lastLow, high: this.state.lastHigh };
  }

  exportState(): BclifCausalNormalizerState { return structuredClone(this.state); }
  importState(state: BclifCausalNormalizerState) {
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.trailingColumns) || state.trailingColumns < 1 || state.trailingColumns > 512) throw new Error("Invalid BCLIF normalizer checkpoint");
    if (!Array.isArray(state.recentLogColumns) || state.recentLogColumns.length > state.trailingColumns) throw new Error("Invalid BCLIF normalizer history");
    const numeric = [state.lastLow, state.lastHigh, ...state.recentLogColumns.flat()];
    if (numeric.some((value) => !Number.isFinite(value)) || !(state.lastHigh > state.lastLow)) throw new Error("Corrupt BCLIF normalizer checkpoint");
    this.state = structuredClone(state);
  }
}

export class BclifExposureRuntime {
  readonly normalizer: BclifCausalNormalizer;
  readonly confirmedNormalizer: BclifConfirmedIntensityNormalizer;
  readonly rows: number;
  readonly minPrice: number;
  readonly priceStep: number;

  constructor(rows: number, minPrice: number, priceStep: number, trailingColumns = 64) {
    this.rows = rows;
    this.minPrice = minPrice;
    this.priceStep = priceStep;
    if (!Number.isSafeInteger(rows) || rows < 16 || rows > 1_024 || !(minPrice > 0) || !(priceStep > 0)) throw new Error("Invalid BCLIF exposure grid");
    this.normalizer = new BclifCausalNormalizer(trailingColumns);
    this.confirmedNormalizer = new BclifConfirmedIntensityNormalizer();
  }

  rasterize(frame: LiquidationMarketFrame, particles: readonly LiquidationExposureParticle[], events: readonly ConfirmedLiquidationEvent[], sourceCutoffTimestamp = frame.timestamp): BclifModelColumn {
    const longExposure = new Float32Array(this.rows);
    const shortExposure = new Float32Array(this.rows);
    for (const particle of particles) {
      // The engine has already synchronized notional to remaining cohort mass.
      // Survival is provenance/state, not a second mass multiplier.
      const effective = particle.notional * particle.weight * particle.confidence;
      if (!(effective > 0)) continue;
      const center = Math.round((particle.liquidationPrice - this.minPrice) / this.priceStep);
      const sigma = Math.max(0.75, particle.liquidationStdDev / this.priceStep);
      const radius = Math.min(this.rows, Math.max(2, Math.ceil(sigma * 3)));
      const target = particle.side === "LONG" ? longExposure : shortExposure;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const row = center + offset;
        if (row < 0 || row >= this.rows) continue;
        target[row] = target[row]! + effective * Math.exp(-0.5 * (offset / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
      }
    }
    const combinedExposure = new Float32Array(this.rows);
    for (let row = 0; row < this.rows; row += 1) combinedExposure[row] = longExposure[row]! + shortExposure[row]!;
    const confidenceValue = collectorFrameConfidence(frame).encoded;
    const confidence = new Uint8Array(this.rows).fill(confidenceValue);
    const valid = frame.certainty.openInterest === "OBSERVED" || frame.certainty.openInterest === "DERIVED";
    const validity = new Uint8Array(this.rows).fill(valid ? 1 : 0);
    const priorEventCutoff = this.confirmedNormalizer.cutoff() ?? -Infinity;
    const frameEvents = events.filter((event) => {
      const knownAt = Math.max(event.timestamp, event.receivedAt);
      return event.timestamp <= frame.timestamp && event.receivedAt <= sourceCutoffTimestamp && knownAt > priorEventCutoff;
    });
    const baseline = Math.max(50_000, frame.openInterest * frame.markPrice * 0.0001);
    const confirmedScale = this.confirmedNormalizer.process(frameEvents, baseline, sourceCutoffTimestamp);
    const { confirmedIntensity, confirmedNotional, confirmedCount } = rasterConfirmed(frameEvents, this.rows, this.minPrice, this.priceStep, confirmedScale);
    const bounds = this.normalizer.process(combinedExposure, validity);
    return {
      timestamp: frame.timestamp,
      longExposure,
      shortExposure,
      combinedExposure,
      confidence,
      validity,
      confirmedIntensity,
      confirmedNotional,
      confirmedCount,
      causalNormalizationLow: bounds.low,
      causalNormalizationHigh: bounds.high
    };
  }
}

export class BclifConfirmedIntensityNormalizer {
  private state: BclifConfirmedIntensityState;
  constructor(maximumSamples = 4_096) {
    this.state = { schemaVersion: 1, maximumSamples, recentLogNotionals: [], lastScale: 50_000, lastProcessedKnownAt: null };
  }
  process(events: readonly ConfirmedLiquidationEvent[], causalFloor: number, sourceCutoffTimestamp: number) {
    if (this.state.lastProcessedKnownAt !== null && sourceCutoffTimestamp <= this.state.lastProcessedKnownAt) throw new Error("BCLIF confirmed-intensity clock must advance");
    const history = [...this.state.recentLogNotionals].sort((a, b) => a - b);
    const historicalScale = history.length ? Math.expm1(quantile(history, 0.995)) : 0;
    const scale = Math.max(1, causalFloor, historicalScale);
    for (const event of events) if (Number.isFinite(event.notional) && event.notional > 0) this.state.recentLogNotionals.push(Math.log1p(event.notional));
    if (this.state.recentLogNotionals.length > this.state.maximumSamples) {
      this.state.recentLogNotionals.splice(0, this.state.recentLogNotionals.length - this.state.maximumSamples);
    }
    this.state.lastScale = scale;
    this.state.lastProcessedKnownAt = sourceCutoffTimestamp;
    return scale;
  }
  cutoff() { return this.state.lastProcessedKnownAt; }
  exportState(): BclifConfirmedIntensityState { return structuredClone(this.state); }
  importState(state: BclifConfirmedIntensityState) {
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.maximumSamples) || state.maximumSamples < 64 || state.maximumSamples > 100_000 || state.recentLogNotionals.length > state.maximumSamples || !(state.lastScale > 0) || (state.lastProcessedKnownAt !== null && !Number.isFinite(state.lastProcessedKnownAt))) {
      throw new Error("Invalid BCLIF confirmed-intensity checkpoint");
    }
    if (state.recentLogNotionals.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Corrupt BCLIF confirmed-intensity checkpoint");
    this.state = structuredClone(state);
  }
}

function rasterConfirmed(events: readonly ConfirmedLiquidationEvent[], rows: number, minPrice: number, priceStep: number, scale: number) {
  const confirmedNotional = new Float32Array(rows);
  const counts = new Uint32Array(rows);
  for (const event of events) {
    const center = Math.round((event.bankruptcyPrice - minPrice) / priceStep);
    if (center < 0 || center >= rows) continue;
    confirmedNotional[center] = confirmedNotional[center]! + event.notional;
    counts[center] = counts[center]! + 1;
  }
  const confirmedCount = new Uint16Array(rows);
  const confirmedIntensity = new Uint8Array(rows);
  for (let row = 0; row < rows; row += 1) {
    if (counts[row]! > 65_535) throw new Error("BCLIF confirmed-event count exceeds lossless Uint16 bound");
    confirmedCount[row] = counts[row]!;
    confirmedIntensity[row] = Math.round(255 * Math.sqrt(Math.min(1, confirmedNotional[row]! / scale)));
  }
  return { confirmedIntensity, confirmedNotional, confirmedCount };
}

function quantile(sorted: readonly number[], q: number) {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! * (1 - (position - lower)) + sorted[upper]! * (position - lower);
}
