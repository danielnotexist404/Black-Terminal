import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
const themeSource = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");

assert.match(
  engineSource,
  /document\.addEventListener\("visibilitychange", this\.handleVisibilityChange\)/,
  "visibility recovery must listen on document, where browsers dispatch visibilitychange"
);
assert.doesNotMatch(
  engineSource,
  /window\.addEventListener\("visibilitychange", this\.handleVisibilityChange\)/,
  "the former window-level visibility listener silently misses background-tab suspension"
);
assert.match(engineSource, /window\.addEventListener\("pageshow", this\.handlePageShow\)/, "BFCache restoration must recover the chart surface");
assert.match(engineSource, /window\.addEventListener\("focus", this\.handleWindowFocus\)/, "foreground focus must recover a discarded browser frame");

const cancellationSource = engineSource.match(/  private cancelScheduledFrames\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
for (const frame of ["resizeRaf", "drawRaf", "renderRaf", "visibilityRecoveryRaf", "visibilitySettleRaf"]) {
  assert.match(cancellationSource, new RegExp(`cancelAnimationFrame\\(this\\.${frame}\\)`), `${frame} must be cancelled during suspension`);
  assert.match(cancellationSource, new RegExp(`this\\.${frame} = undefined`), `${frame} must be cleared so resumed market ticks cannot deadlock`);
}

const recoverySource = engineSource.match(/  private recoverVisibleSurface\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
assert.match(recoverySource, /this\.resize\(\)/, "foreground recovery must rebuild the physical canvas dimensions");
assert.match(recoverySource, /this\.draw\(\)/, "foreground recovery must rebuild chart geometry");
assert.match(recoverySource, /this\.app\.render\(\)/, "foreground recovery must commit a GPU frame before revealing the canvas");
assert.match(recoverySource, /this\.host\.classList\.remove\("chart-surface-recovering"\)/, "the surface is revealed only after a committed recovery frame");

assert.match(engineSource, /this\.webglContextLost = true;[\s\S]*?this\.cancelScheduledFrames\(\)/, "WebGL loss must invalidate abandoned frame IDs");
assert.match(engineSource, /this\.webglContextLost = false;[\s\S]*?this\.recoverVisibleSurface\(\)/, "WebGL restoration must use the complete surface recovery path");
assert.match(themeSource, /\.pixi-chart-host\s*\{[\s\S]*?background:\s*#000;/, "the chart host must stay black while its GPU surface is unavailable");
assert.match(themeSource, /\.pixi-chart-host\.chart-surface-recovering canvas\s*\{\s*visibility:\s*hidden;/, "an uncommitted restored surface must never flash white");

console.log("Chart visibility recovery tests PASS", {
  visibilityTarget: "document",
  recoveryEvents: ["visibilitychange", "pageshow", "focus", "webglcontextrestored"],
  staleFrameIdsCleared: 5,
  fallbackSurface: "black"
});
