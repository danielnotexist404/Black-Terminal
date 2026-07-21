export type WalletProviderId = "metamask" | "phantom";

export type WalletConnection = {
  id: string;
  provider: WalletProviderId;
  label: string;
  address: string;
  chain: string;
  status: "connected" | "disconnected" | "unsupported";
  connectedAt: number;
};

export interface WalletConnector {
  id: WalletProviderId;
  label: string;
  connect(): Promise<WalletConnection>;
  disconnect(connectionId: string): Promise<void>;
  signTransaction(payload: unknown): Promise<string>;
}
