import { getBrokerAdapter } from "../broker/brokerRegistry";
import type { ExchangeBrokerAdapter } from "../broker/types";
import { blackCoreConnectionManager } from "../connectivity/connectionManager";
import type { ConnectionRecord } from "../connectivity/types";
import type { ExecutionRequest } from "./types";

export type BrokerRoute = {
  adapterType: "centralized-exchange" | "wallet" | "fix-gateway" | "prime-broker";
  adapter: ExchangeBrokerAdapter;
  connection?: ConnectionRecord;
};

export class BrokerRouter {
  resolve(request: ExecutionRequest): BrokerRoute {
    const connection = blackCoreConnectionManager.findConnectionByAccount(request.accountId);
    return {
      adapterType: connection?.category === "wallet" ? "wallet" : "centralized-exchange",
      adapter: getBrokerAdapter(request.exchange),
      connection: connection ?? undefined
    };
  }
}

export const blackCoreBrokerRouter = new BrokerRouter();
