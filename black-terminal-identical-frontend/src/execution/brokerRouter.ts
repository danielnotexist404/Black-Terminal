import { getBrokerAdapter } from "../broker/brokerRegistry";
import type { ExchangeBrokerAdapter } from "../broker/types";
import type { ExecutionRequest } from "./types";

export type BrokerRoute = {
  adapterType: "centralized-exchange" | "wallet" | "fix-gateway" | "prime-broker";
  adapter: ExchangeBrokerAdapter;
};

export class BrokerRouter {
  resolve(request: ExecutionRequest): BrokerRoute {
    return {
      adapterType: "centralized-exchange",
      adapter: getBrokerAdapter(request.exchange)
    };
  }
}

export const blackCoreBrokerRouter = new BrokerRouter();
