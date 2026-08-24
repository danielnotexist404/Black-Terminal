import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartPriceTransformSnapshot } from "../src/chart-engine/priceTransform.ts";
import {
  buildLiquidationPressureProfile,
  fitViewportToLiquidationProfile,
  resolvePressureSignificance
} from "../src/modules/dom-pro/liquidationPressureProfileModel.ts";
import type { LiquidationFieldSnapshot } from "../src/modules/liquidation-field/core/types.ts";

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
}

{
  const component = readFileSync(resolve(projectRoot, "src/modules/dom-pro/components/ChartDockedDepthLadder.tsx"), "utf8");
  assert.match(component, /MODELED LIQUIDATION EXPOSURE · NOT RESTING ORDERS/, "LPP must disclose that its field is modeled exposure rather than visible orders");
  assert.match(component, /LONG LIQ \/ FORCED SELL/, "long liquidation pressure semantics must be explicit");
  assert.match(component, /SHORT LIQ \/ FORCED BUY/, "short liquidation pressure semantics must be explicit");
  assert.match(component, /profileMode === "dom" && Boolean\(requestProjection\)/, "the consolidated order-book poller must stop while LPP is active");
}

console.log("liquidation pressure profile tests passed");
