import type { BclifHealthState } from "../collector/health.ts";
import type { BclifMetricRegistry } from "./registry.ts";

export function bclifDiagnostics(health: BclifHealthState, metrics: BclifMetricRegistry) {
  return { ...health.snapshot(), metrics: metrics.snapshot() };
}
