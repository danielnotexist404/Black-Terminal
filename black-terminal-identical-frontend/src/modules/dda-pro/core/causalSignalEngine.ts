import type { Candle } from "../../../chart-engine/types.ts";
import {
  BC_RDA_CAUSAL_V2,
  DDA_PRO_INDICATOR_ID,
  type DDAProRiskState,
  type DDAProSignalEvent,
  type DDAProSettings
} from "./types.ts";

export type CausalRdaSignalFrame = {
  index: number;
  time: number;
  close: number;
  depth: number;
  velocity: number;
  riskState?: DDAProRiskState;
  percentileRank?: number;
  p50?: number;
  p95?: number;
  p99?: number;
};

export type CausalRdaSignalMachineCheckpoint = {
  version: typeof BC_RDA_CAUSAL_V2;
  settingsHash: string;
  timeframeSeconds: number;
  hashState: number;
  active: boolean;
  candidateIndex: number;
  candidateTimestamp: number;
  candidatePrice: number;
  anchorIndex: number;
  anchorTimestamp: number;
  anchorPrice: number;
  anchorDepth: number;
  recoveryStreak: number;
  longEmitted: boolean;
  shortArmed: boolean;
  shortCandidateIndex: number;
  shortCandidateTimestamp: number;
  shortCandidatePrice: number;
  shortAnchorIndex: number;
  shortAnchorTimestamp: number;
  shortAnchorPrice: number;
  shortRolloverStreak: number;
  shortRolloverDepth: number;
  previousDepth: number;
};

type MachineConfig = {
  episodeThresholdPercent: number;
  confirmationBars: number;
  timeframeSeconds: number;
  settingsHash: string;
  signalContext?: { exchange: string; symbol: string; timeframe: string };
};

const clean = (value: string) => value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "unknown";

function updateHash(state: number, value: string) {
  let hash = state >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export class CausalRdaSignalMachine {
  private readonly config: MachineConfig;
  private hashState = 0x811c9dc5;
  private active = false;
  private candidateIndex = -1;
  private candidateTimestamp = 0;
  private candidatePrice = 0;
  private anchorIndex = -1;
  private anchorTimestamp = 0;
  private anchorPrice = 0;
  private anchorDepth = 0;
  private recoveryStreak = 0;
  private longEmitted = false;
  private shortArmed = false;
  private shortCandidateIndex = -1;
  private shortCandidateTimestamp = 0;
  private shortCandidatePrice = 0;
  private shortAnchorIndex = -1;
  private shortAnchorTimestamp = 0;
  private shortAnchorPrice = 0;
  private shortRolloverStreak = 0;
  private shortRolloverDepth = 0;
  private previousDepth = 0;

  constructor(config: MachineConfig, checkpoint?: CausalRdaSignalMachineCheckpoint) {
    this.config = config;
    if (!checkpoint) return;
    if (checkpoint.version !== BC_RDA_CAUSAL_V2) throw new Error("BC_RDA_CHECKPOINT_VERSION_MISMATCH");
    if (checkpoint.settingsHash !== config.settingsHash || checkpoint.timeframeSeconds !== config.timeframeSeconds) {
      throw new Error("BC_RDA_CHECKPOINT_CONFIGURATION_MISMATCH");
    }
    this.hashState = checkpoint.hashState >>> 0;
    this.active = checkpoint.active;
    this.candidateIndex = checkpoint.candidateIndex;
    this.candidateTimestamp = checkpoint.candidateTimestamp;
    this.candidatePrice = checkpoint.candidatePrice;
    this.anchorIndex = checkpoint.anchorIndex;
    this.anchorTimestamp = checkpoint.anchorTimestamp;
    this.anchorPrice = checkpoint.anchorPrice;
    this.anchorDepth = checkpoint.anchorDepth;
    this.recoveryStreak = checkpoint.recoveryStreak;
    this.longEmitted = checkpoint.longEmitted;
    this.shortArmed = checkpoint.shortArmed;
    this.shortCandidateIndex = checkpoint.shortCandidateIndex;
    this.shortCandidateTimestamp = checkpoint.shortCandidateTimestamp;
    this.shortCandidatePrice = checkpoint.shortCandidatePrice;
    this.shortAnchorIndex = checkpoint.shortAnchorIndex;
    this.shortAnchorTimestamp = checkpoint.shortAnchorTimestamp;
    this.shortAnchorPrice = checkpoint.shortAnchorPrice;
    this.shortRolloverStreak = checkpoint.shortRolloverStreak;
    this.shortRolloverDepth = checkpoint.shortRolloverDepth;
    this.previousDepth = checkpoint.previousDepth;
  }

  append(frame: CausalRdaSignalFrame): DDAProSignalEvent[] {
    const depth = Math.max(0, finite(frame.depth));
    const velocity = finite(frame.velocity);
    this.hashState = updateHash(this.hashState, `${frame.index}|${frame.time}|${finite(frame.close).toPrecision(17)}|${depth.toPrecision(17)}|${velocity.toPrecision(17)}|${frame.riskState ?? "INSUFFICIENT"}|${finite(frame.percentileRank ?? 0).toPrecision(17)}|${finite(frame.p50 ?? 0).toPrecision(17)}|${finite(frame.p95 ?? 0).toPrecision(17)}|${finite(frame.p99 ?? 0).toPrecision(17)}|`);
    const emitted: DDAProSignalEvent[] = [];
    const threshold = Math.max(1e-9, this.config.episodeThresholdPercent);
    const recoveryThreshold = Math.max(1e-9, threshold * 0.05);
    const requiredConfirmation = Math.max(1, Math.min(5, Math.round(this.config.confirmationBars)));
    const minimumRollover = Math.max(threshold * 0.25, recoveryThreshold);

    // A Short is not knowable at the recovery/high itself. Full recovery only
    // arms an upper-extreme candidate. The execution marker is emitted later,
    // on the first closed bar that causally confirms a sustained rollover.
    if (this.shortArmed) {
      if (depth <= recoveryThreshold && finite(frame.close) >= this.shortAnchorPrice - 1e-12) {
        this.shortAnchorIndex = frame.index;
        this.shortAnchorTimestamp = frame.time;
        this.shortAnchorPrice = finite(frame.close);
        this.shortRolloverStreak = 0;
        this.shortRolloverDepth = depth;
      } else if (depth > this.previousDepth + 1e-12 && velocity > 1e-12) {
        this.shortRolloverStreak += 1;
        this.shortRolloverDepth = depth;
      } else if (depth <= recoveryThreshold || velocity < -1e-12) {
        this.shortRolloverStreak = 0;
        this.shortRolloverDepth = depth;
      }
      if (this.shortAnchorIndex >= 0 && frame.index > this.shortAnchorIndex &&
          this.shortRolloverStreak >= requiredConfirmation && depth >= minimumRollover) {
        emitted.push(this.finalSignal({
          direction: "short",
          frame,
          candidateIndex: this.shortCandidateIndex,
          candidateTimestamp: this.shortCandidateTimestamp,
          candidatePrice: this.shortCandidatePrice,
          anchorIndex: this.shortAnchorIndex,
          anchorTimestamp: this.shortAnchorTimestamp,
          anchorPrice: this.shortAnchorPrice,
          anchorDepth: 0,
          observedBars: this.shortRolloverStreak,
          requiredBars: requiredConfirmation,
          minimumMovementPercent: minimumRollover,
          cloudState: "ROLLOVER_CONFIRMED"
        }));
        this.clearShortCandidate();
      }
    }
    this.previousDepth = depth;

    if (!this.active) {
      if (depth >= threshold) {
        this.active = true;
        this.candidateIndex = frame.index;
        this.candidateTimestamp = frame.time;
        this.candidatePrice = finite(frame.close);
        this.anchorIndex = frame.index;
        this.anchorTimestamp = frame.time;
        this.anchorPrice = finite(frame.close);
        this.anchorDepth = depth;
        this.recoveryStreak = 0;
        this.longEmitted = false;
      }
      return emitted;
    }

    if (depth > this.anchorDepth + 1e-12) {
      this.anchorIndex = frame.index;
      this.anchorTimestamp = frame.time;
      this.anchorPrice = finite(frame.close);
      this.anchorDepth = depth;
      this.recoveryStreak = 0;
    } else if (velocity < -1e-12 && depth < this.anchorDepth - 1e-12) {
      this.recoveryStreak += 1;
    } else if (velocity > 1e-12) {
      this.recoveryStreak = 0;
    }

    const requiredRecovery = requiredConfirmation;
    const minimumImprovement = Math.max(threshold * 0.25, this.anchorDepth * 0.03);
    if (!this.longEmitted && this.anchorIndex >= 0 && frame.index > this.anchorIndex &&
        this.recoveryStreak >= requiredRecovery && this.anchorDepth - depth >= minimumImprovement) {
      emitted.push(this.finalSignal({
        direction: "long", frame,
        candidateIndex: this.candidateIndex, candidateTimestamp: this.candidateTimestamp, candidatePrice: this.candidatePrice,
        anchorIndex: this.anchorIndex, anchorTimestamp: this.anchorTimestamp, anchorPrice: this.anchorPrice, anchorDepth: this.anchorDepth,
        observedBars: this.recoveryStreak, requiredBars: requiredRecovery, minimumMovementPercent: minimumImprovement,
        cloudState: "RECOVERY_CONFIRMED"
      }));
      this.longEmitted = true;
    }

    if (depth < recoveryThreshold) {
      // A one-bar V recovery still confirms the prior trough, but never emits an
      // opposite-direction execution event on that same confirmation bar.
      if (!this.longEmitted && this.anchorIndex >= 0 && frame.index > this.anchorIndex) {
        emitted.push(this.finalSignal({
          direction: "long", frame,
          candidateIndex: this.candidateIndex, candidateTimestamp: this.candidateTimestamp, candidatePrice: this.candidatePrice,
          anchorIndex: this.anchorIndex, anchorTimestamp: this.anchorTimestamp, anchorPrice: this.anchorPrice, anchorDepth: this.anchorDepth,
          observedBars: this.recoveryStreak, requiredBars: requiredRecovery, minimumMovementPercent: minimumImprovement,
          cloudState: "RECOVERY_CONFIRMED"
        }));
        this.longEmitted = true;
      }
      this.armShortCandidate(frame);
      this.active = false;
      this.candidateIndex = -1;
      this.candidateTimestamp = 0;
      this.candidatePrice = 0;
      this.anchorIndex = -1;
      this.anchorTimestamp = 0;
      this.anchorPrice = 0;
      this.anchorDepth = 0;
      this.recoveryStreak = 0;
      this.longEmitted = false;
    }
    return emitted;
  }

  developingSignals(): DDAProSignalEvent[] {
    const signals: DDAProSignalEvent[] = [];
    const candidate = (isLong: boolean): DDAProSignalEvent => {
      const direction = isLong ? "long" : "short";
      const candidateIndex = isLong ? this.candidateIndex : this.shortCandidateIndex;
      const candidateTimestamp = isLong ? this.candidateTimestamp : this.shortCandidateTimestamp;
      const candidatePrice = isLong ? this.candidatePrice : this.shortCandidatePrice;
      const anchorIndex = isLong ? this.anchorIndex : this.shortAnchorIndex;
      const anchorTimestamp = isLong ? this.anchorTimestamp : this.shortAnchorTimestamp;
      const anchorPrice = isLong ? this.anchorPrice : this.shortAnchorPrice;
      return {
      id: this.signalId(direction, candidateTimestamp, "candidate"),
      indicatorId: DDA_PRO_INDICATOR_ID,
      direction,
      index: anchorIndex,
      time: anchorTimestamp,
      value: isLong ? this.anchorDepth : this.shortRolloverDepth,
      sourceEventType: isLong ? "DDA_DRAWDOWN_DEEPENED" : "DDA_DRAWDOWN_RECOVERED",
      markerTone: isLong ? "silver-white" : "blood-red",
      classification: "provisional",
      lifecycle: "DEVELOPING",
      candidateIndex,
      confirmationIndex: undefined,
      displayAnchorIndex: anchorIndex,
      candidateTimestamp,
      confirmationTimestamp: undefined,
      displayAnchorTimestamp: anchorTimestamp,
      candidatePrice,
      displayAnchorPrice: anchorPrice,
      executionEligibleTimestamp: null,
      confirmationDelayBars: 0,
      finalized: false,
      modelVersion: BC_RDA_CAUSAL_V2,
      settingsHash: this.config.settingsHash,
      dataHash: this.dataHash()
      };
    };
    if (this.active && this.anchorIndex >= 0 && !this.longEmitted) signals.push(candidate(true));
    if (this.shortArmed && this.shortAnchorIndex >= 0) signals.push(candidate(false));
    return signals;
  }

  checkpoint(): CausalRdaSignalMachineCheckpoint {
    return {
      version: BC_RDA_CAUSAL_V2,
      settingsHash: this.config.settingsHash,
      timeframeSeconds: this.config.timeframeSeconds,
      hashState: this.hashState,
      active: this.active,
      candidateIndex: this.candidateIndex,
      candidateTimestamp: this.candidateTimestamp,
      candidatePrice: this.candidatePrice,
      anchorIndex: this.anchorIndex,
      anchorTimestamp: this.anchorTimestamp,
      anchorPrice: this.anchorPrice,
      anchorDepth: this.anchorDepth,
      recoveryStreak: this.recoveryStreak,
      longEmitted: this.longEmitted,
      shortArmed: this.shortArmed,
      shortCandidateIndex: this.shortCandidateIndex,
      shortCandidateTimestamp: this.shortCandidateTimestamp,
      shortCandidatePrice: this.shortCandidatePrice,
      shortAnchorIndex: this.shortAnchorIndex,
      shortAnchorTimestamp: this.shortAnchorTimestamp,
      shortAnchorPrice: this.shortAnchorPrice,
      shortRolloverStreak: this.shortRolloverStreak,
      shortRolloverDepth: this.shortRolloverDepth,
      previousDepth: this.previousDepth
    };
  }

  private finalSignal(input: {
    direction: "long" | "short";
    frame: CausalRdaSignalFrame;
    candidateIndex: number;
    candidateTimestamp: number;
    candidatePrice: number;
    anchorIndex: number;
    anchorTimestamp: number;
    anchorPrice: number;
    anchorDepth: number;
    observedBars: number;
    requiredBars: number;
    minimumMovementPercent: number;
    cloudState: "RECOVERY_CONFIRMED" | "ROLLOVER_CONFIRMED";
  }): DDAProSignalEvent {
    const { direction, frame } = input;
    const recoveryThresholdPercent = Math.max(1e-9, this.config.episodeThresholdPercent * 0.05);
    return {
      id: this.signalId(direction, frame.time, "final"),
      indicatorId: DDA_PRO_INDICATOR_ID,
      direction,
      index: frame.index,
      time: frame.time,
      value: direction === "long" ? input.anchorDepth : Math.max(0, finite(frame.depth)),
      sourceEventType: direction === "long" ? "DDA_DRAWDOWN_DEEPENED" : "DDA_DRAWDOWN_RECOVERED",
      markerTone: direction === "long" ? "silver-white" : "blood-red",
      classification: "confirmed",
      lifecycle: "FINAL",
      candidateIndex: input.candidateIndex,
      confirmationIndex: frame.index,
      displayAnchorIndex: input.anchorIndex,
      candidateTimestamp: input.candidateTimestamp,
      confirmationTimestamp: frame.time,
      displayAnchorTimestamp: input.anchorTimestamp,
      candidatePrice: input.candidatePrice,
      confirmationPrice: finite(frame.close),
      displayAnchorPrice: input.anchorPrice,
      executionEligibleTimestamp: frame.time + Math.max(1, this.config.timeframeSeconds),
      confirmationDelayBars: Math.max(0, frame.index - input.anchorIndex),
      finalized: true,
      modelVersion: BC_RDA_CAUSAL_V2,
      settingsHash: this.config.settingsHash,
      dataHash: this.dataHash(),
      reasonCodes: [direction === "long" ? "CAUSAL_RECOVERY_CONFIRMED" : "CAUSAL_ROLLOVER_CONFIRMED", "SIGNAL_CONFIRMED"],
      causalAudit: {
        confirmationDepth: Math.max(0, finite(frame.depth)),
        confirmationVelocity: finite(frame.velocity),
        anchorDepth: input.anchorDepth,
        percentileRank: finite(frame.percentileRank ?? 0),
        p50: finite(frame.p50 ?? 0),
        p95: finite(frame.p95 ?? 0),
        p99: finite(frame.p99 ?? 0),
        riskState: frame.riskState ?? "INSUFFICIENT",
        cloudState: input.cloudState,
        episodeThresholdPercent: this.config.episodeThresholdPercent,
        recoveryThresholdPercent,
        minimumImprovementPercent: input.minimumMovementPercent,
        requiredRecoveryBars: input.requiredBars,
        observedRecoveryBars: input.observedBars
      }
    };
  }

  private armShortCandidate(frame: CausalRdaSignalFrame) {
    this.shortArmed = true;
    this.shortCandidateIndex = frame.index;
    this.shortCandidateTimestamp = frame.time;
    this.shortCandidatePrice = finite(frame.close);
    this.shortAnchorIndex = frame.index;
    this.shortAnchorTimestamp = frame.time;
    this.shortAnchorPrice = finite(frame.close);
    this.shortRolloverStreak = 0;
    this.shortRolloverDepth = Math.max(0, finite(frame.depth));
  }

  private clearShortCandidate() {
    this.shortArmed = false;
    this.shortCandidateIndex = -1;
    this.shortCandidateTimestamp = 0;
    this.shortCandidatePrice = 0;
    this.shortAnchorIndex = -1;
    this.shortAnchorTimestamp = 0;
    this.shortAnchorPrice = 0;
    this.shortRolloverStreak = 0;
    this.shortRolloverDepth = 0;
  }

  private signalId(direction: "long" | "short", timestamp: number, stage: "candidate" | "final") {
    const context = this.config.signalContext;
    return [
      "bc-rda-causal-v2",
      clean(context?.exchange ?? "market"),
      clean(context?.symbol ?? "unknown"),
      clean(context?.timeframe ?? `${this.config.timeframeSeconds}s`),
      timestamp,
      direction,
      stage
    ].join(":");
  }

  private dataHash() {
    return `fnv1a-${this.hashState.toString(16).padStart(8, "0")}`;
  }
}

export function deriveCausalRdaSignals(input: {
  candles: readonly Candle[];
  depth: readonly number[];
  velocity: readonly number[];
  riskState?: readonly DDAProRiskState[];
  percentileRank?: readonly number[];
  p50?: readonly number[];
  p95?: readonly number[];
  p99?: readonly number[];
  settings: DDAProSettings;
  settingsHash: string;
  timeframeSeconds: number;
  finalizedLength?: number;
  signalContext?: { exchange: string; symbol: string; timeframe: string };
}) {
  const machine = new CausalRdaSignalMachine({
    episodeThresholdPercent: input.settings.drawdownEpisodeThresholdPercent,
    confirmationBars: input.settings.minimumExcursionBars,
    timeframeSeconds: input.timeframeSeconds,
    settingsHash: input.settingsHash,
    signalContext: input.signalContext
  });
  const signals: DDAProSignalEvent[] = [];
  const finalizedLength = Math.max(0, Math.min(input.candles.length, input.finalizedLength ?? input.candles.length));
  for (let index = 0; index < finalizedLength; index++) {
    const candle = input.candles[index]!;
    signals.push(...machine.append({
      index,
      time: candle.time,
      close: candle.close,
      depth: input.depth[index] ?? 0,
      velocity: input.velocity[index] ?? 0,
      riskState: input.riskState?.[index],
      percentileRank: input.percentileRank?.[index],
      p50: input.p50?.[index],
      p95: input.p95?.[index],
      p99: input.p99?.[index]
    }));
  }
  return { signals, developingSignals: machine.developingSignals(), checkpoint: machine.checkpoint() };
}
