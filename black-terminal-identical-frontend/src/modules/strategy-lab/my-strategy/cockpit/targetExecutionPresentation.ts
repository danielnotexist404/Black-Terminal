import type { StrategyTargetSnapshot } from "../../automation/strategyAutomation.types";

const FAILED_EXECUTION_STATUSES = new Set(["FAILED", "REJECTED", "DEAD_LETTER", "CANCELLED"]);
const BROKER_PREFLIGHT_NO_SUBMISSION_CODES = new Set([
  "STRATEGY_QUANTITY_BELOW_VENUE_STEP",
  "STRATEGY_TP_LADDER_BELOW_VENUE_MINIMUM",
]);

export type TargetExecutionFailure = {
  status: string;
  action: string;
  direction: string;
  occurredAt: string;
  errorCode: string;
  errorMessage: string;
  noVenueOrderSubmitted: boolean;
};

export function targetExecutionFailure(snapshot?: StrategyTargetSnapshot): TargetExecutionFailure | null {
  const status = normalized(snapshot?.latestExecutionStatus);
  if (!FAILED_EXECUTION_STATUSES.has(status)) return null;
  const errorCode = normalized(snapshot?.latestExecutionErrorCode);
  return {
    status,
    action: normalized(snapshot?.latestExecutionAction),
    direction: normalized(snapshot?.latestExecutionDirection),
    occurredAt: formatExecutionTime(snapshot?.latestExecutionAt),
    errorCode,
    errorMessage: snapshot?.latestExecutionErrorMessage?.trim() || "The broker execution preflight rejected this strategy command.",
    noVenueOrderSubmitted: snapshot?.latestExecutionVenueOrderSubmitted === false
      || (snapshot?.latestExecutionVenueOrderSubmitted === undefined && BROKER_PREFLIGHT_NO_SUBMISSION_CODES.has(errorCode)),
  };
}

export function formatExecutionTime(value?: number | string): string {
  if (value === undefined || value === null || value === "") return "TIME UNAVAILABLE";
  const parsed = typeof value === "number"
    ? new Date(Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function normalized(value?: string): string {
  return value?.trim().toUpperCase() || "";
}
