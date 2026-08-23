import {
  BC_RDA_CAUSAL_V2,
  BC_RDA_LEGACY_REPAINTING,
  type DDAProSignalIntegrity,
  type DDAProSignalModelVersion
} from "./types.ts";

/**
 * Versioned source certification. The executable certification harness asserts
 * these claims against the current engine; BC-RDA remains excluded from Alerts
 * and Strategy Lab until a separate headless VPS runtime is certified.
 */
export const BC_RDA_CAUSAL_SOURCE_CERTIFICATION = Object.freeze({
  model: BC_RDA_CAUSAL_V2,
  certificationDate: "2026-08-23",
  engineModes: 2,
  deterministicMarkets: 4,
  deterministicTimeframes: 5,
  deterministicPrefixCases: 180,
  randomTruncations: 100,
  futureAppendCases: 4,
  streamingParityCases: 40,
  reloadParityCases: 40,
  checkpointParityCases: 40,
  finalizedSignalDrift: 0,
  finalizedValueDrift: 0,
  signalTimestampDrift: 0,
  backpaintedExecutionCount: 0,
  lastPrefixTest: "PASS" as const,
  streamingBatchParity: "PASS" as const,
  reloadParity: "PASS" as const,
  checkpointParity: "PASS" as const
});

export const BC_RDA_ALERTS_ELIGIBLE = false;
export const BC_RDA_STRATEGY_ELIGIBLE = false;

export function ddaProSignalIntegrity(model: DDAProSignalModelVersion, lastBarConfirmed: boolean): DDAProSignalIntegrity {
  if (model === BC_RDA_LEGACY_REPAINTING) {
    return {
      model,
      currentBar: lastBarConfirmed ? "FINAL" : "DEVELOPING",
      legacyResearchOnly: true,
      finalizedSignalDrift: -1,
      finalizedValueDrift: -1,
      signalTimestampDrift: -1,
      backpaintedExecutionCount: -1,
      lastPrefixTest: "FAIL",
      streamingBatchParity: "FAIL",
      reloadParity: "FAIL",
      checkpointParity: "FAIL",
      alertEligibility: "BLOCKED",
      strategyEligibility: "BLOCKED",
      statisticsStatus: "INVALIDATED_REPAINTING_SOURCE"
    };
  }
  return {
    ...BC_RDA_CAUSAL_SOURCE_CERTIFICATION,
    currentBar: lastBarConfirmed ? "FINAL" : "DEVELOPING",
    legacyResearchOnly: false,
    alertEligibility: BC_RDA_ALERTS_ELIGIBLE ? "CERTIFIED" : "BLOCKED",
    strategyEligibility: BC_RDA_STRATEGY_ELIGIBLE ? "CERTIFIED" : "BLOCKED",
    statisticsStatus: "CAUSAL_MODEL_ONLY"
  };
}
