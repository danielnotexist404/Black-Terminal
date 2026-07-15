import assert from "node:assert/strict";
import { normalizeBybitVenueOrder } from "../server/exchanges/bybit.js";
import { normalizeBybitPrivateStreamMessage } from "../server/exchanges/bybit-private-stream.js";

const raw = {
  category: "linear",
  orderId: "venue-order-1",
  orderLinkId: "",
  symbol: "BTCUSDT",
  side: "Buy",
  orderType: "Limit",
  price: "62000",
  qty: "0.010",
  leavesQty: "0.006",
  cumExecQty: "0.004",
  avgPrice: "62100",
  orderStatus: "PartiallyFilled",
  timeInForce: "GTC",
  reduceOnly: false,
  positionIdx: 0,
  createdTime: "1710000000000",
  updatedTime: "1710000001000"
};

const restOrder = normalizeBybitVenueOrder(raw, "linear");
assert.equal(restOrder.internalId, "bybit:linear:venue-order-1");
assert.equal(restOrder.status, "partially-filled");
assert.equal(restOrder.remainingQuantity, 0.006);
assert.equal(restOrder.externallyCreated, true);
assert.equal(restOrder.source, "venue");

const [streamEvent] = normalizeBybitPrivateStreamMessage({
  topic: "order",
  creationTime: 1710000001000,
  data: [raw]
});
assert.equal(streamEvent.type, "order");
assert.equal(streamEvent.report.internalId, restOrder.internalId);
assert.equal(streamEvent.report.remainingQuantity, restOrder.remainingQuantity);
assert.equal(streamEvent.report.category, "linear");

const filled = normalizeBybitPrivateStreamMessage({
  topic: "order",
  creationTime: 1710000002000,
  data: [{ ...raw, leavesQty: "0", cumExecQty: "0.010", orderStatus: "Filled" }]
})[0].report;
assert.equal(filled.status, "filled");
assert.equal(filled.remainingQuantity, 0);

const source = await import("node:fs").then(({ readFileSync }) => ({
  bybit: readFileSync(new URL("../server/exchanges/bybit.js", import.meta.url), "utf8"),
  worker: readFileSync(new URL("./bybit-private-stream-worker.js", import.meta.url), "utf8"),
  chart: readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8")
}));
assert.match(source.bybit, /nextPageCursor/);
assert.match(source.bybit, /requestedCategories = options\.categories/);
assert.match(source.worker, /\["order", "execution", "position", "wallet"\]/);
assert.match(source.chart, /venue-order-line/);

console.log("Bybit external-order synchronization tests passed.");
