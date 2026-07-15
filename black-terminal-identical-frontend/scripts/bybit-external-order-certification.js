import { writeFile } from "node:fs/promises";
import { getBybitOpenOrdersSnapshot } from "../server/exchanges/bybit.js";

const apiKey = String(process.env.BYBIT_API_KEY || "").trim();
const apiSecret = String(process.env.BYBIT_API_SECRET || "").trim();
if (!apiKey || !apiSecret) {
  console.error("BYBIT_API_KEY and BYBIT_API_SECRET are required. This script only reads existing venue orders and never places one.");
  process.exit(1);
}

const snapshot = await getBybitOpenOrdersSnapshot({ apiKey, apiSecret }, {
  categories: String(process.env.BYBIT_ORDER_CATEGORIES || "linear,spot").split(",").map((value) => value.trim()).filter(Boolean),
  settleCoin: process.env.BYBIT_SETTLE_COIN || "USDT",
  network: process.env.BYBIT_NETWORK || "mainnet"
});
const expectedOrderId = String(process.env.BYBIT_EXPECTED_ORDER_ID || "").trim();
const expectedSymbol = String(process.env.BYBIT_EXPECTED_SYMBOL || "").trim().toUpperCase();
const matched = snapshot.orders.filter((order) =>
  (!expectedOrderId || order.venueOrderId === expectedOrderId) &&
  (!expectedSymbol || order.symbol === expectedSymbol)
);
const passed = snapshot.health.verified && (!expectedOrderId && !expectedSymbol ? snapshot.orders.length > 0 : matched.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  network: snapshot.health.network,
  health: snapshot.health,
  expected: { orderId: expectedOrderId || null, symbol: expectedSymbol || null },
  matchedOrders: matched.map((order) => ({
    venueOrderId: order.venueOrderId,
    category: order.category,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: order.price,
    quantity: order.quantity,
    remainingQuantity: order.remainingQuantity,
    status: order.status,
    source: order.source,
    ownership: order.ownership
  })),
  result: passed ? "PASS" : "BLOCKED"
};
await writeFile(new URL("../docs/BYBIT_EXTERNAL_ORDER_CERTIFICATION_EVIDENCE.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = passed ? 0 : 2;
