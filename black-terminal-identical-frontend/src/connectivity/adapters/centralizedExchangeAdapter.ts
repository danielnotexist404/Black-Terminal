import type { ExchangeConnectionDraft } from "../../portfolio/types";
import { connectExchangeAccount } from "../../portfolio/portfolioStore";
import type { ExchangeId } from "../../market-data/types";
import type { ConnectionAdapter, ConnectRequest, ConnectionRecord } from "../types";
import { defaultConnectionHealth, defaultPermissionReport } from "../types";

export function createCentralizedExchangeConnectionAdapter(exchange: ExchangeId, label: string): ConnectionAdapter {
  const capabilities: ConnectionAdapter["capabilities"] = [
    "market-orders",
    "spot-orders",
    "limit-orders",
    "conditional-orders",
    "cancel-orders",
    "modify-orders",
    "leverage",
    "cross-margin",
    "isolated-margin",
    "reduce-only",
    "post-only",
    "balances",
    "positions",
    "orders",
    "trades",
    "private-websocket",
    "public-websocket"
  ];

  return {
    id: `cex:${exchange}`,
    label,
    category: "centralized-exchange",
    capabilities,

    async connect(request: ConnectRequest): Promise<ConnectionRecord> {
      const startedAt = Date.now();
      const credentials = request.credentials as ExchangeConnectionDraft | undefined;
      if (!credentials) throw new Error(`${label} credentials missing.`);
      const account = await connectExchangeAccount(credentials);
      const tradingEnabled = account.permissions.includes("place-orders");
      const withdrawalEnabled = account.permissions.includes("withdraw-disabled") === false && Boolean((request.metadata as any)?.withdrawalPermission);

      return {
        id: `cex-${account.id}`,
        adapterId: `cex:${exchange}`,
        category: "centralized-exchange",
        provider: exchange,
        label: account.accountName || request.label || label,
        status: account.status === "connected" ? "connected" : "degraded",
        capabilities,
        accountId: account.id,
        health: defaultConnectionHealth({
          status: account.status === "connected" ? "connected" : "degraded",
          latencyMs: account.latencyMs || Date.now() - startedAt,
          heartbeat: "ok",
          authentication: account.apiHealth === "failed" ? "failed" : "authenticated",
          synchronization: "synced",
          privateStream: "unknown",
          publicStream: "connected",
          permissions: defaultPermissionReport({
            read: account.permissions.includes("read-account"),
            trading: tradingEnabled,
            withdrawal: withdrawalEnabled,
            warnings: withdrawalEnabled ? ["Withdrawal API permission detected. Use trading-only API keys."] : []
          })
        }),
        metadata: {
          accountName: account.accountName,
          exchange,
          apiHealth: account.apiHealth,
          status: account.status,
          ...(request.metadata ?? {})
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    },

    async disconnect() {},

    async heartbeat(connection) {
      return defaultConnectionHealth({
        ...connection.health,
        status: connection.status,
        heartbeat: "ok",
        authentication: connection.health.authentication,
        lastSuccessfulHeartbeat: Date.now()
      });
    }
  };
}
