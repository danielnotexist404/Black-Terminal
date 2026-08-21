import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyBrokerSyncError } from "../api/portfolio/snapshot.js";
import { markPortfolioSnapshotFallback } from "../src/portfolio/portfolioFreshness.ts";
import type { PortfolioSnapshot } from "../src/portfolio/types.ts";

const originalNow = Date.now;
try {
  const verified = {
    freshness: {
    status: "live",
    source: "broker-rest",
    fetchedAt: 1_000,
      brokerSyncedAt: 1_000,
      blockerCode: null,
    ageMs: 0,
    staleAfterMs: 30_000,
      message: "verified"
    }
  } as PortfolioSnapshot;

  Date.now = () => 11_000;
  const degraded = markPortfolioSnapshotFallback(verified, new Error("network unavailable"));
  assert.equal(degraded.freshness.status, "degraded");
  assert.equal(degraded.freshness.source, "last-verified");
  assert.equal(degraded.freshness.ageMs, 10_000);
  assert.equal(verified.freshness.status, "live", "fallback marking mutated the verified snapshot");

  Date.now = () => 41_001;
  const stale = markPortfolioSnapshotFallback(verified, "timeout");
  assert.equal(stale.freshness.status, "stale");
  assert.match(stale.freshness.message, /last verified/i);
} finally {
  Date.now = originalNow;
}

assert.deepEqual(classifyBrokerSyncError(new Error("Unsupported state or unable to authenticate data")), {
  code: "CREDENTIAL_DECRYPTION_FAILED",
  message: "Stored broker credentials cannot be decrypted. Restore the original master key or reconnect the same broker account."
});
assert.equal(classifyBrokerSyncError(new Error("request timeout")).code, "BROKER_SYNC_FAILED");

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const realtime = readFileSync(new URL("../src/portfolio/portfolioRealtime.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/202608210001_portfolio_realtime_freshness.sql", import.meta.url), "utf8");
assert.match(app, /subscribePortfolioRealtime/);
assert.match(app, /document\.hidden \? 180_000 : 60_000/, "REST remained the 15-second primary position transport");
assert.doesNotMatch(app, /setInterval\(load, document\.hidden \? 60_000 : 15_000\)/);
assert.match(realtime, /account_positions/);
assert.match(realtime, /execution_orders/);
assert.match(migration, /auth\.uid\(\)/);
assert.match(migration, /alter publication supabase_realtime add table public\.account_positions/);

console.log("Portfolio freshness status, explicit stale fallback, realtime invalidation, and bounded REST fallback tests: PASS");
