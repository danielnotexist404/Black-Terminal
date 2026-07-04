import { getBrokerAdapter } from "../broker/brokerRegistry";
import { createId } from "../core/ids";
import type { OrderRequest, OrderUpdate } from "./types";
import type { PortfolioAccount } from "../portfolio/types";
import { evaluateOrderRisk } from "../risk/riskEngine";

export async function submitOrder(
  order: Omit<OrderRequest, "clientOrderId">,
  account: PortfolioAccount,
  referencePrice: number
): Promise<OrderUpdate> {
  const risk = evaluateOrderRisk(order, account, account.riskControls, referencePrice);

  if (risk.status === "blocked") {
    return {
      accountId: order.accountId,
      exchange: order.exchange,
      orderId: createId("risk-block"),
      symbol: order.symbol,
      status: "rejected",
      filledQuantity: 0,
      reason: risk.reasons.join(" "),
      time: Date.now()
    };
  }

  return getBrokerAdapter(order.exchange).placeOrder({
    ...order,
    clientOrderId: createId("bt")
  });
}
