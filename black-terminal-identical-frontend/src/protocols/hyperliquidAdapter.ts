import type { ConnectRequest, ConnectionRecord } from "../connectivity/types";
import { defaultConnectionHealth, defaultPermissionReport } from "../connectivity/types";
import type { OrderRequest, OrderUpdate } from "../execution/types";
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
          trading: true,
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
      lastSuccessfulHeartbeat: Date.now()
    });
  },

  async executePerpetualOrder(_connection: ConnectionRecord, order: OrderRequest): Promise<OrderUpdate> {
    return {
      accountId: order.accountId,
      exchange: "hyperliquid",
      orderId: order.internalOrderId || order.clientOrderId || `hl-${Date.now()}`,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      status: "rejected",
      filledQuantity: 0,
      reason: "Hyperliquid server-side signing and order relay are not configured yet.",
      time: Date.now()
    };
  }
};
