import assert from "node:assert/strict";
import { DefiLlamaProtocolEconomicsSourceAdapter, SnapshotGovernanceSourceAdapter, TokenomistUnlockSourceAdapter } from "../server/event-alpha/live-source-adapters.js";
import { BybitPublicMarketEvidence } from "../server/event-alpha/market-evidence.js";

const clock = () => new Date("2026-08-25T12:07:31Z");
const snapshotCalls = [];
const snapshot = new SnapshotGovernanceSourceAdapter({ spaces: "aave.eth" }, async (url, options) => {
  snapshotCalls.push({ url: String(url), authorization: options.headers.authorization });
  return jsonResponse({ data: { proposals: [{
    id: "proposal-1", title: "Approve risk framework", choices: ["For", "Against"], start: 1787600000,
    end: 1787752800, created: 1787590000, state: "active", scores: [75, 25], scores_total: 100,
    scores_updated: 1787659000, space: { id: "aave.eth", name: "Aave", symbol: "AAVE" }
  }] } });
}, clock);
const governance = await snapshot.poll();
assert.equal(governance.envelopes.length, 1);
assert.equal(governance.envelopes[0].envelope.eventFamily, "GOVERNANCE");
assert.equal(governance.envelopes[0].expectation.asOf, "2026-08-25T12:00:00.000Z", "live expectations are bucketed for idempotency");
assert.ok(Date.parse(governance.envelopes[0].expectation.asOf) < Date.parse(governance.envelopes[0].envelope.firstActionableAt));
assert.equal(snapshotCalls[0].authorization, undefined, "Snapshot public ingestion never forwards credentials");

const llama = new DefiLlamaProtocolEconomicsSourceAdapter({ protocols: "aave:AAVEUSDT:0.45" }, async () => jsonResponse({ protocols: [{
  slug: "aave", displayName: "Aave", total24h: 1200, total48hto24h: 900, total7d: 7000, total30d: 27000,
  methodologyURL: "https://defillama.com/methodology"
}] }), clock);
const economics = await llama.poll();
assert.equal(economics.envelopes.length, 2, "each protocol emits completed evidence and the next causal expectation window");
const completed = economics.envelopes.find((row) => row.envelope.payload.state === "COMPLETED");
const scheduled = economics.envelopes.find((row) => row.envelope.payload.state === "SCHEDULED");
assert.ok(completed && scheduled);
assert.equal(completed.expectation, null, "the current observation cannot manufacture a backdated expectation");
assert.equal(scheduled.expectation.asOf, "2026-08-25T12:00:00.000Z");
assert.ok(Date.parse(scheduled.expectation.asOf) < Date.parse(scheduled.envelope.firstActionableAt));
assert.notEqual(completed.envelope.sourceEventId, scheduled.envelope.sourceEventId);

assert.deepEqual(new TokenomistUnlockSourceAdapter().health(), { status: "DISABLED", reasonCode: "TOKENOMIST_API_KEY_MISSING" }, "licensed unlock data remains honestly disabled without a key");

const marketCalls = [];
const market = new BybitPublicMarketEvidence({}, async (url, options) => {
  marketCalls.push({ url: String(url), authorization: options.headers.authorization });
  const target = new URL(url);
  if (target.pathname.endsWith("/tickers")) {
    const symbol = target.searchParams.get("symbol");
    return jsonResponse({ retCode: 0, result: { list: [{ lastPrice: symbol === "BTCUSDT" ? "70000" : "300", turnover24h: "100000000" }] } });
  }
  const symbol = target.searchParams.get("symbol");
  return jsonResponse({ retCode: 0, result: { list: [[String(Date.parse("2026-08-25T12:00:00Z")), "1", "1", "1", symbol === "BTCUSDT" ? "69000" : "290", "1", "1"]] } });
}, clock);
const evidence = await market.context({ symbol: "AAVEUSDT", eventTime: "2026-08-25T12:00:00Z" });
assert.equal(evidence.averageDailyDollarVolume, 100000000);
assert.ok(evidence.realizedAssetReturnBps > 0);
assert.ok(evidence.realizedBenchmarkReturnBps > 0);
assert.ok(marketCalls.every((call) => call.authorization === undefined), "market evidence uses public endpoints only");

console.log("Event Alpha live pipeline tests PASS — Snapshot, DefiLlama, licensed-source gating, causal windows, and public market evidence verified.");

function jsonResponse(body) { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }
