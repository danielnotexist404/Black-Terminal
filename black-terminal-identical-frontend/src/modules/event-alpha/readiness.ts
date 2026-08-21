import type { EventAlphaHealth, EventAlphaRuntimeConfig } from "./eventAlphaApi";

export type EventAlphaOperationalState =
  | "LOADING"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "WAITING_FOR_SOURCE"
  | "WAITING_FOR_WORKER"
  | "DEGRADED"
  | "ACTIVE";

export type EventAlphaReadiness = {
  state: EventAlphaOperationalState;
  label: string;
  message: string;
  warning: boolean;
};

export function resolveEventAlphaReadiness(input: {
  config: EventAlphaRuntimeConfig | null;
  eventCount: number;
  sources: EventAlphaHealth["sources"];
}): EventAlphaReadiness {
  const { config, eventCount, sources } = input;
  if (!config) return readiness("LOADING", "CHECKING", "Loading Event Alpha server readiness…", false);
  if (!config.engineEnabled) {
    if (eventCount === 0 && sources.length === 0) {
      return readiness(
        "NOT_CONFIGURED",
        "NOT CONFIGURED",
        "Production ingestion is not configured: no source or worker has published Event Alpha evidence.",
        true
      );
    }
    return readiness("DISABLED", "ENGINE OFF", "Engine rollout is disabled. Existing historical evidence remains readable.", true);
  }
  if (!config.ingestionEnabled || !config.tokenSupplyEnabled || !config.tokenUnlockSourceConfigured) {
    return readiness(
      "WAITING_FOR_SOURCE",
      "SOURCE REQUIRED",
      "The engine is enabled, but its credentialed token-unlock source is not ready for ingestion.",
      true
    );
  }
  if (sources.length === 0) {
    return readiness(
      "WAITING_FOR_WORKER",
      "WORKER REQUIRED",
      "The provider is configured, but no persistent worker has registered a source checkpoint.",
      true
    );
  }
  const unhealthy = sources.filter((source) => !["HEALTHY", "DISABLED"].includes(source.health_status));
  if (unhealthy.length > 0) {
    return readiness("DEGRADED", "SOURCE DEGRADED", `Event Alpha has ${unhealthy.length} degraded source${unhealthy.length === 1 ? "" : "s"}.`, true);
  }
  return readiness("ACTIVE", "ENGINE ACTIVE", "Server evidence synchronized from the registered Event Alpha source.", false);
}

function readiness(state: EventAlphaOperationalState, label: string, message: string, warning: boolean): EventAlphaReadiness {
  return { state, label, message, warning };
}
