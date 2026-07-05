import type { ConnectionAdapter, ConnectionCapability, ConnectionRecord } from "../connectivity/types";
import type { OrderRequest, OrderUpdate, Balance, Position } from "../execution/types";

export type ProtocolId = "hyperliquid" | "gmx" | "drift" | "vertex" | "dydx" | "jupiter" | "raydium" | "pancakeswap";
export type ProtocolSigner = "metamask" | "phantom" | "walletconnect";

export type ProtocolCapabilityProfile = {
  protocol: ProtocolId;
  signer: ProtocolSigner;
  capabilities: ConnectionCapability[];
  supportedOrderTypes: string[];
  supportsPerpetuals: boolean;
  supportsSpot: boolean;
  supportsCrossMargin: boolean;
  supportsIsolatedMargin: boolean;
  supportsFunding: boolean;
  supportsLiquidation: boolean;
  supportsReduceOnly: boolean;
  supportsPostOnly: boolean;
};

export interface ProtocolAdapter extends ConnectionAdapter {
  protocol: ProtocolId;
  signer: ProtocolSigner;
  detectCapabilities(connection?: ConnectionRecord): Promise<ProtocolCapabilityProfile>;
  syncPositions?(connection: ConnectionRecord): Promise<Position[]>;
  syncBalances?(connection: ConnectionRecord): Promise<Balance[]>;
  executePerpetualOrder?(connection: ConnectionRecord, order: OrderRequest): Promise<OrderUpdate>;
  cancelProtocolOrder?(connection: ConnectionRecord, orderId: string): Promise<OrderUpdate>;
  modifyProtocolOrder?(connection: ConnectionRecord, orderId: string, patch: Partial<OrderRequest>): Promise<OrderUpdate>;
  closeProtocolPosition?(connection: ConnectionRecord, symbol: string): Promise<OrderUpdate>;
}
