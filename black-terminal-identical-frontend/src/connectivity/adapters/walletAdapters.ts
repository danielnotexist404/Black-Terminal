import type { ConnectionAdapter, ConnectRequest, ConnectionRecord } from "../types";
import { defaultConnectionHealth, defaultPermissionReport } from "../types";
import { getVenueCertification } from "../venueRegistry";

type EthereumProvider = {
  request?: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type SolanaProvider = {
  connect?: () => Promise<{ publicKey?: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  isPhantom?: boolean;
};

const walletBaseCapabilities = ["wallet-connect", "transaction-signing", "token-transfers", "network-switching"] as const;

export const metaMaskConnectionAdapter: ConnectionAdapter = {
  id: "wallet:metamask",
  label: "MetaMask",
  category: "wallet",
  capabilities: [...walletBaseCapabilities],

  async connect(request: ConnectRequest): Promise<ConnectionRecord> {
    const startedAt = Date.now();
    const ethereum = (globalThis as any).ethereum as EthereumProvider | undefined;
    if (!ethereum?.request) throw new Error("MetaMask not detected.");

    const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
    const chainId = await ethereum.request({ method: "eth_chainId" }) as string;
    const address = accounts?.[0];
    if (!address) throw new Error("MetaMask returned no wallet address.");
    const certification = getVenueCertification("metamask");

    return {
      id: `wallet-metamask-${address.toLowerCase()}`,
      adapterId: request.adapterId,
      category: "wallet",
      provider: "metamask",
      label: request.label || "MetaMask",
      status: "connected",
      capabilities: [...walletBaseCapabilities],
      health: defaultConnectionHealth({
        status: "connected",
        latencyMs: Date.now() - startedAt,
        heartbeat: "ok",
        authentication: "authenticated",
        synchronization: "synced",
        privateStream: "not-supported",
        publicStream: "not-supported",
        permissions: defaultPermissionReport({ read: true })
      }),
      walletAddress: address,
      metadata: {
        chainId,
        walletAddress: address,
        executionMode: certification?.executionMode ?? "signer-only",
        readiness: certification?.readiness ?? "execution-blocked",
        mainnetValidated: false,
        supportedProducts: certification?.supportedProducts ?? ["swap"],
        supportedOrderTypes: [],
        limitations: certification?.limitations ?? [],
        futuresUnsupportedReason: "MetaMask is a wallet signer. Futures require a connected perpetual DEX adapter such as Hyperliquid or GMX.",
        ...(request.metadata ?? {})
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  },

  async disconnect() {},

  async heartbeat(connection) {
    const ethereum = (globalThis as any).ethereum as EthereumProvider | undefined;
    if (!ethereum?.request) throw new Error("MetaMask provider unavailable.");
    return defaultConnectionHealth({
      ...connection.health,
      status: "connected",
      heartbeat: "ok",
      authentication: "authenticated",
      lastSuccessfulHeartbeat: Date.now()
    });
  }
};

export const phantomConnectionAdapter: ConnectionAdapter = {
  id: "wallet:phantom",
  label: "Phantom",
  category: "wallet",
  capabilities: [...walletBaseCapabilities],

  async connect(request: ConnectRequest): Promise<ConnectionRecord> {
    const startedAt = Date.now();
    const solana = (globalThis as any).solana as SolanaProvider | undefined;
    if (!solana?.connect) throw new Error("Phantom not detected.");

    const response = await solana.connect();
    const address = response?.publicKey?.toString();
    if (!address) throw new Error("Phantom returned no wallet address.");
    const certification = getVenueCertification("phantom");

    return {
      id: `wallet-phantom-${address}`,
      adapterId: request.adapterId,
      category: "wallet",
      provider: "phantom",
      label: request.label || "Phantom",
      status: "connected",
      capabilities: [...walletBaseCapabilities],
      health: defaultConnectionHealth({
        status: "connected",
        latencyMs: Date.now() - startedAt,
        heartbeat: "ok",
        authentication: "authenticated",
        synchronization: "synced",
        privateStream: "not-supported",
        publicStream: "not-supported",
        permissions: defaultPermissionReport({ read: true })
      }),
      walletAddress: address,
      metadata: {
        chainId: "solana",
        walletAddress: address,
        executionMode: certification?.executionMode ?? "signer-only",
        readiness: certification?.readiness ?? "execution-blocked",
        mainnetValidated: false,
        supportedProducts: certification?.supportedProducts ?? ["swap"],
        supportedOrderTypes: [],
        limitations: certification?.limitations ?? [],
        futuresUnsupportedReason: "Phantom is a wallet signer. Futures require a connected perpetual DEX adapter.",
        ...(request.metadata ?? {})
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  },

  async disconnect() {
    const solana = (globalThis as any).solana as SolanaProvider | undefined;
    await solana?.disconnect?.();
  },

  async heartbeat(connection) {
    const solana = (globalThis as any).solana as SolanaProvider | undefined;
    if (!solana?.connect) throw new Error("Phantom provider unavailable.");
    return defaultConnectionHealth({
      ...connection.health,
      status: "connected",
      heartbeat: "ok",
      authentication: "authenticated",
      lastSuccessfulHeartbeat: Date.now()
    });
  }
};
