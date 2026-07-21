export const CONNECTION_LIFECYCLE = Object.freeze(["CREATED", "VALIDATING", "CONNECTED", "HEALTHY", "DEGRADED", "RECONNECTING", "FAILED", "REVOKED"]);

const transitions = new Map([
  ["CREATED", new Set(["VALIDATING", "REVOKED"])],
  ["VALIDATING", new Set(["CONNECTED", "FAILED", "REVOKED"])],
  ["CONNECTED", new Set(["HEALTHY", "DEGRADED", "RECONNECTING", "FAILED", "REVOKED"])],
  ["HEALTHY", new Set(["DEGRADED", "RECONNECTING", "FAILED", "REVOKED"])],
  ["DEGRADED", new Set(["HEALTHY", "RECONNECTING", "FAILED", "REVOKED"])],
  ["RECONNECTING", new Set(["CONNECTED", "HEALTHY", "FAILED", "REVOKED"])],
  ["FAILED", new Set(["VALIDATING", "RECONNECTING", "REVOKED"])],
  ["REVOKED", new Set()]
]);

export function canTransitionConnection(from, to) {
  return from === to || Boolean(transitions.get(from)?.has(to));
}

export function assertConnectionTransition(from, to) {
  if (!CONNECTION_LIFECYCLE.includes(from) || !CONNECTION_LIFECYCLE.includes(to) || !canTransitionConnection(from, to)) {
    throw Object.assign(new Error(`Invalid broker lifecycle transition: ${from} -> ${to}`), { code: "INVALID_CONNECTION_TRANSITION" });
  }
  return to;
}

export function allowsNewCloudExecution(connection) {
  return connection?.lifecycle_status === "HEALTHY" && (connection?.control_state || "ACTIVE") === "ACTIVE" && ["CLOUD_DELEGATED", "HYBRID"].includes(connection?.connection_mode);
}
