import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartPriceTransformSnapshot } from "../src/chart-engine/priceTransform.ts";
import {
  buildCumulativeLiquidationPressureBand,
  buildLiquidationPressureProfile,
  classifyLiquidationPressureLifecycle,
  fitViewportToLiquidationProfile,
  resolveLiquidationNodeWidthRatio,
  resolvePressureSignificance
} from "../src/modules/dom-pro/liquidationPressureProfileModel.ts";
import type { LiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/types.ts";
import { DEFAULT_LIQUIDATION_FIELD_SETTINGS, resolveLiquidationFieldRuntimeSettings } from "../src/modules/liquidation-field/core/settings.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

function viewport(revision = 1, priceMin = 75, priceMax = 120): ChartPriceTransformSnapshot {
  return {
    revision,
    width: 320,
    height: 600,
    plotLeft: 0,
    plotRight: 300,
    plotTop: 38,
    plotBottom: 574,
    priceMin,
    priceMax,
    scaleMode: "linear",
    firstIndex: 0,
    lastIndex: 100
  };
}

{
  const saved = { ...DEFAULT_LIQUIDATION_FIELD_SETTINGS, horizon: "3W" as const };
  const lppOnly = resolveLiquidationFieldRuntimeSettings(saved, {
    liquidationProfileRequested: true,
    liquidationHeatmapVisible: false
  });
  assert.equal(lppOnly.horizon, "1D", "standalone live LPP must use the current verified persistent profile horizon");
  assert.equal(saved.horizon, "3W", "the standalone LPP runtime must not mutate the user's saved heatmap horizon");
  assert.equal(
    resolveLiquidationFieldRuntimeSettings(saved, { liquidationProfileRequested: true, liquidationHeatmapVisible: true }).horizon,
    "3W",
    "an active liquidation heatmap must retain the user's selected historical horizon"
  );
  assert.equal(
    resolveLiquidationFieldRuntimeSettings(saved, { liquidationProfileRequested: false, liquidationHeatmapVisible: false }).horizon,
    "3W",
    "inactive LPP must not alter BCLIF runtime scope"
  );
}

{
  assert.equal(classifyLiquidationPressureLifecycle([0, 0, 100]).state, "FORMING", "new exposure must be classified as forming rather than assumed fresh forever");
  assert.equal(classifyLiquidationPressureLifecycle([40, 45, 90]).state, "STRENGTHENING", "expanding residual exposure must be classified as strengthening");
  assert.equal(classifyLiquidationPressureLifecycle([100, 98, 102]).state, "ACTIVE", "persistent stable exposure must remain active");
  assert.equal(classifyLiquidationPressureLifecycle([100, 95, 50]).state, "DECAYING", "an unconfirmed contraction must remain decaying rather than claiming absorption");
  assert.equal(classifyLiquidationPressureLifecycle([100, 95, 50], [0, 20], [0, 1]).state, "TRIGGERED", "confirmed liquidation evidence with material residual must be triggered");
  assert.equal(classifyLiquidationPressureLifecycle([100, 80, 20], [0, 20], [0, 1]).state, "ABSORBED", "confirmed liquidation evidence with at most one-quarter residual must be absorbed");
  assert.equal(classifyLiquidationPressureLifecycle([100, 80, 5], [0, 20], [0, 1]).state, "EXHAUSTED", "confirmed liquidation evidence with at most five-percent residual must be exhausted");
  assert.equal(classifyLiquidationPressureLifecycle([100, 80, 5]).state, "DECAYING", "a near-empty shelf without an observed liquidation cannot be mislabeled exhausted");
  assert.equal(classifyLiquidationPressureLifecycle([0, 0, 0]).state, "EMPTY", "a never-populated price row must remain empty");
  assert.equal(classifyLiquidationPressureLifecycle([100, 80, 20], [20, 20], [1, 1]).observedNotional, 20, "rolling confirmed-event cells must use max rather than double-counting adjacent columns");
}

function snapshot(): LiquidationFieldSnapshot {
  const rows = 8;
  const columns = 2;
  const cells = rows * columns;
  const longExposure = new Float32Array(cells);
  const shortExposure = new Float32Array(cells);
  longExposure[rows + 2] = 100;
  longExposure[rows + 3] = 400;
  shortExposure[rows + 5] = 300;
  shortExposure[rows + 6] = 50;
  const combinedExposure = new Float32Array(cells);
  for (let index = 0; index < cells; index += 1) combinedExposure[index] = longExposure[index]! + shortExposure[index]!;
  const validity = new Uint8Array(cells);
  validity.fill(255, rows);
  const confidence = new Uint8Array(cells);
  confidence.fill(204, rows);
  const confirmedNotional = new Float32Array(cells);
  confirmedNotional[rows + 3] = 75;
  const confirmedCount = new Uint16Array(cells);
  confirmedCount[rows + 3] = 2;
  return {
    header: {
      schemaVersion: 1,
      modelVersion: "TEST",
      venue: "BYBIT",
      symbol: "BTCUSDT",
      horizon: "1D",
      startTime: 1,
      endTime: 2,
      minPrice: 80,
      maxPrice: 115,
      columns,
      rows,
      timeStepMs: 1,
      priceStep: 5,
      gridOrigin: 0,
      gridVersion: "TEST_GRID",
      exposureScale: 1,
      confidenceScale: 255,
      compression: "none",
      checksum: "test"
    },
    timestamps: new Float64Array([1, 2]),
    longExposure,
    shortExposure,
    combinedExposure,
    normalizedIntensity: new Uint8Array(cells),
    longNormalizedIntensity: new Uint8Array(cells),
    shortNormalizedIntensity: new Uint8Array(cells),
    confidence,
    validity,
    confirmedIntensity: new Uint8Array(cells),
    confirmedNotional,
    confirmedCount,
    cohorts: [],
    massLedger: {} as LiquidationFieldSnapshot["massLedger"],
    lifecycleEvents: [],
    confirmedEvents: [],
    cascade: [],
    coverage: {} as LiquidationFieldSnapshot["coverage"],
    confidenceBreakdown: {} as LiquidationFieldSnapshot["confidenceBreakdown"],
    buildTimeMs: 1,
    generatedAt: 2,
    certainty: "ESTIMATED_HIGH",
    authority: "PERSISTENT_NODE",
    collectorNodeId: "test-node"
  };
}

{
  const model = buildLiquidationPressureProfile({ snapshot: snapshot(), viewport: viewport(), currentPrice: 100 });
  assert.equal(model.longExposureTotal, 500, "latest causal long-liquidation exposure must be conserved");
  assert.equal(model.shortExposureTotal, 350, "latest causal short-liquidation exposure must be conserved");
  assert.equal(model.totalExposure, 850, "the profile total must be the sum of signed-side exposure");
  assert.equal(model.latestColumn, 1, "the newest valid causal column must drive the live profile");
  assert.equal(model.authority, "PERSISTENT_NODE", "model authority must remain visible to the ladder");
  assert.ok(model.rows.some((row) => row.side === "long" && row.longExposure === 400), "long liquidation pressure must remain directionally distinct");
  assert.ok(model.rows.some((row) => row.side === "short" && row.shortExposure === 300), "short liquidation pressure must remain directionally distinct");
  assert.ok(model.rows.some((row) => row.confirmedNotional === 75 && row.confirmedCount === 2), "observed liquidation calibration must survive price projection");
  assert.ok(model.rows.some((row) => row.isHeavy), "the distribution must identify heavy nodes");
  assert.ok(model.rows.some((row) => row.isCurrentPrice), "the current chart price must be registered to one model row");
  assert.ok(model.rows.every((row) => row.lifecycle.windowColumns > 0), "every projected row must carry a causal lifecycle window");

  const forcedSellBand = buildCumulativeLiquidationPressureBand(model, "long");
  const forcedBuyBand = buildCumulativeLiquidationPressureBand(model, "short");
  assert.equal(forcedSellBand.at(-1)?.cumulativeExposure, 500, "the lower V leg must conserve all below-market forced-sell exposure");
  assert.equal(forcedBuyBand.at(-1)?.cumulativeExposure, 350, "the upper V leg must conserve all above-market forced-buy exposure");
  assert.equal(forcedSellBand[0]?.ratio, 0, "the lower cumulative V leg must originate at current price");
  assert.equal(forcedBuyBand[0]?.ratio, 0, "the upper cumulative V leg must originate at current price");
  assert.equal(forcedSellBand.at(-1)?.ratio, 1, "the lower V leg must normalize only after conserving its genuine exposure");
  assert.equal(forcedBuyBand.at(-1)?.ratio, 1, "the upper V leg must normalize only after conserving its genuine exposure");
  assert.ok(forcedSellBand.every((point, index) => index === 0 || point.ratio >= forcedSellBand[index - 1]!.ratio), "the lower V leg must widen monotonically away from market");
  assert.ok(forcedBuyBand.every((point, index) => index === 0 || point.ratio >= forcedBuyBand[index - 1]!.ratio), "the upper V leg must widen monotonically away from market");
}

{
  const source = snapshot();
  const fitted = fitViewportToLiquidationProfile(viewport(), source);
  assert.equal(fitted.priceMin, 77.5, "model fit must include the lower half-bin of the absolute grid");
  assert.equal(fitted.priceMax, 117.5, "model fit must include the upper half-bin of the absolute grid");
}

{
  assert.equal(resolvePressureSignificance(0, 10, 100), 0, "zero model exposure must remain visually empty");
  assert.ok(resolvePressureSignificance(100, 10, 100) > resolvePressureSignificance(5, 10, 100), "heavy exposure must be more prominent than sub-noise exposure");
  const ordinaryWidth = resolveLiquidationNodeWidthRatio(0.5, 1, false, false);
  const heavyWidth = resolveLiquidationNodeWidthRatio(0.5, 1, true, false);
  const extremeWidth = resolveLiquidationNodeWidthRatio(0.5, 1, true, true);
  assert.ok(ordinaryWidth < heavyWidth && heavyWidth < extremeWidth, "heavy and extreme modeled nodes must receive progressively stronger extension");
  assert.ok(resolveLiquidationNodeWidthRatio(1, 0.02, true, true) < 0.2, "a tiny minority side cannot inherit a mixed row's extreme-node width");
}

{
  const component = readFileSync(resolve(projectRoot, "src/modules/dom-pro/components/ChartDockedDepthLadder.tsx"), "utf8");
  assert.match(component, /MODELED LIQUIDATION EXPOSURE · NOT RESTING ORDERS/, "LPP must disclose that its field is modeled exposure rather than visible orders");
  assert.match(component, /LONG LIQ \/ FORCED SELL/, "long liquidation pressure semantics must be explicit");
  assert.match(component, /SHORT LIQ \/ FORCED BUY/, "short liquidation pressure semantics must be explicit");
  assert.match(component, /profileMode === "dom" && Boolean\(requestProjection\)/, "the consolidated order-book poller must stop while LPP is active");
  assert.match(component, /drawCumulativeLiquidationPressureBand/, "LPP must render its truthful current-price-outward cumulative V field");
  assert.match(component, /resolveLiquidationNodeWidthRatio/, "LPP must expand statistically significant local pressure nodes independently of the V field");
  assert.match(component, /EXPOSURE STATE/, "LPP hover evidence must disclose the lifecycle state");
  assert.match(component, /UNCONFIRMED CONTRACTION · NOT LABELED AS ABSORPTION/, "LPP must not imply absorption without confirmed liquidation evidence");
  assert.match(component, /AWAITING VERIFIED PRESSURE CELLS/, "a verified snapshot with no drawable cells must never degrade into a silent black canvas");
  assert.match(component, /No unverified exposure is being substituted/, "the empty-state must remain explicit and fail closed");
}

console.log("liquidation pressure profile tests passed");
