import { blackCoreEventBus } from "../../core/blackCore";
import type { ExchangeId } from "../types";

type ManagedSocket = {
  url: string;
  exchange: ExchangeId;
  ws: WebSocket;
  subscriptions: Set<string>;
  reconnectCount: number;
  lastMessageAt: number;
  latencyMs: number;
};

export class WebSocketManager {
  private sockets = new Map<string, ManagedSocket>();

  connect(exchange: ExchangeId, url: string) {
    const existing = this.sockets.get(url);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) return existing.ws;

    const ws = new WebSocket(url);
    const managed: ManagedSocket = {
      url,
      exchange,
      ws,
      subscriptions: new Set(),
      reconnectCount: existing?.reconnectCount ?? 0,
      lastMessageAt: Date.now(),
      latencyMs: 0
    };
    this.sockets.set(url, managed);

    ws.onopen = () => {
      blackCoreEventBus.publish("market.connected", { exchange, connectedAt: Date.now() });
      for (const message of managed.subscriptions) ws.send(message);
    };
    ws.onmessage = () => {
      const now = Date.now();
      managed.latencyMs = now - managed.lastMessageAt;
      managed.lastMessageAt = now;
    };
    ws.onclose = () => {
      blackCoreEventBus.publish("market.disconnected", { exchange, disconnectedAt: Date.now(), reason: "socket closed" });
      this.scheduleReconnect(managed);
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
      queueLength: socket.ws.bufferedAmount
    }));
  }

  closeAll() {
    for (const socket of this.sockets.values()) socket.ws.close();
    this.sockets.clear();
  }

  private scheduleReconnect(socket: ManagedSocket) {
    socket.reconnectCount += 1;
    window.setTimeout(() => this.connect(socket.exchange, socket.url), Math.min(30000, 1000 * socket.reconnectCount));
  }
}
