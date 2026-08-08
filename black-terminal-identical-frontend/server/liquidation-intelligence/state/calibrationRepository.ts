import type { BclifWriterFence } from "../contracts.ts";
import { validateWriterFence, writerFenceColumns } from "./writerFence.ts";
import { canonicalJson } from "../normalization/canonicalEnvelope.ts";
import { deterministicBclifTileId } from "../tiles/tileBuilder.ts";

export type BclifCascadeModelState = "SCAFFOLDED" | "EXPERIMENTAL" | "CALIBRATING" | "CERTIFIED";

export interface BclifCalibrationStatus {
  predictionCount: number;
  evaluationCount: number;
  observedSampleCount: number;
  cascadeState: BclifCascadeModelState;
  hitCount: number;
  falsePositiveCount: number;
  missedCount: number;
  hitRate: number | null;
  falsePositiveRate: number | null;
  missedRate: number | null;
  meanPriceError: number | null;
  medianPriceError: number | null;
  meanTimingErrorMs: number | null;
  confidenceCalibrationError: number | null;
  cascadePrecision: number | null;
  cascadeRecall: number | null;
  absorptionAccuracy: number | null;
}

export interface BclifClusterPredictionInput {
  modelVersion: string;
  sourceCutoffTimestamp: number;
  createdAt: number;
  priceMin: number;
  priceMax: number;
  notionalMin: number;
  notionalMax: number;
  confidence: number;
  leveragePrior: string;
  marginModeUncertainty: number;
  predictedSide: "LONG_LIQUIDATION" | "SHORT_LIQUIDATION";
  immutableContext?: Record<string, unknown>;
}

export interface BclifClusterOutcomeInput {
  predictionId: string;
  evaluatedAt: number;
  confirmedEventOverlap: number | null;
  priceError: number | null;
  timingErrorMs: number | null;
  outcome: "HIT" | "FALSE_POSITIVE" | "MISSED" | "ABSORBED" | "CONTINUED" | "INCONCLUSIVE";
  observedSampleCount: number;
  immutableEvidence?: Record<string, unknown>;
}

export interface BclifPendingPrediction {
  id: string;
  modelVersion: string;
  sourceCutoffTimestamp: number;
  createdAt: number;
  priceMin: number;
  priceMax: number;
  notionalMin: number;
  notionalMax: number;
  confidence: number;
  predictedSide: BclifClusterPredictionInput["predictedSide"];
  immutableContext: Record<string, unknown>;
}

export interface BclifCalibrationObservedEvent {
  id: string;
  eventTime: number;
  receivedAt: number;
  side: "LONG" | "SHORT";
  price: number;
  notional: number;
}

/** Predictions and outcomes are append-only; future evidence never mutates a forecast. */
export class BclifCalibrationRepository {
  private readonly supabase: any;
  private readonly sourceId: string;
  private readonly fence: BclifWriterFence;
  constructor(supabase: any, sourceId: string, fence: BclifWriterFence) { this.supabase = supabase; this.sourceId = sourceId; this.fence = validateWriterFence(fence); }

  async recordPrediction(input: BclifClusterPredictionInput) {
    if (input.sourceCutoffTimestamp > input.createdAt) throw new Error("BCLIF prediction cutoff cannot be in the future");
    if (!(input.priceMax > input.priceMin) || !(input.notionalMax >= input.notionalMin) || input.notionalMin < 0) throw new Error("Invalid BCLIF prediction range");
    unit(input.confidence, "confidence");
    unit(input.marginModeUncertainty, "margin-mode uncertainty");
    const id = deterministicBclifTileId({
      sourceId: this.sourceId,
      modelVersion: input.modelVersion,
      sourceCutoffTimestamp: input.sourceCutoffTimestamp,
      predictedSide: input.predictedSide,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      notionalMin: input.notionalMin,
      notionalMax: input.notionalMax,
      confidence: input.confidence,
      leveragePrior: input.leveragePrior,
      marginModeUncertainty: input.marginModeUncertainty,
      immutableContext: canonicalJson(input.immutableContext || {})
    });
    const row = {
      id,
      source_id: this.sourceId,
      model_version: input.modelVersion,
      source_cutoff_at: iso(input.sourceCutoffTimestamp),
      created_at: iso(input.createdAt),
      price_min: input.priceMin,
      price_max: input.priceMax,
      notional_min: input.notionalMin,
      notional_max: input.notionalMax,
      confidence: input.confidence,
      leverage_prior: input.leveragePrior,
      margin_mode_uncertainty: input.marginModeUncertainty,
      predicted_side: input.predictedSide,
      cascade_state: "SCAFFOLDED",
      immutable_context: input.immutableContext || {},
      ...writerFenceColumns(this.fence)
    };
    const existing = await this.findPrediction(id);
    if (existing) return this.verifyPrediction(existing, row);
    const result = await this.supabase.from("bclif_cluster_predictions").insert(row).select("id").single();
    if (result.error || !result.data?.id) {
      if (!isUniqueViolation(result.error)) throw result.error || new Error("BCLIF prediction insert returned no ID");
      const raced = await this.findPrediction(id);
      if (!raced) throw result.error;
      return this.verifyPrediction(raced, row);
    }
    return String(result.data.id);
  }

  async hasPredictionsAt(modelVersion: string, sourceCutoffTimestamp: number) {
    const result = await this.supabase.from("bclif_cluster_predictions")
      .select("id", { count: "exact", head: true })
      .eq("source_id", this.sourceId)
      .eq("model_version", modelVersion)
      .eq("source_cutoff_at", iso(sourceCutoffTimestamp));
    if (result.error) throw result.error;
    return (Number(result.count) || 0) > 0;
  }

  async recordOutcome(input: BclifClusterOutcomeInput) {
    if (!input.predictionId) throw new Error("BCLIF outcome requires a prediction ID");
    if (input.confirmedEventOverlap !== null) unit(input.confirmedEventOverlap, "confirmed-event overlap");
    if (!Number.isSafeInteger(input.observedSampleCount) || input.observedSampleCount < 0) throw new Error("Invalid BCLIF observed sample count");
    const row = {
      prediction_id: input.predictionId,
      evaluated_at: iso(input.evaluatedAt),
      confirmed_event_overlap: input.confirmedEventOverlap,
      price_error: finiteOrNull(input.priceError),
      timing_error_ms: finiteOrNull(input.timingErrorMs),
      outcome: input.outcome,
      observed_sample_count: input.observedSampleCount,
      immutable_evidence: input.immutableEvidence || {},
      ...writerFenceColumns(this.fence)
    };
    const existing = await this.supabase.from("bclif_cluster_outcomes")
      .select("id,prediction_id,evaluated_at,confirmed_event_overlap,price_error,timing_error_ms,outcome,observed_sample_count,immutable_evidence")
      .eq("prediction_id", input.predictionId)
      .limit(2);
    if (existing.error) throw existing.error;
    if ((existing.data || []).length > 1) throw new Error("BCLIF prediction has multiple immutable outcomes");
    if (existing.data?.length) return verifyOutcome(existing.data[0], row);
    const result = await this.supabase.from("bclif_cluster_outcomes").insert(row).select("id").single();
    if (result.error || !result.data?.id) {
      if (!isUniqueViolation(result.error)) throw result.error || new Error("BCLIF outcome insert returned no ID");
      const raced = await this.supabase.from("bclif_cluster_outcomes")
        .select("id,prediction_id,evaluated_at,confirmed_event_overlap,price_error,timing_error_ms,outcome,observed_sample_count,immutable_evidence")
        .eq("prediction_id", input.predictionId).limit(2);
      if (raced.error || raced.data?.length !== 1) throw raced.error || result.error || new Error("BCLIF outcome retry could not reconcile");
      return verifyOutcome(raced.data[0], row);
    }
    return String(result.data.id);
  }

  private async findPrediction(id: string) {
    const result = await this.supabase.from("bclif_cluster_predictions")
      .select("id,source_id,model_version,source_cutoff_at,created_at,price_min,price_max,notional_min,notional_max,confidence,leverage_prior,margin_mode_uncertainty,predicted_side,cascade_state,immutable_context")
      .eq("id", id).limit(2);
    if (result.error) throw result.error;
    if ((result.data || []).length > 1) throw new Error("BCLIF deterministic prediction identity is ambiguous");
    return result.data?.[0] || null;
  }

  private verifyPrediction(existing: any, expected: any) {
    for (const field of ["id", "source_id", "model_version", "source_cutoff_at", "created_at", "price_min", "price_max", "notional_min", "notional_max", "confidence", "leverage_prior", "margin_mode_uncertainty", "predicted_side", "cascade_state"] as const) {
      const left = numericPredictionField(field) ? Number(existing[field]) : String(existing[field]);
      const right = numericPredictionField(field) ? Number(expected[field]) : String(expected[field]);
      if (left !== right) throw new Error("BCLIF deterministic prediction retry conflicts with immutable content");
    }
    if (canonicalJson(existing.immutable_context || {}) !== canonicalJson(expected.immutable_context || {})) throw new Error("BCLIF deterministic prediction context conflicts");
    return String(existing.id);
  }

  async loadUnevaluated(limit = 2_000): Promise<BclifPendingPrediction[]> {
    const bounded = Math.max(1, Math.min(20_000, limit));
    const pageSize = 500;
    const maximumScanned = 200_000;
    const pending: BclifPendingPrediction[] = [];
    for (let offset = 0; offset < maximumScanned; offset += pageSize) {
      const predictions = await this.supabase.from("bclif_cluster_predictions")
        .select("id,model_version,source_cutoff_at,created_at,price_min,price_max,notional_min,notional_max,confidence,predicted_side,immutable_context")
        .eq("source_id", this.sourceId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (predictions.error) throw predictions.error;
      const rows = predictions.data || [];
      if (!rows.length) return pending;
      const outcomes = await this.supabase.from("bclif_cluster_outcomes")
        .select("prediction_id")
        .in("prediction_id", rows.map((row: any) => row.id));
      if (outcomes.error) throw outcomes.error;
      const evaluated = new Set<string>((outcomes.data || []).map((outcome: any) => String(outcome.prediction_id)));
      for (const row of rows) {
        if (evaluated.has(String(row.id))) continue;
        pending.push(mapPendingPrediction(row));
        if (pending.length >= bounded) return pending;
      }
      if (rows.length < pageSize) return pending;
    }
    throw Object.assign(new Error("BCLIF calibration scan exceeded its fail-closed prediction bound"), { code: "BCLIF_CALIBRATION_SCAN_BOUND" });
  }

  async observedEvents(start: number, end: number, limit = 50_000): Promise<BclifCalibrationObservedEvent[]> {
    if (!(end >= start)) return [];
    const result = await this.supabase.from("bclif_confirmed_liquidation_events")
      .select("id,event_time,received_at,liquidated_position_side,bankruptcy_price,notional")
      .eq("source_id", this.sourceId)
      .gte("received_at", iso(start))
      .lte("received_at", iso(end))
      .order("received_at", { ascending: true })
      .limit(Math.max(1, Math.min(100_000, limit)));
    if (result.error) throw result.error;
    return (result.data || []).map((row: any) => ({
      id: String(row.id),
      eventTime: Date.parse(String(row.event_time)),
      receivedAt: Date.parse(String(row.received_at)),
      side: row.liquidated_position_side,
      price: Number(row.bankruptcy_price),
      notional: Number(row.notional)
    })).filter((event: BclifCalibrationObservedEvent) => Number.isFinite(event.eventTime) && Number.isFinite(event.receivedAt) && event.price > 0 && event.notional > 0);
  }

  async status(): Promise<BclifCalibrationStatus> {
    const predictions = await this.supabase.from("bclif_cluster_predictions")
      .select("id", { count: "exact", head: true })
      .eq("source_id", this.sourceId);
    if (predictions.error) throw predictions.error;
    const result = await this.supabase.from("bclif_cluster_outcomes")
      .select("outcome,price_error,timing_error_ms,confirmed_event_overlap,observed_sample_count,immutable_evidence,bclif_cluster_predictions!inner(source_id,confidence)")
      .eq("bclif_cluster_predictions.source_id", this.sourceId)
      .order("evaluated_at", { ascending: false })
      .limit(50_000);
    if (result.error) throw result.error;
    const rows = (result.data || []) as any[];
    const evaluationCount = rows.length;
    const observedSampleCount = rows.reduce((total, row) => total + Math.max(0, Number(row.observed_sample_count) || 0), 0);
    const hitCount = count(rows, "HIT");
    const falsePositiveCount = count(rows, "FALSE_POSITIVE");
    const missedCount = count(rows, "MISSED");
    const classified = hitCount + falsePositiveCount + missedCount;
    const priceErrors = finiteValues(rows.map((row) => row.price_error));
    const timingErrors = finiteValues(rows.map((row) => row.timing_error_ms));
    const calibrationErrors = finiteValues(rows.map((row) => {
      const prediction = Array.isArray(row.bclif_cluster_predictions) ? row.bclif_cluster_predictions[0] : row.bclif_cluster_predictions;
      const confidence = Number(prediction?.confidence);
      const observed = nullableFinite(row.confirmed_event_overlap);
      return Number.isFinite(confidence) && observed !== null ? Math.abs(confidence - observed) : null;
    }));
    const absorptionJudgements = rows
      .map((row) => row.immutable_evidence?.absorptionCorrect)
      .filter((value) => typeof value === "boolean") as boolean[];
    const cascadeRows = rows.filter((row) => row.immutable_evidence?.evaluationScope === "CASCADE" || row.immutable_evidence?.cascadeEvaluation === true);
    const cascadeHits = count(cascadeRows, "HIT");
    const cascadeFalsePositives = count(cascadeRows, "FALSE_POSITIVE");
    const cascadeMisses = count(cascadeRows, "MISSED");
    const cascadeClassified = cascadeHits + cascadeFalsePositives + cascadeMisses;
    // Certification is deliberately never inferred from count alone. Generic
    // cluster outcomes must not masquerade as cascade calibration evidence.
    const cascadeState: BclifCascadeModelState = cascadeClassified >= 100 ? "CALIBRATING" : cascadeClassified >= 20 ? "EXPERIMENTAL" : "SCAFFOLDED";
    const cascadeMetricsAvailable = cascadeClassified >= 20;
    return {
      predictionCount: Number(predictions.count) || 0,
      evaluationCount,
      observedSampleCount,
      cascadeState,
      hitCount,
      falsePositiveCount,
      missedCount,
      hitRate: ratio(hitCount, classified),
      falsePositiveRate: ratio(falsePositiveCount, classified),
      // Cluster-centric outcomes can establish hits and false positives, but
      // cannot discover an observed event for which no prediction existed.
      // Keep this unavailable until an event-centric missed-event join exists.
      missedRate: null,
      meanPriceError: mean(priceErrors),
      medianPriceError: median(priceErrors),
      meanTimingErrorMs: mean(timingErrors),
      confidenceCalibrationError: mean(calibrationErrors),
      cascadePrecision: cascadeMetricsAvailable ? ratio(cascadeHits, cascadeHits + cascadeFalsePositives) : null,
      cascadeRecall: cascadeMetricsAvailable ? ratio(cascadeHits, cascadeHits + cascadeMisses) : null,
      absorptionAccuracy: absorptionJudgements.length ? absorptionJudgements.filter(Boolean).length / absorptionJudgements.length : null
    };
  }
}

function mapPendingPrediction(row: any): BclifPendingPrediction {
  return {
    id: String(row.id),
    modelVersion: String(row.model_version),
    sourceCutoffTimestamp: Date.parse(String(row.source_cutoff_at)),
    createdAt: Date.parse(String(row.created_at)),
    priceMin: Number(row.price_min),
    priceMax: Number(row.price_max),
    notionalMin: Number(row.notional_min),
    notionalMax: Number(row.notional_max),
    confidence: Number(row.confidence),
    predictedSide: row.predicted_side,
    immutableContext: row.immutable_context && typeof row.immutable_context === "object" ? { ...row.immutable_context } : {}
  };
}

function count(rows: readonly any[], outcome: string) { return rows.filter((row) => row.outcome === outcome).length; }
function ratio(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator : null; }
function nullableFinite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function finiteValues(values: readonly unknown[]) { return values.map(nullableFinite).filter((value): value is number => value !== null); }
function mean(values: readonly number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values: readonly number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function unit(value: number, label: string) { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid BCLIF ${label}`); }
function finiteOrNull(value: number | null) { if (value === null) return null; if (!Number.isFinite(value)) throw new Error("Invalid BCLIF outcome value"); return value; }
function iso(value: number) { if (!Number.isFinite(value)) throw new Error("Invalid BCLIF timestamp"); return new Date(value).toISOString(); }
function numericPredictionField(field: string) { return ["price_min", "price_max", "notional_min", "notional_max", "confidence", "margin_mode_uncertainty"].includes(field); }
function verifyOutcome(existing: any, expected: any) {
  for (const field of ["prediction_id", "evaluated_at", "outcome", "observed_sample_count"] as const) {
    if (String(existing[field]) !== String(expected[field])) throw new Error("BCLIF immutable outcome retry conflicts");
  }
  for (const field of ["confirmed_event_overlap", "price_error", "timing_error_ms"] as const) {
    if (nullableFinite(existing[field]) !== nullableFinite(expected[field])) throw new Error("BCLIF immutable outcome measurement conflicts");
  }
  if (canonicalJson(existing.immutable_evidence || {}) !== canonicalJson(expected.immutable_evidence || {})) throw new Error("BCLIF immutable outcome evidence conflicts");
  return String(existing.id);
}
function isUniqueViolation(error: any) { return String(error?.code || "") === "23505"; }
