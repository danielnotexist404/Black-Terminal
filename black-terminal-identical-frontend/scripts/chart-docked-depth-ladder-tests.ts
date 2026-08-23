import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildChartDockedDepthLadder } from "../src/modules/dom-pro/chartDockedDepthLadderModel.ts";
import { ChartPriceViewportStore } from "../src/modules/dom-pro/chartPriceViewportStore.ts";
import type { ChartPriceTransformSnapshot } from "../src/chart-engine/priceTransform.ts";
import type { ProfessionalDomLadderModel, ProfessionalDomRow } from "../src/modules/dom-pro/domProfessionalLadder.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

function viewport(revision: number, priceMin = 90, priceMax = 110, scaleMode: "linear" | "logarithmic" = "linear"): ChartPriceTransformSnapshot {
  return { revision, width: 1000, height: 240, plotLeft: 0, plotRight: 900, plotTop: 20, plotBottom: 220, priceMin, priceMax, scaleMode, firstIndex: 0, lastIndex: 100 };
}

function sourceRow(price: number, bidSize = 0, askSize = 0, delta = 0): ProfessionalDomRow {
  return {
    key: String(price), price, priceLow: price - 0.5, priceHigh: price + 0.5,
    bidSize, askSize, totalSize: bidSize + askSize, signedSize: bidSize - askSize,
    delta, cumulativeSize: 0, depthRatio: 1, cumulativeRatio: 0,
    side: bidSize && askSize ? "mixed" : bidSize ? "bid" : askSize ? "ask" : "empty",
    isCurrentPrice: price === 100, isBestBid: false, isBestAsk: false, wall: null
  };
}

function depth(rows: ProfessionalDomRow[]): ProfessionalDomLadderModel {
  return {
    identity: "fixture", streamKey: "bybit:BTCUSDT:1", rows,
    tickSize: 1, requestedAggregationTicks: 1, effectiveAggregationTicks: 1, priceStep: 1,
    priceDecimals: 1, currentPrice: 100, bestBid: 99, bestAsk: 101, spread: 2,
    coverageMin: rows.length ? Math.min(...rows.map((row) => row.price)) : null,
    coverageMax: rows.length ? Math.max(...rows.map((row) => row.price)) : null,
    totalBidSize: rows.reduce((sum, row) => sum + row.bidSize, 0),
    totalAskSize: rows.reduce((sum, row) => sum + row.askSize, 0),
    bidLevels: rows.filter((row) => row.bidSize > 0).length,
    askLevels: rows.filter((row) => row.askSize > 0).length,
    subscribedDepth: 1000, sequence: 7, snapshotTimeMs: Date.now(), state: "live"
  };
}

{
  const store = new ChartPriceViewportStore();
  let notifications = 0;
  const unsubscribe = store.subscribe("workspace:btc", () => { notifications += 1; });
  store.publish("workspace:btc", viewport(1));
  store.publish("workspace:btc", viewport(1));
  assert.equal(notifications, 1, "an identical chart revision must be idempotent");
  store.publish("workspace:btc", viewport(2));
  assert.equal(notifications, 2, "a new chart revision must publish once");
  assert.equal(store.getSnapshot("workspace:eth"), null, "viewports must remain isolated by chart identity");
  unsubscribe();
}

{
  const source = depth([
    sourceRow(105, 0, 7, -2),
    sourceRow(102, 0, 3, -1),
    sourceRow(98, 5, 0, 1.5),
    sourceRow(95, 11, 0, 4)
  ]);
  const model = buildChartDockedDepthLadder({ depth: source, viewport: viewport(3), preferredRowHeight: 10 });
  assert.equal(model.visibleAskSize, 10, "visible ask quantities must be conserved exactly");
  assert.equal(model.visibleBidSize, 16, "visible bid quantities must be conserved exactly");
  const ask105 = model.rows.find((row) => row.askSize === 7);
  const bid95 = model.rows.find((row) => row.bidSize === 11);
  assert.ok(ask105 && ask105.top < 100, "higher prices must project above the chart midpoint");
  assert.ok(bid95 && bid95.top > 100, "lower prices must project below the chart midpoint");
  assert.ok(ask105.askCumulative >= 7, "ask cumulative depth must be retained above current price");
  assert.ok(bid95.bidCumulative >= 11, "bid cumulative depth must be retained below current price");
}

{
  const source = depth([sourceRow(120, 0, 9, -4), sourceRow(100, 0, 2, -1), sourceRow(80, 6, 0, 3)]);
  const centered = buildChartDockedDepthLadder({ depth: source, viewport: viewport(4, 90, 110), preferredRowHeight: 10 });
  assert.equal(centered.hiddenAboveCount, 1);
  assert.equal(centered.hiddenBelowCount, 1);
  assert.equal(centered.visibleAskSize, 2);
  assert.equal(centered.visibleBidSize, 0);
  assert.ok(centered.rows.filter((row) => row.coverage === "unavailable").every((row) => row.totalSize === 0), "no resting quantity may be fabricated outside delivered venue coverage");

  const panned = buildChartDockedDepthLadder({ depth: source, viewport: viewport(5, 110, 130), preferredRowHeight: 10 });
  assert.equal(panned.visibleAskSize, 9, "panning must reproject the authoritative source rather than retaining old screen rows");
  assert.equal(source.totalAskSize, 11, "viewport changes must never mutate authoritative source totals");
}

{
  const source = depth([sourceRow(104, 0, 4, -2), sourceRow(96, 8, 0, 3)]);
  const model = buildChartDockedDepthLadder({ depth: source, viewport: viewport(6, 80, 125, "logarithmic"), preferredRowHeight: 10 });
  const ask = model.rows.find((row) => row.askSize === 4);
  const bid = model.rows.find((row) => row.bidSize === 8);
  assert.ok(ask && bid && ask.top < bid.top, "logarithmic chart transforms must preserve price ordering");
}

{
  const rows = Array.from({ length: 2_000 }, (_, index) => {
    const price = 1_000 + index;
    return index < 1_000 ? sourceRow(price, 1, 0, 0.5) : sourceRow(price, 0, 2, -0.75);
  });
  const source = depth(rows);
  const following = buildChartDockedDepthLadder({ depth: source, viewport: viewport(7, 1_900, 2_100), preferredRowHeight: 10, scaleMode: "follow" });
  assert.ok(following.hiddenAboveCount > 0 && following.hiddenBelowCount > 0, "chart-follow must disclose authoritative depth outside the visible chart scale");
  assert.equal(following.scaleMode, "follow");

  const locked = buildChartDockedDepthLadder({ depth: source, viewport: viewport(8, 1_900, 2_100), preferredRowHeight: 10, scaleMode: "locked" });
  assert.equal(locked.visibleBidSize, following.visibleBidSize, "locking must freeze the selected chart range rather than detach into book-fit mode");
  assert.equal(locked.visibleAskSize, following.visibleAskSize, "locked and following modes use the same explicit price transform");
  assert.equal(locked.scaleMode, "locked");
}

const componentSource = readFileSync(resolve(projectRoot, "src/modules/dom-pro/components/ChartDockedDepthLadder.tsx"), "utf8");
const consolidatedClientSource = readFileSync(resolve(projectRoot, "src/modules/dom-pro/consolidatedLiquidityClient.ts"), "utf8");
const appSource = readFileSync(resolve(projectRoot, "src/App.tsx"), "utf8");
const pixiSource = readFileSync(resolve(projectRoot, "src/components/PixiBlackChart.tsx"), "utf8");
const engineSource = readFileSync(resolve(projectRoot, "src/market-data/engine/marketDataEngine.ts"), "utf8");
const bybitSource = readFileSync(resolve(projectRoot, "src/market-data/adapters/bybit.ts"), "utf8");
assert.match(componentSource, /useConsolidatedLiquidityFeed/, "the docked ladder must consume the server-side multi-venue liquidity fabric");
assert.doesNotMatch(componentSource, /useDomFeed|feed\.book|feed\.ticker|exchangeLabel/, "the docked ladder must never couple to the chart-selected venue or use a venue-specific fallback");
assert.doesNotMatch(componentSource, /BYBIT/, "consolidated warm-up must not be presented as a Bybit-specific ladder");
assert.match(componentSource, /MULTI-VENUE CLF/, "cold start must disclose the venue-independent consolidated source");
assert.doesNotMatch(consolidatedClientSource, /input\.exchange|exchangeLabel|selectedExchange/, "the consolidated request identity must remain independent of the chart-selected exchange");
assert.match(componentSource, /requestAnimationFrame\(animate\)/, "depth transitions must be synchronized to display frames");
assert.doesNotMatch(componentSource, /setInterval\(/, "the dock renderer must not introduce a fixed-FPS interval");
assert.match(componentSource, /HIDDEN\/RPI EXCLUDED/, "coverage limits must be disclosed in the UI");
assert.doesNotMatch(componentSource, /BOOK FIT/, "the ladder must never detach itself into a venue-book scale");
assert.match(componentSource, /"FOLLOW" : "LOCKED"/, "chart-follow must be the visible default and scale-lock the explicit alternate");
assert.match(componentSource, /setLockedViewport\(null\)/, "a symbol or chart identity change must safely restore chart-follow mode");
assert.match(componentSource, /drawCumulativeDepthBand/, "the ladder must render the DOM Pro cumulative V-shaped depth bands");
assert.match(appSource, /<Settings size=\{17\} \/>[\s\S]{0,900}<Rows3 size=\{17\} \/>/, "the dock toggle must sit immediately after Settings");
assert.match(appSource, /showCompactDom = terminalSettings\.showDOM && !domProOpen && !chartDepthLadderOpen/, "the compact DOM must be replaced while chart depth mode is active");
assert.match(pixiSource, /priceTransformCallbackRef\.current\?\.\(transform\)/, "the ladder must consume the chart engine's authoritative transform");
assert.match(engineSource, /orderbook:\$\{requestedDepth \?\? "default"\}/, "different requested depths must not share the wrong WebSocket identity");
assert.match(bybitSource, /\[1, 50, 200, 1000\]/, "Bybit linear and spot depth resolution must include the official 1000-level stream");
assert.match(bybitSource, /resolveBybitOrderBookDepth\(symbol\.marketKind, options\?\.depth\)/, "Bybit WebSocket topics must use the requested supported depth");
assert.match(bybitSource, /marketKind === "spot" \|\| marketKind === "margin" \? 50[\s\S]{0,100}: 200/, "existing compact DOM defaults must remain unchanged");

console.log("chart-docked depth ladder tests passed");
