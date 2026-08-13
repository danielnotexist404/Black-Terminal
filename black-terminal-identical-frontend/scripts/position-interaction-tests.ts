import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBybitProtectionDraft,
  formatPositionMoney,
  formatSignedPositionMoney,
  projectedLinearPositionPnl,
  quantizeProtectionPrice
} from "../src/positions/positionPresentation.ts";
import type { ManagedPosition } from "../src/positions/types.ts";

const shortPosition = {
  id: "position-xmr-short",
  accountId: "account-bybit-main",
  exchange: "bybit",
  network: "mainnet",
  category: "linear",
  marketKind: "perpetual",
  symbol: "XMRUSDT",
  positionIdx: 2,
  direction: "short",
  quantity: 1.13,
  averagePrice: 391,
  currentPrice: 392,
  unrealizedPnl: -1.13,
  realizedPnl: 11.19,
  margin: 26,
  leverage: 17,
  liquidationPrice: 495,
  stopLoss: 411,
  takeProfit: 306,
  openedAt: 1,
  lifecycleState: "protected",
  protections: [],
  timeline: [],
  health: {} as ManagedPosition["health"],
  notes: [],
  tags: [],
  sourceOrderIds: [],
  updatedAt: 2
} satisfies ManagedPosition;

assert.equal(formatPositionMoney(11.19), "$11.19");
assert.equal(formatPositionMoney(-353), "-$353.00");
assert.equal(formatSignedPositionMoney(11.19), "+$11.19");
assert.equal(formatSignedPositionMoney(-1.13), "-$1.13");

assert.ok(Math.abs((projectedLinearPositionPnl(shortPosition, 411) ?? 0) - -22.6) < 1e-9);
assert.ok(Math.abs((projectedLinearPositionPnl(shortPosition, 306) ?? 0) - 96.05) < 1e-9);
assert.equal(projectedLinearPositionPnl({ ...shortPosition, category: "inverse", symbol: "BTCUSD" }, 306), null);
assert.ok(Math.abs((projectedLinearPositionPnl({ ...shortPosition, direction: "long" }, 411) ?? 0) - 22.6) < 1e-9);

assert.equal(quantizeProtectionPrice(410.963, "0.01", 2), 410.96);
assert.equal(quantizeProtectionPrice(66_000.07, "0.10", 1), 66_000.1);

const stopDraft = buildBybitProtectionDraft(shortPosition, "stop-loss", 410.96);
assert.deepEqual(stopDraft, {
  accountId: shortPosition.accountId,
  symbol: "XMRUSDT",
  marketKind: "perpetual",
  category: "linear",
  positionIdx: 2,
  stopLoss: 410.96,
  tpslMode: "full",
  tpTriggerBy: "last",
  slTriggerBy: "last",
  mainnetConfirmed: true,
  liveConfirmation: "LIVE"
});
assert.throws(() => buildBybitProtectionDraft({ ...shortPosition, exchange: "binance" }, "take-profit", 420), /Bybit only/);

const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/modules/portfolio-manager/components/PortfolioManagerPage.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const apiClientSource = readFileSync(new URL("../src/portfolio/portfolioApiClient.ts", import.meta.url), "utf8");
const bybitSource = readFileSync(new URL("../server/exchanges/bybit.js", import.meta.url), "utf8");
const modifyRouteSource = readFileSync(new URL("../server/routes/execution/modify.js", import.meta.url), "utf8");
const themeSource = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");

const dragBlock = chartSource.match(/const dragProtectionLine[\s\S]*?const priceTouchesLevel/)?.[0] ?? "";
assert.ok(dragBlock.length > 0);
assert.doesNotMatch(dragBlock.match(/const move =[\s\S]*?const up =/)?.[0] ?? "", /moveProtection/);
assert.match(chartSource, /updateBybitPositionProtectionViaApi\(draft\)/);
assert.match(chartSource, /No order is sent until you confirm/);
assert.match(chartSource, /Projected P\/L/);
assert.match(chartSource, /line\.tone === "entry" \? activeChartPosition\.unrealizedPnl/);
assert.match(chartSource, /pendingProtectionChange\.proposedPrice/);

const orderDragBlock = chartSource.match(/const dragOrderLine[\s\S]*?const priceTouchesLevel/)?.[0] ?? "";
assert.ok(orderDragBlock.length > 0);
assert.doesNotMatch(orderDragBlock.match(/const move =[\s\S]*?const up =/)?.[0] ?? "", /modifyVenueOrderViaApi/);
assert.match(chartSource, /modifyVenueOrderViaApi\(currentOrder, \{ limitPrice: pending\.proposedPrice \}\)/);
assert.match(chartSource, /Nothing is submitted until you confirm/);
assert.match(chartSource, /confirmedOrderPrices\[orderKey\]/);
assert.match(themeSource, /\.venue-order-line\.buy \{ border-top-color: rgba\(157, 255, 50, 0\.96\)/);
assert.match(themeSource, /\.venue-order-line\.sell \{ border-top-color: rgba\(255, 232, 54, 0\.96\)/);
assert.match(apiClientSource, /fetch\("\/api\/execution\/modify"/);
assert.match(apiClientSource, /if \(!token\) throw new Error\("Authenticated Black Terminal session is required\."\)/);
assert.match(modifyRouteSource, /category: req\.body\.category \|\| existingOrder\?\.category/);
assert.match(bybitSource, /"POST", "\/v5\/order\/amend"/);
assert.match(panelSource, /formatPositionMoney\(position\.unrealizedPnl\)/);
assert.match(panelSource, /onDoubleClick=\{\(\) => onPositionNavigate\?\.\(position\)\}/);
assert.match(appSource, /const openPositionOnChart = useCallback/);
assert.match(apiClientSource, /fetch\("\/api\/execution\/protection"/);
assert.match(bybitSource, /"POST", "\/v5\/position\/trading-stop"/);
assert.match(bybitSource, /tpslMode: patch\.tpslMode === "partial" \? "Partial" : "Full"/);
assert.match(bybitSource, /"LastPrice"/);

console.log("Position precision, live/projected P/L, confirmed protection/order dragging, and row-navigation tests passed (no broker mutation performed)." );
