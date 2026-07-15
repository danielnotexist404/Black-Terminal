import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalOrderKey, deduplicateCanonicalOrders, retainOrdersForAccounts, shouldReplaceCanonicalOrder } from "../src/orders/canonicalOrder.ts";
import { priceToScreenY } from "../src/chart-engine/priceTransform.ts";
import type { OrderUpdate } from "../src/execution/types.ts";

const base: OrderUpdate = {
  accountId: "connection-1",
  connectionId: "connection-1",
  network: "mainnet",
  exchange: "bybit",
  category: "linear",
  orderId: "177000123456789",
  venueOrderId: "177000123456789",
  symbol: "BTCUSDT",
  status: "working",
  filledQuantity: 0,
  quantity: 0.01,
  remainingQuantity: 0.01,
  price: 67579.4,
  venuePriceString: "67579.40",
  time: 100,
  updatedTime: 100,
  venueUpdatedTime: 100
};

assert.equal(canonicalOrderKey(base), "mainnet:connection-1:bybit:linear:177000123456789");

const rest = { ...base, lastSource: "rest-snapshot" };
const websocket = { ...base, lastSource: "private-websocket", updatedTime: 110, venueUpdatedTime: 110 };
const refresh = { ...base, lastSource: "manual-refresh", updatedTime: 110, venueUpdatedTime: 110 };
const deduplicated = deduplicateCanonicalOrders([rest, rest, websocket, refresh]);
assert.equal(deduplicated.orders.length, 1);
assert.equal(deduplicated.diagnostics.duplicatesSuppressed, 3);
assert.equal(deduplicated.orders[0].venueOrderId, base.venueOrderId);
assert.equal(shouldReplaceCanonicalOrder(websocket, rest), false);

const otherConnection = { ...base, accountId: "connection-2", connectionId: "connection-2" };
assert.equal(deduplicateCanonicalOrders([base, otherConnection]).orders.length, 2);
const duplicateLocalAccount = { ...base, accountId: "duplicate-local-row", connectionId: "bybit:venue-user-1" };
const canonicalVenueAccount = { ...base, connectionId: "bybit:venue-user-1" };
assert.equal(deduplicateCanonicalOrders([canonicalVenueAccount, duplicateLocalAccount]).orders.length, 1);

assert.equal(retainOrdersForAccounts([base], [base.accountId]).length, 1);
assert.equal(retainOrdersForAccounts([base], []).length, 0);

const transform = { plotTop: 38, plotBottom: 638, priceMin: 60_000, priceMax: 70_000, scaleMode: "linear" as const };
const projected = priceToScreenY(67_579.4, transform);
assert.ok(projected !== null && Math.abs(projected - 183.236) < 0.000001);

const bybitSource = readFileSync(new URL("../server/exchanges/bybit.js", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");
const menuSource = readFileSync(new URL("../src/orders/OrderManagementMenu.tsx", import.meta.url), "utf8");
const reconciliationSource = readFileSync(new URL("../server/exchanges/bybit-reconciliation.js", import.meta.url), "utf8");
const disconnectSource = readFileSync(new URL("../server/routes/exchange-accounts/account.js", import.meta.url), "utf8");
const snapshotSource = readFileSync(new URL("../api/portfolio/snapshot.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(bybitSource, /processedCursors/);
assert.match(bybitSource, /duplicateRecordCount/);
assert.match(chartSource, /canonicalOrderKey\(order\)/);
assert.match(chartSource, /getScreenYForPrice\(Number\(order\.price\)\)/);
assert.match(cssSource, /\.position-protection-overlay\s*\{[\s\S]*?inset:\s*44px 0 0/);
assert.match(menuSource, /Modify Order/);
assert.match(menuSource, /Cancel Order/);
assert.match(menuSource, /Chase Order/);
assert.match(reconciliationSource, /canonicalConnectionId/);
assert.match(reconciliationSource, /apiKeyFingerprint/);
assert.match(disconnectSource, /findCredentialDuplicateAccountIds/);
assert.match(snapshotSource, /selectCanonicalAccounts/);
assert.match(appSource, /blackCoreOrderSyncService\.clear\(\)/);
assert.match(appSource, /snapshot\.accounts\.map\(\(account\) => account\.id\)/);

console.log("Bybit canonical-order, price-alignment, and management-menu tests passed.");
