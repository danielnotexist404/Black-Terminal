import type { ConnectionDiagnostics, ConnectionHealth, ConnectionRecord } from "./types";

export type ConnectivityEvent =
  | {
      type:
        | "connection.established"
        | "connection.lost"
        | "connection.restored"
        | "connection.heartbeatFailed"
        | "connection.authenticationFailed"
        | "connection.healthChanged"
        | "connection.created"
        | "connection.removed"
        | "connection.reconnect"
        | "connection.permissionChanged"
        | "connection.diagnosticError";
      connectionId: string;
      provider: string;
      category: string;
      time: number;
      health?: ConnectionHealth;
      diagnostics?: ConnectionDiagnostics;
      message?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "connection.accountUpdated" | "connection.positionsUpdated" | "connection.ordersUpdated" | "connection.balancesUpdated";
      connectionId: string;
      provider: string;
      category: string;
      time: number;
      metadata?: Record<string, unknown>;
    };

export type ConnectivityAuditEvent = {
  id: string;
  connectionId: string;
  eventType: ConnectivityEvent["type"];
  severity: "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
};
