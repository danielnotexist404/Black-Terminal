import { createId } from "../core/ids";
import { blackCoreEventBus } from "../core/blackCore";
import { blackCoreConnectionAudit } from "./connectionAudit";
import type { ConnectivityEvent } from "./connectionEvents";
import type { ConnectRequest, ConnectionAdapter, ConnectionDiagnostics, ConnectionRecord, ConnectionSubscription } from "./types";

type ConnectionListener = (diagnostics: ConnectionDiagnostics[]) => void;

export class ConnectionManager {
  private adapters = new Map<string, ConnectionAdapter>();
  private connections = new Map<string, ConnectionRecord>();
  private subscriptions = new Map<string, ConnectionSubscription[]>();
  private heartbeatTimers = new Map<string, number>();
  private listeners = new Set<ConnectionListener>();

  registerAdapter(adapter: ConnectionAdapter) {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(adapterId: string) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Connection adapter not registered: ${adapterId}`);
    return adapter;
  }

  listAdapters() {
    return Array.from(this.adapters.values());
  }

  async connect(request: ConnectRequest) {
    const adapter = this.getAdapter(request.adapterId);
    const startedAt = Date.now();
    const connection = await adapter.connect(request);
    const next: ConnectionRecord = {
      ...connection,
      id: connection.id || createId("conn"),
      adapterId: adapter.id,
      category: adapter.category,
      status: connection.status || "connected",
      capabilities: connection.capabilities.length ? connection.capabilities : adapter.capabilities,
      health: {
        ...connection.health,
        latencyMs: connection.health.latencyMs || Date.now() - startedAt,
        status: connection.status || connection.health.status,
        lastSuccessfulHeartbeat: Date.now()
      },
      createdAt: connection.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    this.connections.set(next.id, next);
    this.emit({
      type: "connection.established",
      connectionId: next.id,
      provider: next.provider,
      category: next.category,
      time: Date.now(),
      health: next.health,
      diagnostics: this.toDiagnostics(next),
      message: `${next.label} connected.`
    });
    this.startHeartbeat(next.id);
    this.notify();
    return next;
  }

  upsertExternalConnection(connection: ConnectionRecord) {
    const next: ConnectionRecord = {
      ...connection,
      status: connection.status || "connected",
      health: {
        ...connection.health,
        status: connection.status || connection.health.status,
        lastSuccessfulHeartbeat: Date.now()
      },
      createdAt: connection.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    this.connections.set(next.id, next);
    this.emit({
      type: "connection.established",
      connectionId: next.id,
      provider: next.provider,
      category: next.category,
      time: Date.now(),
      health: next.health,
      diagnostics: this.toDiagnostics(next),
      message: `${next.label} connected.`
    });
    this.startHeartbeat(next.id);
    this.notify();
    return next;
  }

  async disconnect(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const adapter = this.getAdapter(connection.adapterId);
    await adapter.disconnect(connection);
    this.stopHeartbeat(connectionId);
    this.connections.delete(connectionId);
    this.emit({
      type: "connection.removed",
      connectionId,
      provider: connection.provider,
      category: connection.category,
      time: Date.now(),
      message: `${connection.label} disconnected.`
    });
    this.notify();
  }

  async reconnect(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    const adapter = this.getAdapter(connection.adapterId);
    const reconnecting = this.patchConnection(connectionId, {
      status: "reconnecting",
      health: {
        ...connection.health,
        status: "reconnecting",
        reconnectCount: connection.health.reconnectCount + 1
      }
    });
    if (!reconnecting) return null;
    this.emit({
      type: "connection.reconnect",
      connectionId,
      provider: reconnecting.provider,
      category: reconnecting.category,
      time: Date.now(),
      health: reconnecting.health
    });

    const restored = adapter.reconnect ? await adapter.reconnect(reconnecting) : await adapter.connect({
      adapterId: reconnecting.adapterId,
      category: reconnecting.category,
      provider: reconnecting.provider,
      label: reconnecting.label,
      metadata: reconnecting.metadata
    });
    const next = this.patchConnection(connectionId, {
      ...restored,
      id: connectionId,
      health: {
        ...restored.health,
        reconnectCount: reconnecting.health.reconnectCount,
        lastSuccessfulHeartbeat: Date.now()
      },
      updatedAt: Date.now()
    });
    if (next) {
      this.emit({
        type: "connection.restored",
        connectionId,
        provider: next.provider,
        category: next.category,
        time: Date.now(),
        health: next.health
      });
      this.notify();
    }
    return next;
  }

  async heartbeat(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    const adapter = this.getAdapter(connection.adapterId);

    try {
      const health = await adapter.heartbeat(connection);
      const next = this.patchConnection(connectionId, {
        status: health.status,
        health: {
          ...connection.health,
          ...health,
          heartbeat: "ok",
          lastSuccessfulHeartbeat: Date.now()
        }
      });
      if (next) {
        this.emit({
          type: "connection.healthChanged",
          connectionId,
          provider: next.provider,
          category: next.category,
          time: Date.now(),
          health: next.health,
          diagnostics: this.toDiagnostics(next)
        });
        this.notify();
      }
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.patchConnection(connectionId, {
        status: "degraded",
        health: {
          ...connection.health,
          status: "degraded",
          heartbeat: "failed",
          lastError: message
        }
      });
      if (failed) {
        this.emit({
          type: "connection.heartbeatFailed",
          connectionId,
          provider: failed.provider,
          category: failed.category,
          time: Date.now(),
          health: failed.health,
          message
        }, "warning");
        void this.reconnect(connectionId);
      }
      this.notify();
      return failed;
    }
  }

  async subscribeConnection(connectionId: string, subscription: ConnectionSubscription) {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);
    const adapter = this.getAdapter(connection.adapterId);
    await adapter.subscribe?.(connection, subscription);
    const list = this.subscriptions.get(connectionId) ?? [];
    this.subscriptions.set(connectionId, [subscription, ...list.filter((item) => item.id !== subscription.id)]);
    this.patchConnection(connectionId, {
      health: {
        ...connection.health,
        subscriptionCount: this.subscriptions.get(connectionId)?.length ?? 0
      }
    });
    this.notify();
  }

  async unsubscribeConnection(connectionId: string, subscriptionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const adapter = this.getAdapter(connection.adapterId);
    await adapter.unsubscribe?.(connection, subscriptionId);
    const nextSubscriptions = (this.subscriptions.get(connectionId) ?? []).filter((item) => item.id !== subscriptionId);
    this.subscriptions.set(connectionId, nextSubscriptions);
    this.patchConnection(connectionId, {
      health: {
        ...connection.health,
        subscriptionCount: nextSubscriptions.length
      }
    });
    this.notify();
  }

  getConnection(connectionId: string) {
    return this.connections.get(connectionId) ?? null;
  }

  findConnectionByAccount(accountId: string) {
    return Array.from(this.connections.values()).find((connection) => connection.accountId === accountId) ?? null;
  }

  listConnections() {
    return Array.from(this.connections.values());
  }

  listDiagnostics() {
    return this.listConnections().map((connection) => this.toDiagnostics(connection));
  }

  subscribe(listener: ConnectionListener) {
    this.listeners.add(listener);
    listener(this.listDiagnostics());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private patchConnection(connectionId: string, patch: Partial<ConnectionRecord>) {
    const current = this.connections.get(connectionId);
    if (!current) return null;
    const next: ConnectionRecord = {
      ...current,
      ...patch,
      health: patch.health ?? current.health,
      updatedAt: Date.now()
    };
    this.connections.set(connectionId, next);
    return next;
  }

  private startHeartbeat(connectionId: string) {
    this.stopHeartbeat(connectionId);
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      void this.heartbeat(connectionId);
    }, 30000);
    this.heartbeatTimers.set(connectionId, timer);
  }

  private stopHeartbeat(connectionId: string) {
    const timer = this.heartbeatTimers.get(connectionId);
    if (typeof window !== "undefined" && timer) window.clearInterval(timer);
    this.heartbeatTimers.delete(connectionId);
  }

  private toDiagnostics(connection: ConnectionRecord): ConnectionDiagnostics {
    return {
      ...connection,
      uptimeMs: Date.now() - connection.createdAt
    };
  }

  private emit(event: ConnectivityEvent, severity: "info" | "warning" | "error" = "info") {
    blackCoreConnectionAudit.append(event, severity);
    blackCoreEventBus.publish("connectivity.event", event);
  }

  private notify() {
    const diagnostics = this.listDiagnostics();
    for (const listener of this.listeners) listener(diagnostics);
  }
}

export const blackCoreConnectionManager = new ConnectionManager();
