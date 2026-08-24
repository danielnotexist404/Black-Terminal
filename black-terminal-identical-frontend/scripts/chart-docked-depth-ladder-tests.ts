import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
  buildStableLiquidityProjection,
  buildChartSynchronizedViewport,
  buildChartDockedDepthLadder,
  buildPriceFollowingViewport,
  resolveChartDockedProjectionRowCount,
  resolveLiquiditySignificance,
  translateChartViewportToDock
} from "../src/modules/dom-pro/chartDockedDepthLadderModel.ts";
import { ChartPriceViewportStore } from "../src/modules/dom-pro/chartPriceViewportStore.ts";
import { priceToScreenY, type ChartPriceTransformSnapshot } from "../src/chart-engine/priceTransform.ts";
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
  const first = buildStableLiquidityProjection(viewport(60, 70_000, 80_000), 80);
  const subBucketPan = buildStableLiquidityProjection(viewport(61, 70_050, 80_050), 80);
  assert.equal(first.priceStep, 200, "projection must select a canonical nice-number price step");
  assert.deepEqual(subBucketPan, first, "panning inside the same canonical edge buckets must not restart or redefine the liquidity projection");
}

{
  const plotHeight = 780;
  const rawRows = resolveChartDockedProjectionRowCount(plotHeight, 1);
  const balancedRows = resolveChartDockedProjectionRowCount(plotHeight, 20);
  const structuralRows = resolveChartDockedProjectionRowCount(plotHeight, 100);
  assert.ok(rawRows > balancedRows && balancedRows > structuralRows, "every aggregation preset must materially change canonical price-bin density");
  assert.ok(structuralRows < 80, "high aggregation must no longer collapse into the former 80-row hard floor");
  assert.ok(rawRows <= 220 && structuralRows >= 24, "projection density must remain inside the authenticated API/render contract");
}

{
  const noiseFloor = 10;
  const reference = 100;
  const ordinary = resolveLiquiditySignificance(5, noiseFloor, reference);
  const threshold = resolveLiquiditySignificance(10, noiseFloor, reference);
  const meaningful = resolveLiquiditySignificance(55, noiseFloor, reference);
  const extreme = resolveLiquiditySignificance(100, noiseFloor, reference);
  assert.ok(ordinary <= 0.035, "ordinary resting depth must remain a faint audit trace");
  assert.ok(threshold >= 0.08 && meaningful > threshold, "depth above the adaptive floor must gain monotonic visual prominence");
  assert.equal(extreme, 1, "the structural reference must retain full neon prominence");
}

{
  const source = depth([
    sourceRow(108, 0, 100, -5),
    sourceRow(100, 0, 8, -1),
    sourceRow(96, 6, 0, 2),
    sourceRow(92, 2, 0, 0.5)
  ]);
  const before = buildChartDockedDepthLadder({ depth: source, viewport: viewport(62, 90, 110), preferredRowHeight: 10 });
  const after = buildChartDockedDepthLadder({ depth: source, viewport: viewport(63, 91, 111), preferredRowHeight: 10 });
  const beforeNode = before.rows.find((row) => row.price === 100);
  const afterNode = after.rows.find((row) => row.price === 100);
  assert.ok(beforeNode && afterNode, "the same canonical price node must remain addressable after a pan");
  assert.equal(afterNode.key, beforeNode.key, "panning must preserve canonical node identity");
  assert.equal(afterNode.askSize, beforeNode.askSize, "panning alone must not change a resting node amount");
  assert.equal(afterNode.depthRatio, beforeNode.depthRatio, "panning alone must not renormalize node intensity");
  assert.ok(Math.abs(afterNode.height - beforeNode.height) < 1e-9, "panning at an unchanged scale must preserve canonical node height");
}

{
  const chartViewport = viewport(61, 77_200, 77_500);
  const referencePrice = 77_307.5;
  const fullRangeViewport = buildPriceFollowingViewport(chartViewport, referencePrice);
  assert.equal(fullRangeViewport.priceMax - fullRangeViewport.priceMin, CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD, "default follow mode must expose the promised 26,000 USD range");
  assert.ok(Math.abs((priceToScreenY(referencePrice, fullRangeViewport) ?? 0) - (priceToScreenY(referencePrice, chartViewport) ?? 1)) < 1e-8, "the full-range ladder live-price line must remain exactly aligned with the chart label");
}

{
  const chartViewport = viewport(611, 77_200, 77_500);
  const referencePrice = 77_307.5;
  const fullDockViewport: ChartPriceTransformSnapshot = {
    ...chartViewport,
    width: 320,
    height: 600,
    plotTop: 38,
    plotBottom: 574
  };
  const fullHeightViewport = buildPriceFollowingViewport(
    chartViewport,
    referencePrice,
    CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
    fullDockViewport
  );
  assert.equal(fullHeightViewport.plotTop, 38, "the ladder must begin below its own toolbar and column headings");
  assert.equal(fullHeightViewport.plotBottom, 574, "the ladder must project rows through its full dock height up to the footer");
  assert.equal(fullHeightViewport.priceMax - fullHeightViewport.priceMin, CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD, "using the full dock height must preserve the exact 26,000 USD range");
  assert.ok(Math.abs((priceToScreenY(referencePrice, fullHeightViewport) ?? 0) - (priceToScreenY(referencePrice, chartViewport) ?? 1)) < 1e-8, "expanding below the chart must preserve exact live-price alignment");
}

{
  const chartViewport = viewport(612, 77_200, 77_500);
  const referencePrice = 77_307.5;
  const chartY = priceToScreenY(referencePrice, chartViewport) ?? 0;
  const dockAlignedChartViewport = translateChartViewportToDock(chartViewport, 44);
  assert.equal((priceToScreenY(referencePrice, dockAlignedChartViewport) ?? 0) - chartY, 44, "the chart host's DOM offset must be added before comparing it with ladder-canvas coordinates");
  const fullDockViewport: ChartPriceTransformSnapshot = {
    ...chartViewport,
    width: 320,
    height: 600,
    plotTop: 38,
    plotBottom: 574
  };
  const alignedViewport = buildPriceFollowingViewport(
    dockAlignedChartViewport,
    referencePrice,
    CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
    fullDockViewport
  );
  assert.ok(Math.abs((priceToScreenY(referencePrice, alignedViewport) ?? 0) - (chartY + 44)) < 1e-8, "the ladder live-price line must include the chart host's measured vertical origin");
}

{
  const chartViewport = viewport(613, 57_187, 110_815);
  const dockAlignedChartViewport = translateChartViewportToDock(chartViewport, 44);
  const fullDockViewport: ChartPriceTransformSnapshot = {
    ...chartViewport,
    width: 320,
    height: 900,
    plotTop: 38,
    plotBottom: 874
  };
  const synchronized = buildChartSynchronizedViewport(dockAlignedChartViewport, fullDockViewport);
  for (const price of [57_187, 77_400, 84_001, 94_727, 110_815]) {
    assert.ok(Math.abs((priceToScreenY(price, synchronized) ?? 0) - (priceToScreenY(price, dockAlignedChartViewport) ?? 1)) < 1e-8, `chart-synchronized ladder price ${price} must occupy the chart's exact Y coordinate`);
  }
  assert.ok(synchronized.priceMin < chartViewport.priceMin, "the full-height ladder must continue the chart's pixels-per-price scale below the shorter chart pane");
  assert.equal(synchronized.scaleMode, chartViewport.scaleMode, "chart synchronization must retain the chart's scale semantics");
}

{
  const renderViewport: ChartPriceTransformSnapshot = {
    ...viewport(615, 57_187, 110_815),
    width: 320,
    height: 900,
    plotTop: 38,
    plotBottom: 874
  };
  for (const chartViewport of [
    viewport(616, 57_187, 110_815),
    viewport(617, 25_271, 145_040)
  ]) {
    const dockAligned = translateChartViewportToDock(chartViewport, 44);
    const synchronized = buildChartSynchronizedViewport(dockAligned, renderViewport);
    for (const price of [57_187, 77_500, 100_000]) {
      assert.ok(
        Math.abs((priceToScreenY(price, synchronized) ?? 0) - (priceToScreenY(price, dockAligned) ?? 1)) < 1e-8,
        `active structural scaling must keep ${price} registered to the chart on revision ${chartViewport.revision}`
      );
    }
  }
}

{
  const chartViewport = viewport(614, 57_187, 110_815, "logarithmic");
  const dockAlignedChartViewport = translateChartViewportToDock(chartViewport, 44);
  const fullDockViewport: ChartPriceTransformSnapshot = {
    ...chartViewport,
    width: 320,
    height: 900,
    plotTop: 38,
    plotBottom: 874
  };
  const synchronized = buildChartSynchronizedViewport(dockAlignedChartViewport, fullDockViewport);
  for (const price of [57_187, 77_400, 94_727, 110_815]) {
    assert.ok(Math.abs((priceToScreenY(price, synchronized) ?? 0) - (priceToScreenY(price, dockAlignedChartViewport) ?? 1)) < 1e-6, `logarithmic chart-synchronized ladder price ${price} must occupy the chart's exact Y coordinate`);
  }
}

{
  const chartViewport = viewport(62, 64_000, 82_000, "logarithmic");
  const referencePrice = 77_307.5;
  const fullRangeViewport = buildPriceFollowingViewport(chartViewport, referencePrice);
  assert.equal(fullRangeViewport.priceMax - fullRangeViewport.priceMin, CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD, "logarithmic follow mode must retain the exact dollar span");
  assert.ok(Math.abs((priceToScreenY(referencePrice, fullRangeViewport) ?? 0) - (priceToScreenY(referencePrice, chartViewport) ?? 1)) < 1e-6, "logarithmic charts must retain exact live-price registration");
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

  const bookFit = buildChartDockedDepthLadder({ depth: source, viewport: viewport(9, 1_900, 2_100), preferredRowHeight: 10, scaleMode: "book" });
  assert.equal(bookFit.visibleBidSize, source.totalBidSize, "optional book fit must conserve every delivered bid quantity");
  assert.equal(bookFit.visibleAskSize, source.totalAskSize, "optional book fit must conserve every delivered ask quantity");
  assert.equal(bookFit.hiddenAboveCount, 0, "optional book fit must not hide delivered asks");
  assert.equal(bookFit.hiddenBelowCount, 0, "optional book fit must not hide delivered bids");
  assert.equal(bookFit.scaleMode, "book");
}

const componentSource = readFileSync(resolve(projectRoot, "src/modules/dom-pro/components/ChartDockedDepthLadder.tsx"), "utf8");
const consolidatedClientSource = readFileSync(resolve(projectRoot, "src/modules/dom-pro/consolidatedLiquidityClient.ts"), "utf8");
const appSource = readFileSync(resolve(projectRoot, "src/App.tsx"), "utf8");
const pixiSource = readFileSync(resolve(projectRoot, "src/components/PixiBlackChart.tsx"), "utf8");
const engineSource = readFileSync(resolve(projectRoot, "src/market-data/engine/marketDataEngine.ts"), "utf8");
const bybitSource = readFileSync(resolve(projectRoot, "src/market-data/adapters/bybit.ts"), "utf8");
assert.match(componentSource, /useConsolidatedLiquidityFeed/, "the docked ladder must consume the server-side multi-venue liquidity fabric");
assert.doesNotMatch(componentSource, /useDomFeed|feed\.book|feed\.ticker|exchangeLabel/, "the docked ladder must never couple to the chart-selected venue or use a venue-specific fallback");
assert.match(componentSource, /: `CLF \$\{consolidated\.status\.toUpperCase\(\)\}/, "DOM warm-up must remain the venue-independent consolidated-liquidity status");
assert.match(componentSource, /MULTI-VENUE CLF/, "cold start must disclose the venue-independent consolidated source");
assert.doesNotMatch(consolidatedClientSource, /input\.exchange|exchangeLabel|selectedExchange/, "the consolidated request identity must remain independent of the chart-selected exchange");
assert.match(componentSource, /requestAnimationFrame\(animate\)/, "depth transitions must be synchronized to display frames");
assert.doesNotMatch(componentSource, /setInterval\(/, "the dock renderer must not introduce a fixed-FPS interval");
assert.match(componentSource, /HIDDEN\/RPI EXCLUDED/, "coverage limits must be disclosed in the UI");
assert.match(componentSource, /26K OVERVIEW/, "the independent 26,000 USD overview must remain an explicit optional scale");
assert.match(componentSource, /BOOK FIT/, "the previous delivered-book fitting behavior must remain an explicit optional mode");
assert.match(componentSource, /CHART SYNC/, "exact chart-scale confluence must be the default ladder mode");
assert.match(componentSource, /<option value="range">26K OVERVIEW<\/option>/, "the 26,000 USD full-range overview must remain available as an explicit optional mode");
assert.match(componentSource, /profileMode === "lpp" \? "MODEL FIT" : "BOOK FIT"/, "complete delivered-book fitting must remain available while LPP exposes its distinct model-fit range");
assert.match(componentSource, /return stored === "range" \|\| stored === "book" \? stored : "chart"/, "new workspaces must default to exact chart synchronization");
assert.match(componentSource, /view:v3:/, "existing persisted independent-scale choices must be retired so upgraded workspaces reopen in chart synchronization");
assert.match(componentSource, /resolveChartDockedProjectionRowCount/, "the aggregation selector must control canonical projection density rather than collapse into a fixed lower clamp");
assert.match(componentSource, /resolveLiquiditySignificance\(visual\.ask/, "ask shelves must use adaptive significance instead of raw square-root exaggeration");
assert.match(componentSource, /resolveLiquiditySignificance\(visual\.bid/, "bid shelves must use adaptive significance instead of raw square-root exaggeration");
assert.match(componentSource, /buildPriceFollowingViewport/, "the ladder must derive its moving full-range scale from the chart transform");
assert.match(componentSource, /size\.height - LADDER_FOOTER_HEIGHT_PX/, "the ladder must use its complete dock height instead of stopping at the chart pane boundary");
assert.match(componentSource, /chartHost\.getBoundingClientRect\(\)\.top - bounds\.top/, "the ladder must measure and correct the chart host's independent vertical coordinate origin");
assert.match(componentSource, /buildStableLiquidityProjection/, "high-frequency chart movement must use an anchored request projection instead of redefining depth bins per frame");
assert.match(consolidatedClientSource, /priceStep: String\(input\.priceStep\)/, "the client must send the canonical price step to the server compositor");
assert.match(componentSource, /model\.currentPriceY/, "the live-price line must use the exact transformed price coordinate rather than a row midpoint");
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
