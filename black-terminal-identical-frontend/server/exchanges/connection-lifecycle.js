const TRANSITIONS = Object.freeze({
  DISCONNECTED: ["CONNECTING", "RESTORING"],
  CONNECTING: ["AUTHORIZING", "VALIDATING", "AUTHENTICATION_ERROR", "DISCONNECTED_ERROR"],
  AUTHORIZING: ["VALIDATING", "TOKEN_EXPIRED", "AUTHENTICATION_ERROR", "DISCONNECTED_ERROR"],
  VALIDATING: ["AUTHENTICATED", "PERMISSION_ERROR", "AUTHENTICATION_ERROR", "DISCONNECTED_ERROR"],
  AUTHENTICATED: ["SYNCING", "CONNECTED_READ_ONLY", "EXECUTION_BLOCKED", "DISCONNECTING"],
  SYNCING: ["CONNECTED_READ_ONLY", "CONNECTED_TRADING", "EXECUTION_BLOCKED", "DEGRADED", "DISCONNECTED_ERROR"],
  RESTORING: ["VALIDATING", "SYNCING", "CONNECTED_READ_ONLY", "CONNECTED_TRADING", "EXECUTION_BLOCKED", "DEGRADED", "AUTHENTICATION_ERROR"],
  CONNECTED_READ_ONLY: ["SYNCING", "CONNECTED_TRADING", "DEGRADED", "RECONNECTING", "PERMISSION_ERROR", "DISCONNECTING"],
  CONNECTED_TRADING: ["SYNCING", "CONNECTED_READ_ONLY", "DEGRADED", "RECONNECTING", "PERMISSION_ERROR", "DISCONNECTING"],
  DEGRADED: ["SYNCING", "RECONNECTING", "CONNECTED_READ_ONLY", "CONNECTED_TRADING", "DISCONNECTING", "DISCONNECTED_ERROR"],
  RECONNECTING: ["VALIDATING", "SYNCING", "CONNECTED_READ_ONLY", "CONNECTED_TRADING", "DEGRADED", "AUTHENTICATION_ERROR"],
  TOKEN_EXPIRED: ["AUTHORIZING", "DISCONNECTING"],
  PERMISSION_ERROR: ["VALIDATING", "CONNECTED_READ_ONLY", "DISCONNECTING"],
  AUTHENTICATION_ERROR: ["AUTHORIZING", "VALIDATING", "DISCONNECTING"],
  EXECUTION_BLOCKED: ["SYNCING", "CONNECTED_READ_ONLY", "CONNECTED_TRADING", "DISCONNECTING"],
  DISCONNECTING: ["DISCONNECTED", "DISCONNECTED_ERROR"],
  DISCONNECTED_ERROR: ["CONNECTING", "RESTORING", "DISCONNECTING"]
});

export function canTransitionConnection(from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[String(from || "DISCONNECTED").toUpperCase()]?.includes(String(to || "").toUpperCase()));
}

export function derivePersistedConnectionLifecycle(account, health = null, cloud = null) {
  if (cloud?.revoked_at || cloud?.disabled_at || cloud?.lifecycle_status === "REVOKED") return "DISCONNECTED";
  if (cloud?.credential_state === "EXPIRED" || cloud?.health_status === "AUTH_EXPIRED") return "TOKEN_EXPIRED";
  if (cloud?.credential_state === "REJECTED" || account?.api_health === "failed") return "AUTHENTICATION_ERROR";
  if (cloud?.lifecycle_status === "RECONNECTING" || cloud?.health_status === "RECONCILING") return "RECONNECTING";
  if (cloud?.lifecycle_status === "DEGRADED" || account?.status === "degraded" || health?.readiness === "degraded") return "DEGRADED";
  if (account?.status === "offline") return "DISCONNECTED_ERROR";
  if (!account?.trading_enabled || account?.is_read_only) return "CONNECTED_READ_ONLY";
  if (!account?.last_synced_at) return "SYNCING";
  if (health?.synchronization === "stale" || cloud?.synchronization_state === "STALE") return "DEGRADED";
  if (cloud && cloud.execution_readiness !== "READY") return "EXECUTION_BLOCKED";
  if (health?.private_stream && health.private_stream !== "connected") return "EXECUTION_BLOCKED";
  return "CONNECTED_TRADING";
}

export function lifecycleToClientStatus(lifecycle) {
  switch (String(lifecycle || "").toUpperCase()) {
    case "CONNECTED_TRADING":
    case "CONNECTED_READ_ONLY": return "connected";
    case "RECONNECTING": case "RESTORING": return "reconnecting";
    case "DEGRADED": case "EXECUTION_BLOCKED": case "PERMISSION_ERROR": case "SYNCING": return "degraded";
    case "AUTHENTICATION_ERROR": case "TOKEN_EXPIRED": return "auth-failed";
    case "DISCONNECTED": return "disconnected";
    default: return "offline";
  }
}

export const connectionLifecycleForTests = TRANSITIONS;
