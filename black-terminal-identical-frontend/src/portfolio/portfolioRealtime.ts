import { supabase } from "../lib/supabase";
import { blackCoreResourceTracker } from "../performance/resourceTracker";

export type PortfolioRealtimeState = "connecting" | "live" | "reconnecting" | "degraded" | "disconnected";
export type PortfolioRealtimeEvent = "positions" | "balances" | "orders";

type RealtimeRow = { account_id?: unknown };

/**
 * Supabase changes are invalidation hints only. Authoritative values always come
 * from the authenticated broker snapshot endpoint and are reconciled there.
 */
export function subscribePortfolioRealtime(options: {
  accountIds: readonly string[];
  onInvalidate: (event: PortfolioRealtimeEvent) => void;
  onState: (state: PortfolioRealtimeState) => void;
}) {
  const accountIds = new Set(options.accountIds.filter(Boolean));
  if (!supabase || accountIds.size === 0) {
    options.onState("disconnected");
    return () => undefined;
  }
  const client = supabase;

  let disposed = false;
  options.onState("connecting");
  const release = blackCoreResourceTracker.acquire("supabase-subscription", "portfolio-realtime");
  const channel = client.channel(`portfolio-realtime:${[...accountIds].sort().join(":")}:${Date.now()}`);
  const bind = (table: string, event: PortfolioRealtimeEvent) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      const next = (payload.new || {}) as RealtimeRow;
      const prior = (payload.old || {}) as RealtimeRow;
      const accountId = String(next.account_id || prior.account_id || "");
      if (!disposed && accountIds.has(accountId)) options.onInvalidate(event);
    });
  };
  bind("account_positions", "positions");
  bind("account_balances", "balances");
  bind("execution_orders", "orders");
  channel.subscribe((status) => {
    if (disposed) return;
    if (status === "SUBSCRIBED") options.onState("live");
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") options.onState("reconnecting");
    else if (status === "CLOSED") options.onState("disconnected");
  });

  return () => {
    if (disposed) return;
    disposed = true;
    release();
    void client.removeChannel(channel);
  };
}
