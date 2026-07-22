import type { ConfirmedLiquidationEvent, LiquidatedPositionSide } from "./ConfirmedLiquidationModel.ts";

type SupportedLiquidationVenue = "bybit" | "binance";

export type ConfirmedLiquidationSubscription = {
  unsubscribe: () => void;
};

function binancePositionSideFromLiquidationOrder(side: string): LiquidatedPositionSide {
  const normalized = side.toUpperCase();
  if (normalized === "SELL") return "long";
  if (normalized === "BUY") return "short";
  return "unknown";
}

function bybitPositionSide(side: string): LiquidatedPositionSide {
  const normalized = side.toUpperCase();
  if (normalized === "BUY") return "long";
  if (normalized === "SELL") return "short";
  return "unknown";
}

export function parseBybitLiquidationMessage(raw: string): ConfirmedLiquidationEvent[] {
  const payload = JSON.parse(raw) as { topic?: string; data?: Array<{ T?: number; s?: string; S?: string; v?: string; p?: string }> };
  if (!payload.topic?.startsWith("allLiquidation.") || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((item, index) => {
    const time = Number(item.T);
    const price = Number(item.p);
    const quantity = Number(item.v);
    if (!Number.isFinite(time) || !Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) return [];
    return [{
      id: `bybit:${item.s ?? "UNKNOWN"}:${time}:${index}:${price}:${quantity}`,
      venue: "bybit",
      symbol: item.s ?? "UNKNOWN",
      time,
      price,
      quantity,
      liquidatedSide: bybitPositionSide(item.S ?? ""),
      priceKind: "bankruptcy"
    }];
  });
}

export function parseBinanceLiquidationMessage(raw: string): ConfirmedLiquidationEvent[] {
  const payload = JSON.parse(raw) as { e?: string; E?: number; o?: { s?: string; S?: string; p?: string; ap?: string; q?: string; z?: string; T?: number } };
  if (payload.e !== "forceOrder" || !payload.o) return [];
  const order = payload.o;
  const time = Number(order.T ?? payload.E);
  const price = Number(order.ap && Number(order.ap) > 0 ? order.ap : order.p);
  const quantity = Number(order.z && Number(order.z) > 0 ? order.z : order.q);
  if (!Number.isFinite(time) || !Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) return [];
  return [{
    id: `binance:${order.s ?? "UNKNOWN"}:${time}:${price}:${quantity}`,
    venue: "binance",
    symbol: order.s ?? "UNKNOWN",
    time,
    price,
    quantity,
    liquidatedSide: binancePositionSideFromLiquidationOrder(order.S ?? ""),
    priceKind: order.ap && Number(order.ap) > 0 ? "average-fill" : "order"
  }];
}

export function subscribeConfirmedLiquidations(input: {
  venue: SupportedLiquidationVenue;
  symbol: string;
  onEvent: (event: ConfirmedLiquidationEvent) => void;
  onError?: (error: Error) => void;
}): ConfirmedLiquidationSubscription {
  let disposed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let attempts = 0;
  const symbol = input.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const connect = () => {
    if (disposed) return;
    const url = input.venue === "bybit"
      ? "wss://stream.bybit.com/v5/public/linear"
      : `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@forceOrder`;
    socket = new WebSocket(url);
    socket.onopen = () => {
      attempts = 0;
      if (input.venue === "bybit") socket?.send(JSON.stringify({ op: "subscribe", args: [`allLiquidation.${symbol}`] }));
    };
    socket.onmessage = (message) => {
      try {
        const events = input.venue === "bybit"
          ? parseBybitLiquidationMessage(String(message.data))
          : parseBinanceLiquidationMessage(String(message.data));
        events.forEach(input.onEvent);
      } catch (error) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () => input.onError?.(new Error(`${input.venue.toUpperCase()} confirmed liquidation feed failed.`));
    socket.onclose = () => {
      socket = null;
      if (disposed) return;
      attempts += 1;
      reconnectTimer = window.setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
    };
  };
  connect();
  return {
    unsubscribe: () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000, "Book Heatmap liquidation feed closed");
      socket = null;
    }
  };
}
