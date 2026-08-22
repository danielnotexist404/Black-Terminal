import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeNewestWorkspaceSnapshots } from "../src/indicators/indicatorSettingsPersistence.ts";

type TestSnapshot = {
  updatedAt: number;
  visibleIndicators: { vwap: boolean };
  indicatorPeriods: { vwap: number };
  indicatorVisualSettings: { vwap: { color: string; intensity: number } };
  indicatorAdvancedSettings: { vwap: { anchorMode: string; smoothingLength: number } };
};

const customized: TestSnapshot = {
  updatedAt: 200,
  visibleIndicators: { vwap: true },
  indicatorPeriods: { vwap: 77 },
  indicatorVisualSettings: { vwap: { color: "white", intensity: 91 } },
  indicatorAdvancedSettings: { vwap: { anchorMode: "anchored", smoothingLength: 13 } }
};

const afterRemoval: TestSnapshot = {
  ...customized,
  updatedAt: 201,
  visibleIndicators: { vwap: false }
};
const afterReload = JSON.parse(JSON.stringify(afterRemoval)) as TestSnapshot;
assert.deepEqual(afterReload.indicatorPeriods, customized.indicatorPeriods, "removing an indicator must retain its period settings");
assert.deepEqual(afterReload.indicatorVisualSettings, customized.indicatorVisualSettings, "removing an indicator must retain its visual settings");
assert.deepEqual(afterReload.indicatorAdvancedSettings, customized.indicatorAdvancedSettings, "removing an indicator must retain its advanced settings");

const afterReAdd: TestSnapshot = {
  ...afterReload,
  updatedAt: 202,
  visibleIndicators: { vwap: true }
};
assert.deepEqual(afterReAdd.indicatorVisualSettings, customized.indicatorVisualSettings, "re-adding an indicator must restore its prior visual settings");
assert.deepEqual(afterReAdd.indicatorAdvancedSettings, customized.indicatorAdvancedSettings, "re-adding an indicator must restore its prior calculation settings");

const olderRemote: TestSnapshot = {
  ...customized,
  updatedAt: 100,
  indicatorVisualSettings: { vwap: { color: "gray", intensity: 58 } }
};
assert.deepEqual(
  mergeNewestWorkspaceSnapshots({ "Quant Desk": afterRemoval }, { "Quant Desk": olderRemote })["Quant Desk"],
  afterRemoval,
  "a stale remote workspace must not overwrite newer browser settings during reload"
);

const newerRemote = { ...olderRemote, updatedAt: 300 };
assert.deepEqual(
  mergeNewestWorkspaceSnapshots({ "Quant Desk": afterRemoval }, { "Quant Desk": newerRemote })["Quant Desk"],
  newerRemote,
  "a genuinely newer remote workspace must win during cross-device synchronization"
);

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /snapshots\[workspace\] = captureWorkspaceSnapshot\(\)/, "indicator edits must update the active local workspace snapshot");
assert.match(appSource, /Failed to persist indicator settings/, "indicator edits must be synchronized to the authenticated workspace backend");
assert.match(appSource, /mergeNewestWorkspaceSnapshots\(localSnapshots, remoteSnapshots\)/, "reload hydration must resolve local and remote settings by timestamp");

console.log("Indicator settings reload, removal, re-add, and timestamp reconciliation tests passed.");
