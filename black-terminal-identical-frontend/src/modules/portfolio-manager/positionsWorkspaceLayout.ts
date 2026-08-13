import type { ConnectionDiagnostics } from "../../connectivity/types";

export const DEFAULT_ORDERS_PANEL_HEIGHT = 132;
export const MIN_ORDERS_PANEL_HEIGHT = 64;
export const MIN_POSITIONS_PANEL_HEIGHT = 64;

export function readOrdersPanelHeight(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MIN_ORDERS_PANEL_HEIGHT
    ? Math.round(parsed)
    : DEFAULT_ORDERS_PANEL_HEIGHT;
}

export function resizeOrdersPanelHeight(
  startingHeight: number,
  pointerDeltaY: number,
  workspaceHeight: number
) {
  const maximum = Math.max(MIN_ORDERS_PANEL_HEIGHT, Math.floor(workspaceHeight - MIN_POSITIONS_PANEL_HEIGHT));
  return Math.min(maximum, Math.max(MIN_ORDERS_PANEL_HEIGHT, Math.round(startingHeight - pointerDeltaY)));
}

export function isAuthenticatedBrokerConnection(
  connection: Pick<ConnectionDiagnostics, "accountId" | "category" | "health" | "status">
) {
  return connection.category === "centralized-exchange" &&
    Boolean(connection.accountId) &&
    connection.health.authentication === "authenticated" &&
    !["connecting", "reconnecting", "auth-failed", "disconnecting", "disconnected", "offline", "unsupported"].includes(connection.status);
}
