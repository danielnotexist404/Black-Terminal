import type { BclifMetricRegistry } from "../metrics/registry.ts";
import {
  BclifCalibrationRepository,
  type BclifCalibrationStatus,
  type BclifCascadeModelState,
  type BclifClusterPredictionInput,
  type BclifPendingPrediction
} from "../state/calibrationRepository.ts";
import type { BclifModelColumn } from "../tiles/tileBuilder.ts";

const PREDICTION_CADENCE_MS = 15 * 60_000;
const EVALUATION_HORIZON_MS = 6 * 60 * 60_000;

export class BclifCalibrationRuntime {
  private sampleCount = 0;
  private cascadeState: BclifCascadeModelState = "SCAFFOLDED";
  private report: BclifCalibrationStatus | null = null;

  private readonly repository: BclifCalibrationRepository;
  private readonly metrics: BclifMetricRegistry;
  constructor(repository: BclifCalibrationRepository, metrics: BclifMetricRegistry) { this.repository = repository; this.metrics = metrics; }

  async observeColumn(input: {
    column: BclifModelColumn;
    minPrice: number;
    priceStep: number;
    modelVersion: string;
    createdAt?: number;
  }) {
    const cutoff = input.column.timestamp;
    if (cutoff % PREDICTION_CADENCE_MS !== 0) return 0;
    // The model-column cutoff is the deterministic logical creation time.
    // Using wall-clock insert time would make a crash retry conflict with the
    // immutable deterministic prediction identity.
    const createdAt = cutoff;
    const predictions = deriveMeaningfulClusterPredictions(input.column, input.minPrice, input.priceStep, input.modelVersion, createdAt);
    for (const prediction of predictions) await this.repository.recordPrediction(prediction);
    this.metrics.counter("bclif_calibration_predictions_total", "Immutable meaningful BCLIF cluster predictions recorded.", predictions.length);
    return predictions.length;
  }

  async evaluate(now = Date.now()) {
    const pending = await this.repository.loadUnevaluated();
    if (!pending.length) return this.refresh();
    const start = Math.min(...pending.map((prediction) => prediction.createdAt));
    const events = await this.repository.observedEvents(start, now);
    let outcomes = 0;
    for (const prediction of pending) {
      const eligible = events.filter((event) => event.eventTime >= prediction.sourceCutoffTimestamp && event.receivedAt >= prediction.createdAt && event.receivedAt <= Math.min(now, prediction.createdAt + EVALUATION_HORIZON_MS));
      const expectedSide = prediction.predictedSide === "LONG_LIQUIDATION" ? "LONG" : "SHORT";
      const matches = eligible.filter((event) => event.side === expectedSide && event.price >= prediction.priceMin && event.price <= prediction.priceMax);
      if (!matches.length && now < prediction.createdAt + EVALUATION_HORIZON_MS) continue;
      if (matches.length) {
        const notional = matches.reduce((total, event) => total + event.notional, 0);
        const center = (prediction.priceMin + prediction.priceMax) / 2;
        const earliest = matches.reduce((first, event) => event.receivedAt < first.receivedAt ? event : first);
        await this.repository.recordOutcome({
          predictionId: prediction.id,
          evaluatedAt: Math.min(now, earliest.receivedAt),
          confirmedEventOverlap: Math.min(1, notional / Math.max(1, prediction.notionalMin)),
          priceError: Math.min(...matches.map((event) => Math.abs(event.price - center))),
          timingErrorMs: Math.max(0, earliest.receivedAt - prediction.createdAt),
          outcome: "HIT",
          observedSampleCount: eligible.length,
          immutableEvidence: {
            evaluationScope: "CLUSTER",
            evaluationHorizonMs: EVALUATION_HORIZON_MS,
            matchedObservedEventIds: matches.slice(0, 100).map((event) => event.id),
            matchedObservedNotional: notional,
            truncatedEvidence: matches.length > 100
          }
        });
      } else {
        await this.repository.recordOutcome({
          predictionId: prediction.id,
          evaluatedAt: prediction.createdAt + EVALUATION_HORIZON_MS,
          confirmedEventOverlap: 0,
          priceError: null,
          timingErrorMs: null,
          outcome: "FALSE_POSITIVE",
          observedSampleCount: eligible.length,
          immutableEvidence: { evaluationScope: "CLUSTER", evaluationHorizonMs: EVALUATION_HORIZON_MS, observedEventsInWindow: eligible.length }
        });
      }
      outcomes += 1;
    }
    this.metrics.counter("bclif_calibration_outcomes_total", "Immutable BCLIF prediction outcomes recorded.", outcomes);
    return this.refresh();
  }

  async refresh() {
    const status = await this.repository.status();
    this.sampleCount = status.observedSampleCount;
    this.cascadeState = status.cascadeState;
    this.report = status;
    this.metrics.gauge("bclif_calibration_observed_samples", "Immutable prediction/outcome observations available to calibration.", status.observedSampleCount);
    this.metrics.gauge("bclif_calibration_evaluations", "Immutable prediction evaluations available to calibration.", status.evaluationCount);
    for (const [name, value] of [
      ["bclif_calibration_hit_rate", status.hitRate],
      ["bclif_calibration_false_positive_rate", status.falsePositiveRate],
      ["bclif_calibration_missed_rate", status.missedRate],
      ["bclif_calibration_price_error_mean", status.meanPriceError],
      ["bclif_calibration_price_error_median", status.medianPriceError],
      ["bclif_calibration_timing_error_ms_mean", status.meanTimingErrorMs],
      ["bclif_calibration_confidence_error", status.confidenceCalibrationError],
      ["bclif_cascade_precision", status.cascadePrecision],
      ["bclif_cascade_recall", status.cascadeRecall],
      ["bclif_absorption_accuracy", status.absorptionAccuracy]
    ] as const) if (value !== null) this.metrics.gauge(name, "Truthful immutable BCLIF calibration metric; absent until measurable.", value);
    this.metrics.gauge("bclif_cascade_certified", "Whether cascade calibration has completed formal certification.", status.cascadeState === "CERTIFIED" ? 1 : 0);
    return this.status();
  }

  status() { return this.report || { sampleCount: this.sampleCount, cascadeState: this.cascadeState }; }
}

export function deriveMeaningfulClusterPredictions(
  column: BclifModelColumn,
  minPrice: number,
  priceStep: number,
  modelVersion: string,
  createdAt: number
): BclifClusterPredictionInput[] {
  if (!(minPrice > 0) || !(priceStep > 0) || !modelVersion || createdAt < column.timestamp) throw new Error("Invalid BCLIF calibration prediction context");
  const output: BclifClusterPredictionInput[] = [];
  for (const [values, predictedSide] of [
    [column.longExposure, "LONG_LIQUIDATION"],
    [column.shortExposure, "SHORT_LIQUIDATION"]
  ] as const) {
    const positive = [...values].filter((value, row) => value > 0 && column.validity[row] === 1).sort((a, b) => a - b);
    if (!positive.length) continue;
    const maximum = positive.at(-1)!;
    const threshold = Math.max(maximum * 0.55, quantile(positive, 0.9));
    const regions: Array<{ start: number; end: number; notional: number; peak: number }> = [];
    for (let row = 0; row < values.length;) {
      if (!column.validity[row] || values[row]! < threshold) { row += 1; continue; }
      const start = row;
      let notional = 0;
      let peak = 0;
      while (row < values.length && column.validity[row] && values[row]! >= threshold) {
        notional += values[row]!;
        peak = Math.max(peak, values[row]!);
        row += 1;
      }
      regions.push({ start, end: row - 1, notional, peak });
    }
    for (const region of regions.sort((left, right) => right.notional - left.notional || right.peak - left.peak).slice(0, 2)) {
      const confidences = Array.from(column.confidence.slice(region.start, region.end + 1));
      const confidence = confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, confidences.length) / 255;
      if (!(region.notional > 0) || confidence < 0.2) continue;
      output.push({
        modelVersion,
        sourceCutoffTimestamp: column.timestamp,
        createdAt,
        priceMin: Math.max(Number.MIN_VALUE, minPrice + (region.start - 0.5) * priceStep),
        priceMax: minPrice + (region.end + 0.5) * priceStep,
        notionalMin: region.notional * 0.75,
        notionalMax: region.notional * 1.25,
        confidence,
        leveragePrior: "VERSIONED_BYBIT_RISK_TIER_MIX",
        marginModeUncertainty: 0.45,
        predictedSide,
        immutableContext: {
          evaluationScope: "CLUSTER",
          evaluationHorizonMs: EVALUATION_HORIZON_MS,
          rowStart: region.start,
          rowEnd: region.end,
          peakExposure: region.peak,
          selection: "CAUSAL_TOP_DECILE_AND_55_PERCENT_PEAK",
          cascadeEvaluation: false
        }
      });
    }
  }
  return output;
}

function quantile(sorted: readonly number[], q: number) {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! * (1 - (position - lower)) + sorted[upper]! * (position - lower);
}

export function calibrationEvaluationHorizonMs() { return EVALUATION_HORIZON_MS; }
export function calibrationPredictionCadenceMs() { return PREDICTION_CADENCE_MS; }
export type { BclifPendingPrediction };
