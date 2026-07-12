import type { OrderRequest, OrderUpdate } from "./types";
import type { PortfolioAccount } from "../portfolio/types";
import { blackCoreEmsService } from "./emsService";
import { blackCoreOmsService } from "./omsService";

export async function submitOrder(
  order: Omit<OrderRequest, "clientOrderId">,
  account: PortfolioAccount,
  referencePrice: number
): Promise<OrderUpdate> {
  const request = blackCoreOmsService.createOrder({
    accountId: order.accountId,
    exchange: order.exchange,
    symbol: order.symbol,
    marketKind: order.marketKind,
    side: order.side,
    orderType: order.type,
    quantity: order.quantity,
    sizingMethod: order.sizingMethod ?? "quantity",
    limitPrice: order.limitPrice,
    stopPrice: order.stopPrice,
    referencePrice: order.referencePrice ?? referencePrice,
    timeInForce: order.timeInForce ?? "gtc",
    triggerBy: order.triggerBy,
    tpTriggerBy: order.tpTriggerBy,
    slTriggerBy: order.slTriggerBy,
    tpslMode: order.tpslMode,
    positionIdx: order.positionIdx,
    slippageTolerancePercent: order.slippageTolerancePercent,
    leverage: order.leverage,
    marginMode: order.marginMode,
    takeProfit: order.takeProfit,
    stopLoss: order.stopLoss,
    reduceOnly: order.reduceOnly,
    postOnly: order.postOnly,
    destinations: order.destinations ?? ["personal-portfolio"],
    source: order.source ?? "order-ticket"
  });
  return blackCoreEmsService.submit(request, { account });
}
