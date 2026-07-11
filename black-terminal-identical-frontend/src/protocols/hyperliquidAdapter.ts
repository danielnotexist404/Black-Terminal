import type { ConnectRequest, ConnectionRecord } from "../connectivity/types";
import { defaultConnectionHealth, defaultPermissionReport } from "../connectivity/types";
import { getVenueCertification } from "../connectivity/venueRegistry";
import { shouldSendMainnetConfirmed, validateMainnetOrderReadiness } from "../execution/mainnetValidationMode";
import type { OrderRequest, OrderUpdate } from "../execution/types";
import { connectHyperliquidRelayViaApi, submitHyperliquidOrderViaApi } from "../portfolio/portfolioApiClient";
import type { ProtocolAdapter, ProtocolCapabilityProfile } from "./types";

type EthereumProvider = {
  request?: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const hyperliquidCapabilities = [
  "market-orders",
  "limit-orders",
  "conditional-orders",
  "perpetual-orders",
  "modify-orders",
  "cancel-orders",
  "leverage",
  "cross-margin",
  "isolated-margin",
  "funding",
  "liquidation",
  "reduce-only",
  "post-only",
  "balances",
  "positions",
  "orders",
  "trades",
  "wallet-connect",
  "transaction-signing",
  "public-websocket"
] as const;

export const hyperliquidProtocolAdapter: ProtocolAdapter = {
  id: "protocol:hyperliquid",
  label: "Hyperliquid Protocol",
  category: "protocol",
  protocol: "hyperliquid",
  signer: "metamask",
  capabilities: [...hyperliquidCapabilities],

  async detectCapabilities(): Promise<ProtocolCapabilityProfile> {
    return {
      protocol: "hyperliquid",
      signer: "metamask",
      capabilities: [...hyperliquidCapabilities],
      supportedOrderTypes: ["market", "limit", "stop-market", "stop-limit"],
      supportsPerpetuals: true,
      supportsSpot: true,
      supportsCrossMargin: true,
      supportsIsolatedMargin: true,
      supportsFunding: true,
      supportsLiquidation: true,
      supportsReduceOnly: true,
      supportsPostOnly: true
    };
  },

  async connect(request: ConnectRequest): Promise<ConnectionRecord> {
    const startedAt = Date.now();
    const ethereum = (globalThis as any).ethereum as EthereumProvider | undefined;
    if (!ethereum?.request) throw new Error("MetaMask is required for Hyperliquid protocol signing.");

    const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
    const chainId = await ethereum.request({ method: "eth_chainId" }) as string;
    const address = accounts?.[0];
    if (!address) throw new Error("MetaMask returned no wallet address for Hyperliquid.");

    const profile = await hyperliquidProtocolAdapter.detectCapabilities();
    const certification = getVenueCertification("hyperliquid");
    const credentials = request.credentials as {
      agentPrivateKey?: string;
      network?: "testnet" | "mainnet";
      accountName?: string;
      mainnetConfirmed?: boolean;
    } | undefined;

    if (credentials?.agentPrivateKey && credentials.network) {
      const relayConnection = await connectHyperliquidRelayViaApi({
        masterWalletAddress: address,
        agentPrivateKey: credentials.agentPrivateKey,
        network: credentials.network,
        accountName: credentials.accountName || request.label,
        mainnetConfirmed: credentials.mainnetConfirmed
      });
      if (!relayConnection) throw new Error("Supabase session required for Hyperliquid relay onboarding.");
      return relayConnection;
    }

    return {
      id: `protocol-hyperliquid-${address.toLowerCase()}`,
      adapterId: request.adapterId,
      category: "protocol",
      provider: "hyperliquid",
      label: request.label || "Hyperliquid / MetaMask",
      status: "connected",
      capabilities: profile.capabilities,
      walletAddress: address,
      accountId: `hyperliquid:${address.toLowerCase()}`,
      health: defaultConnectionHealth({
        status: "connected",
        latencyMs: Date.now() - startedAt,
        heartbeat: "ok",
        authentication: "authenticated",
        synchronization: "syncing",
        privateStream: "unknown",
        publicStream: "connected",
        permissions: defaultPermissionReport({
          read: true,
          trading: false,
          withdrawal: false
        })
      }),
      metadata: {
        protocol: "hyperliquid",
        signer: "metamask",
        chainId,
        walletAddress: address,
        capabilityProfile: profile,
        executionBridge: "protocol-adapter",
        executionMode: credentials?.agentPrivateKey ? "full-live" : "signer-only",
        readiness: "execution-blocked",
        mainnetValidated: certification?.mainnetValidated ?? false,
        supportedProducts: certification?.supportedProducts ?? ["perpetual"],
        supportedOrderTypes: profile.supportedOrderTypes,
        limitations: certification?.limitations ?? [],
        executionReady: false,
        readinessReason: "MetaMask identity is connected. Add an authorized Hyperliquid agent wallet to enable server-side live execution.",
        ...(request.metadata ?? {})
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  },

  async disconnect() {},

  async heartbeat(connection) {
    const ethereum = (globalThis as any).ethereum as EthereumProvider | undefined;
    if (!ethereum?.request) throw new Error("MetaMask provider unavailable for Hyperliquid heartbeat.");
    return defaultConnectionHealth({
      ...connection.health,
      status: "connected",
      heartbeat: "ok",
      authentication: "authenticated",
      permissions: defaultPermissionReport({
        ...connection.health.permissions,
        trading: Boolean(connection.metadata.executionReady)
      }),
      lastSuccessfulHeartbeat: Date.now()
    });
  },

  async executePerpetualOrder(connection: ConnectionRecord, order: OrderRequest): Promise<OrderUpdate> {
    if (!connection.metadata.executionReady) {
      return {
        accountId: order.accountId,
        exchange: "hyperliquid",
        orderId: order.internalOrderId || order.clientOrderId || `hl-blocked-${Date.now()}`,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        status: "rejected",
        filledQuantity: 0,
        reason: String(connection.metadata.readinessReason || "Hyperliquid execution relay is not ready."),
        time: Date.now()
      };
    }

    const mainnetReadiness = validateMainnetOrderReadiness(connection);
    if (!mainnetReadiness.allowed) {
      return {
        accountId: order.accountId,
        exchange: "hyperliquid",
        orderId: order.internalOrderId || order.clientOrderId || `hl-blocked-${Date.now()}`,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        status: "rejected",
        filledQuantity: 0,
        reason: mainnetReadiness.reason || "Hyperliquid mainnet validation is not enabled.",
        time: Date.now()
      };
    }

    const update = await submitHyperliquidOrderViaApi({
      accountId: connection.accountId || order.accountId,
      exchange: "hyperliquid",
      symbol: order.symbol,
      marketKind: order.marketKind,
      side: order.side,
      orderType: order.type,
      quantity: order.quantity,
      sizingMethod: order.sizingMethod,
      referencePrice: order.referencePrice,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      leverage: order.leverage,
      marginMode: order.marginMode,
      postOnly: order.postOnly,
      reduceOnly: order.reduceOnly,
      timeInForce: order.timeInForce,
      source: order.source,
      destinations: order.destinations,
      internalOrderId: order.internalOrderId,
      clientOrderId: order.clientOrderId,
      mainnetConfirmed: shouldSendMainnetConfirmed(connection)
    });
    if (!update) throw new Error("Supabase session required for Hyperliquid execution.");
    return update;
  }
};
