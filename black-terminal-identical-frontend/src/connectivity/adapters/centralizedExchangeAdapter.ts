import type { ExchangeConnectionDraft } from "../../portfolio/types";
import { connectExchangeAccount, invalidatePortfolioSnapshot } from "../../portfolio/portfolioStore";
import { disconnectExchangeAccountViaApi, listPersistedExchangeConnectionsViaApi, probeExchangeAccountHealthViaApi, syncExchangeAccountViaApi } from "../../portfolio/portfolioApiClient";
import { blackCoreOrderSyncService } from "../../orders/orderSyncService";
import type { ExchangeId } from "../../market-data/types";
import type { ConnectionAdapter, ConnectionLifecycleState, ConnectionRecord, ConnectionStatus, ConnectRequest } from "../types";
import { defaultConnectionHealth, defaultPermissionReport } from "../types";
import { getVenueCertification } from "../venueRegistry";

export function createCentralizedExchangeConnectionAdapter(exchange: ExchangeId, label: string): ConnectionAdapter {
  const certification = getVenueCertification(exchange);
  const capabilities: ConnectionAdapter["capabilities"] = certification?.connectionCapabilities ?? [];

  return {
    id: `cex:${exchange}`,
    label,
    category: "centralized-exchange",
    capabilities,

    async connect(request: ConnectRequest): Promise<ConnectionRecord> {
      const startedAt = Date.now();
      const credentials = request.credentials as ExchangeConnectionDraft | undefined;
      if (!credentials) throw new Error(`${label} credentials missing.`);
      if (!certification?.authReady) {
        throw new Error(`${label} credential validation is not certified yet. This venue is ${certification?.executionMode ?? "unavailable"} in Black Terminal.`);
      }
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
          network: certification.defaultNetwork,
          accountRiskControls: account.riskControls,
          executionMode: certification.executionMode,
          lifecycle: tradingEnabled ? "CONNECTED_TRADING" : "CONNECTED_READ_ONLY",
          readiness: tradingEnabled ? "execution-ready" : "connected-read-only",
          mainnetValidated: certification.mainnetValidated,
          supportedProducts: certification.supportedProducts,
          supportedOrderTypes: certification.supportedOrderTypes,
          limitations: certification.limitations,
          ...(request.metadata ?? {})
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    },

    async disconnect(connection) {
      if (!connection.accountId) return;
      await disconnectExchangeAccountViaApi(connection.accountId);
      blackCoreOrderSyncService.removeExchange(exchange);
      invalidatePortfolioSnapshot();
    },

    async heartbeat(connection) {
      if (!connection.accountId) throw new Error("Broker account identifier is unavailable for authenticated heartbeat.");
      const probe = await probeExchangeAccountHealthViaApi(connection.accountId);
      if (!probe) throw new Error("Authenticated Black Terminal session is required for broker heartbeat.");
      return defaultConnectionHealth({
        ...connection.health,
        lifecycle: probe.lifecycle,
        status: lifecycleToStatus(probe.lifecycle),
        latencyMs: probe.latencyMs,
        heartbeat: "ok",
        authentication: probe.authentication,
        synchronization: probe.synchronization,
        privateStream: probe.privateStream,
        publicStream: probe.publicStream,
        permissions: probe.permissions,
        lastSuccessfulHeartbeat: probe.lastSuccessfulHeartbeat,
        lastError: probe.executionReady ? undefined : probe.readinessReason
      });
    },

    async reconnect(connection) {
      if (!connection.accountId) throw new Error("Broker account identifier is unavailable for reconnect.");
      await syncExchangeAccountViaApi(connection.accountId);
      const health = await this.heartbeat(connection);
      return {
        ...connection,
        status: health.status,
        health,
        metadata: {
          ...connection.metadata,
          lifecycle: health.lifecycle || (health.permissions.trading ? "CONNECTED_TRADING" : "CONNECTED_READ_ONLY"),
          readiness: health.lifecycle === "CONNECTED_TRADING" ? "execution-ready" : "connected-read-only",
          executionReady: health.lifecycle === "CONNECTED_TRADING"
        },
        updatedAt: Date.now()
      };
    },

    async sync(connection) {
      if (!connection.accountId) throw new Error("Broker account identifier is unavailable for synchronization.");
      await syncExchangeAccountViaApi(connection.accountId);
      return { health: await this.heartbeat(connection), updatedAt: Date.now() };
    }
  };
}

export async function restoreCentralizedExchangeConnections(): Promise<ConnectionRecord[]> {
  const payload = await listPersistedExchangeConnectionsViaApi();
  if (!payload) return [];
  return payload.connections.map((item) => {
    const account = item.account;
    const certification = getVenueCertification(account.exchange);
    const descriptor = payload.adapters.find((adapter) => adapter.id === account.exchange);
    const tradingEnabled = account.permissions.includes("place-orders") && item.lifecycle === "CONNECTED_TRADING";
    const status = lifecycleToStatus(item.lifecycle);
    const capturedAt = item.health?.capturedAt ? Date.parse(item.health.capturedAt) : 0;
    return {
      id: `cex-${account.id}`,
      adapterId: `cex:${account.exchange}`,
      category: "centralized-exchange",
      provider: account.exchange,
      label: account.accountName,
      status,
      capabilities: certification?.connectionCapabilities ?? [],
      accountId: account.id,
      health: defaultConnectionHealth({
        lifecycle: item.lifecycle,
        status,
        latencyMs: item.health?.latencyMs ?? account.latencyMs ?? 0,
        heartbeat: capturedAt && Date.now() - capturedAt < 120_000 ? "ok" : "unknown",
        authentication: item.health?.authentication === "failed" ? "failed" : "authenticated",
        synchronization: item.health?.synchronization === "stale" ? "stale" : account.lastSyncedAt ? "synced" : "unknown",
        privateStream: item.health?.privateStream === "connected" ? "connected" : item.health?.privateStream === "disconnected" ? "disconnected" : "unknown",
        publicStream: item.health?.publicStream === "disconnected" ? "disconnected" : "connected",
        reconnectCount: item.health?.reconnectCount ?? 0,
        lastSuccessfulHeartbeat: capturedAt || undefined,
        lastError: account.lastError || undefined,
        rateLimitUsage: item.health?.rateLimitUsage || undefined,
        permissions: defaultPermissionReport({
          read: account.permissions.includes("read-account"),
          trading: tradingEnabled,
          withdrawal: false,
          warnings: tradingEnabled ? [] : ["This persisted account is currently read-only or execution-blocked."]
        })
      }),
      metadata: {
        lifecycle: item.lifecycle,
        restored: true,
        accountName: account.accountName,
        exchange: account.exchange,
        network: account.network || certification?.defaultNetwork,
        executionEnvironment: account.executionEnvironment,
        endpointProfile: account.endpointProfile,
        brokerAccountUid: account.brokerAccountUid,
        authorization: descriptor?.authorization,
        executionMode: certification?.executionMode,
        readiness: tradingEnabled ? "execution-ready" : "connected-read-only",
        executionReady: tradingEnabled,
        mainnetValidated: certification?.mainnetValidated,
        supportedProducts: certification?.supportedProducts || [],
        supportedOrderTypes: certification?.supportedOrderTypes || [],
        limitations: certification?.limitations || []
      },
      createdAt: account.connectedAt || Date.now(),
      updatedAt: Date.now()
    };
  });
}

function lifecycleToStatus(lifecycle: ConnectionLifecycleState): ConnectionStatus {
  if (["CONNECTED_TRADING", "CONNECTED_READ_ONLY", "AUTHENTICATED"].includes(lifecycle)) return "connected";
  if (["RESTORING", "RECONNECTING", "CONNECTING", "AUTHORIZING", "VALIDATING", "SYNCING"].includes(lifecycle)) return "reconnecting";
  if (["DEGRADED", "EXECUTION_BLOCKED", "PERMISSION_ERROR"].includes(lifecycle)) return "degraded";
  if (["TOKEN_EXPIRED", "AUTHENTICATION_ERROR"].includes(lifecycle)) return "auth-failed";
  if (lifecycle === "DISCONNECTING") return "disconnecting";
  if (lifecycle === "DISCONNECTED") return "disconnected";
  return "offline";
}
