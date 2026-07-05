import type { ConnectivityAuditEvent, ConnectivityEvent } from "./connectionEvents";

class ConnectionAuditBuffer {
  private events: ConnectivityAuditEvent[] = [];

  append(event: ConnectivityEvent, severity: ConnectivityAuditEvent["severity"] = "info") {
    this.events = [
      {
        id: `${event.connectionId}-${event.time}-${event.type}`,
        connectionId: event.connectionId,
        eventType: event.type,
        severity,
        message: "message" in event && event.message ? event.message : event.type,
        metadata: event.metadata,
        createdAt: event.time
      },
      ...this.events
    ].slice(0, 500);
  }

  list() {
    return [...this.events];
  }
}

export const blackCoreConnectionAudit = new ConnectionAuditBuffer();
