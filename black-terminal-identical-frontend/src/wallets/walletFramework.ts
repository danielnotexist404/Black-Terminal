import type { WalletConnection, WalletConnector, WalletProviderId } from "./types";

export class WalletFramework {
  private connectors = new Map<WalletProviderId, WalletConnector>();
  private connections = new Map<string, WalletConnection>();

  register(connector: WalletConnector) {
    this.connectors.set(connector.id, connector);
  }

  async connect(provider: WalletProviderId) {
    const connector = this.connectors.get(provider);
    if (!connector) throw new Error(`Wallet connector not registered: ${provider}`);
    const connection = await connector.connect();
    this.connections.set(connection.id, connection);
    return connection;
  }

  async disconnect(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    await this.connectors.get(connection.provider)?.disconnect(connectionId);
    this.connections.delete(connectionId);
  }

  listConnections() {
    return Array.from(this.connections.values());
  }
}

export const blackCoreWalletFramework = new WalletFramework();
