import { getBrokerAdapter } from "../broker/brokerRegistry";
import type { ExchangeBrokerAdapter } from "../broker/types";
import { blackCoreConnectionManager } from "../connectivity/connectionManager";
import type { ConnectionRecord } from "../connectivity/types";
import { blackCoreProtocolRouter } from "../protocols/protocolRouter";
import type { ExecutionRequest } from "./types";

export type BrokerRoute = {
  adapterType: "centralized-exchange" | "wallet" | "protocol" | "fix-gateway" | "prime-broker";
  adapter: ExchangeBrokerAdapter;
  connection?: ConnectionRecord;
};

export class BrokerRouter {
  resolve(request: ExecutionRequest): BrokerRoute {
    const connection = blackCoreConnectionManager.findConnectionByAccount(request.accountId);
    if (connection?.category === "protocol") {
      const protocolAdapter = blackCoreProtocolRouter.resolve(connection);
      if (!protocolAdapter?.executePerpetualOrder) {
        throw new Error(`No protocol execution adapter registered for ${connection.provider}.`);
      }

      return {
        adapterType: "protocol",
        connection,
        adapter: {
          exchange: request.exchange,
          label: connection.label,
          capabilities: {
            liveMarketData: true,
            orderPlacement: Boolean(connection.metadata.executionReady),
            positionSync: Boolean(protocolAdapter.syncPositions),
            orderSync: true,
            balanceSync: Boolean(protocolAdapter.syncBalances),
            tradeHistory: true,
            twap: false,
            iceberg: false
          },
          validateConnection: async () => ({
            status: connection.metadata.executionReady ? "connected" : "read-only",
            apiHealth: connection.metadata.executionReady ? "healthy" : "warning",
            latencyMs: connection.health.latencyMs,
            checkedAt: Date.now()
          }),
          placeOrder: (order) => protocolAdapter.executePerpetualOrder!(connection, order),
          cancelOrder: async (_accountId, orderId) => {
            if (!protocolAdapter.cancelProtocolOrder) throw new Error("Protocol cancel adapter is not configured.");
            return protocolAdapter.cancelProtocolOrder(connection, orderId);
          },
          getBalances: async () => protocolAdapter.syncBalances?.(connection) ?? [],
          getPositions: async () => (await protocolAdapter.syncPositions?.(connection) ?? []) as any
        }
      };
    }

    return {
      adapterType: connection?.category === "wallet" ? "wallet" : "centralized-exchange",
      adapter: getBrokerAdapter(request.exchange),
      connection: connection ?? undefined
    };
  }
}

export const blackCoreBrokerRouter = new BrokerRouter();
