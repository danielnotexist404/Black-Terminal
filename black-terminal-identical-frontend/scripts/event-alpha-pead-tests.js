import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessPeadEvidence } from "../server/event-alpha/pead-engine.js";
import { PeadNormalizedSourceAdapter } from "../server/event-alpha/pead-source-adapter.js";
import { rankCryptoCandidates } from "../server/event-alpha/repository.js";

const positiveEvidence = fixture();
const positive = assessPeadEvidence(positiveEvidence);
assert.equal(positive.signal.state, "POSITIVE_DRIFT");
assert.equal(positive.signal.direction, "LONG");
assert.ok(positive.metrics.epsSue > 0 && positive.metrics.revenueSue > 0);
assert.equal(positive.returnPath[0].abnormalReturnBps, 85, "stock return is adjusted for market beta and sector beta");
assert.equal(positive.returnPath[1].cumulativeAbnormalReturnBps, 120, "CAR is the exact sum of causal abnormal-return points");

const negative = assessPeadEvidence(fixture({ actuals: { eps: 0.5, revenue: 70 }, returnObservations: [point("2026-08-01T20:01:00Z", -60, 10, 0), point("2026-08-02T20:00:00Z", -25, 0, 0)] }));
assert.equal(negative.signal.state, "NEGATIVE_DRIFT");
assert.equal(negative.signal.direction, "SHORT");

const provisional = assessPeadEvidence(fixture({ returnObservations: [point("2026-08-01T20:01:00Z", 0, 0, 0)] }));
const fullyPriced = assessPeadEvidence(fixture({ returnObservations: [point("2026-08-01T20:01:00Z", provisional.metrics.expectedDriftBps, 0, 0)] }));
assert.equal(fullyPriced.signal.state, "FULLY_PRICED");
assert.equal(fullyPriced.signal.direction, "NEUTRAL");

const noTrade = assessPeadEvidence(fixture({ actuals: { eps: 1, revenue: 100 }, returnObservations: [point("2026-08-01T20:01:00Z", 0, 0, 0)] }));
assert.equal(noTrade.signal.state, "NO_TRADE", "zero surprise never becomes a directional signal");
assert.throws(() => assessPeadEvidence(fixture({ expectationAsOf: "2026-08-01T20:00:00Z" })), /predate/i, "same-time consensus is lookahead");
assert.throws(() => assessPeadEvidence(fixture({ returnObservations: [point("2026-08-01T19:59:00Z", 1, 0, 0)] })), /strictly ordered/i, "pre-announcement return evidence is rejected");

let authorization = null;
const adapter = new PeadNormalizedSourceAdapter({ url: "https://pead.example.test/feed", allowedHost: "pead.example.test", token: "private-test-token" }, async (_url, options) => {
  authorization = options.headers.authorization;
  return new Response(JSON.stringify({ events: [positiveEvidence], nextCursor: "cursor-2" }), { status: 200, headers: { "content-type": "application/json" } });
});
assert.deepEqual(adapter.health(), { status: "READY", reasonCode: null });
const polled = await adapter.poll({ cursorValue: "cursor-1" });
assert.equal(polled.assessments.length, 1);
assert.equal(polled.checkpoint.cursorValue, "cursor-2");
assert.equal(authorization, "Bearer private-test-token");
assert.doesNotMatch(JSON.stringify(polled), /private-test-token/, "provider credentials never enter evidence or browser projections");
assert.equal(new PeadNormalizedSourceAdapter({ url: "http://127.0.0.1/feed", allowedHost: "127.0.0.1", token: "x" }).health().status, "QUARANTINED", "SSRF/private hosts fail closed");

const ranked = rankCryptoCandidates([
  { id:"weak",canonical_event_id:"event-a",confidence:.6,remaining_alpha_bps:20,state:"OBSERVING",updated_at:"2026-08-01T00:00:00Z" },
  { id:"duplicate",canonical_event_id:"event-a",confidence:.2,remaining_alpha_bps:2,state:"DRAFT",updated_at:"2026-07-01T00:00:00Z" },
  { id:"asset-best",canonical_event_id:"event-c",confidence:.8,remaining_alpha_bps:180,state:"ARMED",updated_at:"2026-08-02T01:00:00Z" },
  { id:"strong",canonical_event_id:"event-b",confidence:.9,remaining_alpha_bps:-300,state:"ARMED",updated_at:"2026-08-02T00:00:00Z" },
  { id:"unverified",canonical_event_id:"missing",confidence:1,remaining_alpha_bps:1000,state:"ARMED",updated_at:"2026-08-03T00:00:00Z" }
], [{id:"event-a",asset_id:"aave",symbol:"AAVEUSDT"},{id:"event-b",asset_id:"bitcoin",symbol:"BTCUSDT"},{id:"event-c",asset_id:"aave",symbol:"AAVEUSDT"}], 10);
assert.deepEqual(ranked.map((row) => row.id), ["strong", "asset-best"], "ranking excludes unverified events, keeps the strongest thesis and prevents one asset monopolizing discovery");
assert.equal(ranked.find((row) => row.id === "asset-best").collapsed_event_count, 2, "collapsed event count preserves ranking provenance");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/202608280001_event_alpha_equity_pead.sql"), "utf8");
for (const table of ["event_alpha_pead_providers", "event_alpha_pead_events", "event_alpha_pead_evidence", "event_alpha_pead_signals", "event_alpha_pead_return_points"]) assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`, "i"));
assert.match(migration, /expectation_as_of < first_actionable_at/i);
assert.match(migration, /event_alpha_pead_evidence_immutable/i);
assert.match(migration, /event_alpha_ingest_pead_v1[\s\S]*?pg_advisory_xact_lock/i, "PEAD revisions are identity-serialized");
assert.match(migration, /revoke all on function public\.event_alpha_ingest_pead_v1\(uuid,jsonb\) from public, anon, authenticated/i);
assert.doesNotMatch(migration, /grant\s+.*\s+to\s+(?:anon|authenticated)/i);
assert.ok(migration.trimEnd().endsWith("commit;"));

console.log("Event Alpha Equity PEAD tests PASS — causal consensus, robust SUE, factor CAR, drift states, provider isolation, SSRF defense and service-only persistence verified.");

function fixture(overrides = {}) {
  return {
    providerEventId: "provider-event-1", cik: "320193", ticker: "TEST", issuer: "Test Issuer", fiscalPeriod: "2026-Q2",
    announcedAt: "2026-08-01T20:00:00Z", firstActionableAt: "2026-08-01T20:00:00Z", expectationAsOf: "2026-08-01T19:59:00Z", session: "AFTER_HOURS",
    actuals: { eps: 1.5, revenue: 120 }, consensus: { eps: 1, revenue: 100, contributorCount: 16 },
    history: { epsForecastErrors: [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15], revenueForecastErrors: [-8, -5, -3, 0, 3, 5, 8] },
    returnObservations: [point("2026-08-01T20:01:00Z", 100, 10, 10), point("2026-08-02T20:00:00Z", 40, 5, 0)],
    beta: 1, sectorBeta: 0.5, sourceConfidence: 0.96, costs: { roundTripBps: 8 },
    filingUrl: "https://www.sec.gov/Archives/test", consensusSourceUrl: "https://pead.example.test/consensus", priceSourceUrl: "https://pead.example.test/prices",
    sourceManifest: { filing: "SEC", consensus: "POINT_IN_TIME", returns: "ADJUSTED" }, ...overrides
  };
}
function point(observedAt, stockReturnBps, marketReturnBps, sectorReturnBps) { return { observedAt, price: 100, stockReturnBps, marketReturnBps, sectorReturnBps }; }
