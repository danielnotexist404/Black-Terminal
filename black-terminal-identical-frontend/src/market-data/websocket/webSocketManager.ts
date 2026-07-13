import { blackCoreEventBus } from "../../core/blackCore";
import { blackCoreResourceTracker } from "../../performance/resourceTracker";
import type { ExchangeId } from "../types";

type ManagedSocket = {
  url: string;
  exchange: ExchangeId;
  ws: WebSocket;
  subscriptions: Set<string>;
  reconnectCount: number;
  lastMessageAt: number;
  latencyMs: number;
  reconnectTimer: number | null;
  intentionallyClosed: boolean;
  releaseSocket: () => void;
  releaseReconnectTimer: (() => void) | null;
};

export class WebSocketManager {
  private sockets = new Map<string, ManagedSocket>();

  connect(exchange: ExchangeId, url: string) {
    const existing = this.sockets.get(url);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) return existing.ws;
    if (existing?.reconnectTimer !== null && existing?.reconnectTimer !== undefined) {
      window.clearTimeout(existing.reconnectTimer);
      existing.releaseReconnectTimer?.();
    }

    const ws = new WebSocket(url);
    const managed: ManagedSocket = {
      url,
      exchange,
      ws,
      subscriptions: existing?.subscriptions ?? new Set(),
      reconnectCount: existing?.reconnectCount ?? 0,
      lastMessageAt: Date.now(),
      latencyMs: 0,
      reconnectTimer: null,
      intentionallyClosed: false,
      releaseSocket: blackCoreResourceTracker.acquire("websocket", `market-data:${exchange}`),
      releaseReconnectTimer: null
    };
    existing?.releaseSocket();
    this.sockets.set(url, managed);

    ws.onopen = () => {
      managed.reconnectCount = 0;
      blackCoreEventBus.publish("market.connected", { exchange, connectedAt: Date.now() });
      for (const message of managed.subscriptions) ws.send(message);
    };
    ws.onmessage = () => {
      const now = Date.now();
      managed.latencyMs = now - managed.lastMessageAt;
      managed.lastMessageAt = now;
    };
    ws.onclose = () => {
      managed.releaseSocket();
      blackCoreEventBus.publish("market.disconnected", { exchange, disconnectedAt: Date.now(), reason: "socket closed" });
      if (!managed.intentionallyClosed) this.scheduleReconnect(managed);
    };
    ws.onerror = () => {
      blackCoreEventBus.publish("market.error", { exchange, message: `WebSocket failed: ${url}`, reason: "error" });
    };
    return ws;
  }

  subscribe(url: string, message: string) {
    const managed = this.sockets.get(url);
    if (!managed) return;
    managed.subscriptions.add(message);
    if (managed.ws.readyState === WebSocket.OPEN) managed.ws.send(message);
  }

  diagnostics() {
    return Array.from(this.sockets.values()).map((socket) => ({
      exchange: socket.exchange,
      url: socket.url,
      readyState: socket.ws.readyState,
      subscriptions: socket.subscriptions.size,
      reconnectCount: socket.reconnectCount,
      latencyMs: socket.latencyMs,
      lastMessageAt: socket.lastMessageAt,
      staleForMs: Date.now() - socket.lastMessageAt,
      queueLength: socket.ws.bufferedAmount
    }));
  }

  closeAll() {
    for (const socket of this.sockets.values()) {
      socket.intentionallyClosed = true;
      if (socket.reconnectTimer !== null) window.clearTimeout(socket.reconnectTimer);
      socket.releaseReconnectTimer?.();
      socket.releaseSocket();
      socket.ws.close();
    }
    this.sockets.clear();
  }

  private scheduleReconnect(socket: ManagedSocket) {
    if (socket.reconnectTimer !== null || socket.intentionallyClosed) return;
    socket.reconnectCount += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, socket.reconnectCount - 1)) + Math.floor(Math.random() * 250);
    socket.releaseReconnectTimer = blackCoreResourceTracker.acquire("timeout", `market-data:${socket.exchange}:reconnect`);
    socket.reconnectTimer = window.setTimeout(() => {
      socket.reconnectTimer = null;
      socket.releaseReconnectTimer?.();
      socket.releaseReconnectTimer = null;
      if (!socket.intentionallyClosed) this.connect(socket.exchange, socket.url);
    }, delay);
  }
}
