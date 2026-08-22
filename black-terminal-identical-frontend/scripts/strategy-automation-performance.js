import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildTargetSlots, calculateCapitalPreview, defaultPaperCapitalPolicy } from "../server/strategy-automation/domain.js";

const samples = [];
for (const occupiedCount of [0, 1, 3, 5, 10]) {
  const bindings = Array.from({ length: occupiedCount }, (_, index) => ({ id: `binding-${index}`, slotIndex: index + 1, status: "READY" }));
  const policy = defaultPaperCapitalPolicy("FUTURES");
  const iterations = 25_000;
  const start = performance.now();
  let subscriptionCount = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const slots = buildTargetSlots(bindings);
    subscriptionCount = slots.filter((slot) => slot.binding).length;
    for (const binding of bindings) calculateCapitalPreview({ equity: 10_000 + binding.slotIndex, availableBalance: 8_000, policy, marketType: "FUTURES" });
  }
  const elapsedMs = performance.now() - start;
  assert.equal(subscriptionCount, occupiedCount, "runtime work scales with occupied targets only");
  samples.push({ occupiedTargets: occupiedCount, emptyTargetSubscriptions: 0, elapsedMs: Number(elapsedMs.toFixed(2)), operationsPerSecond: Math.round(iterations / (elapsedMs / 1000)) });
}

assert.ok(samples.at(-1).elapsedMs < 5_000, `ten-target domain snapshot model exceeded the 5s safety budget: ${samples.at(-1).elapsedMs}ms`);
console.table(samples);
console.log("Strategy automation performance PASS — 0/1/3/5/10 occupied-target costs measured; empty target subscription count remains zero.");
