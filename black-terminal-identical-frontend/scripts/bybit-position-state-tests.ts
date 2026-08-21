import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalizeBybitPositions, bybitPositionKey } from "../server/exchanges/bybit-position-identity.js";
import { canonicalPositionKey, deduplicateCanonicalPositions, reconcileAuthoritativePositions } from "../src/positions/canonicalPosition.ts";
import { replaceBybitPositions } from "../server/exchanges/bybit-snapshot-store.js";
import { classifyBrokerSyncError } from "../api/portfolio/snapshot.js";
import { markPortfolioSnapshotFallback, unavailablePortfolioFreshness } from "../src/portfolio/portfolioFreshness.ts";
import type { PortfolioPosition } from "../src/positions/types.ts";
import type { PortfolioSnapshot } from "../src/portfolio/types.ts";

function position(patch: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    id: "venue-row-1",
    accountId: "account-1",
    exchange: "bybit",
    network: "mainnet",
    category: "linear",
    marketKind: "perpetual",
    positionIdx: 0,
    symbol: "BTCUSDT",
    direction: "long",
    quantity: 0.01,
    averagePrice: 64_000,
    currentPrice: 65_000,
    unrealizedPnl: 10,
    realizedPnl: 0,
    margin: 64,
    leverage: 10,
    liquidationPrice: 58_000,
    openedAt: 100,
    updatedAt: 100,
    ...patch
  };
}

const repeated = Array.from({ length: 10 }, (_, index) => position({ id: `db-${index}` }));
assert.equal(deduplicateCanonicalPositions(repeated).positions.length, 1, "ten identical snapshots must produce one row");
assert.equal(canonicalizeBybitPositions(repeated, "account-1").length, 1, "server canonicalization must be idempotent");

const eth = position({ id: "eth", symbol: "ETHUSDT", updatedAt: 101 });
assert.equal(deduplicateCanonicalPositions([position(), eth]).positions.length, 2, "two genuine identities must remain visible");

const hedgeLong = position({ id: "hedge-long", positionIdx: 1, direction: "long" });
const hedgeShort = position({ id: "hedge-short", positionIdx: 2, direction: "short" });
assert.notEqual(canonicalPositionKey(hedgeLong), canonicalPositionKey(hedgeShort));
assert.notEqual(bybitPositionKey(hedgeLong), bybitPositionKey(hedgeShort));
assert.equal(deduplicateCanonicalPositions([hedgeLong, hedgeShort]).positions.length, 2, "hedge long and short must remain distinct");

const update = position({ id: "new-db-row", quantity: 0.02, currentPrice: 66_000, updatedAt: 200 });
const reconciled = reconcileAuthoritativePositions([position()], [update]);
assert.equal(reconciled.positions.length, 1);
const rpcCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
const fakeSupabase = {
  async rpc(name: string, payload: Record<string, unknown>) {
    rpcCalls.push({ name, payload });
    return { data: [{ applied: true, row_count: 1 }], error: null };
  }
};
await replaceBybitPositions(fakeSupabase, "account-1", repeated, 1_700_000_000_000);
assert.equal(rpcCalls.length, 1, "one authoritative position snapshot must use one atomic database call");
assert.equal(rpcCalls[0].name, "replace_bybit_positions_snapshot_v1");
assert.equal((rpcCalls[0].payload.p_rows as unknown[]).length, 1, "database snapshot must be canonicalized before reconciliation");

function readProductionTree(relativeRoot: string): string {
  const root = new URL(`../${relativeRoot}/`, import.meta.url);
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path)) {
      const target = `${path}/${entry}`;
      if (statSync(target).isDirectory()) visit(target);
      else if (/\.(?:ts|tsx|js)$/.test(entry)) files.push(readFileSync(target, "utf8"));
    }
  };
  visit(fileURLToPath(root));
  return files.join("\n");
}
assert.equal(reconciled.positions[0].id, "venue-row-1", "updates must retain the stable UI record");
assert.equal(reconciled.positions[0].quantity, 0.02);
assert.equal(reconciled.positions[0].currentPrice, 66_000);

const closure = reconcileAuthoritativePositions([position(), eth], [eth]);
assert.deepEqual(closure.positions.map(canonicalPositionKey), [canonicalPositionKey(eth)], "authoritative closure must remove only the missing identity");

const verifiedSnapshot = {
  freshness: {
    ...unavailablePortfolioFreshness("verified"),
    status: "live",
    source: "broker-rest",
    brokerSyncedAt: 1_000,
    fetchedAt: 1_000
  },
  positions: [position({ snapshotStatus: "live" })]
} as PortfolioSnapshot;
const originalNow = Date.now;
try {
  Date.now = () => 41_001;
  const fallback = markPortfolioSnapshotFallback(verifiedSnapshot, new Error("network unavailable"));
  assert.equal(fallback.freshness.status, "stale");
  assert.equal(fallback.freshness.quarantinedPositionCount, 1);
  assert.equal(fallback.positions[0].snapshotStatus, "stale", "failed refresh must not present retained rows as live");
} finally {
  Date.now = originalNow;
}
assert.equal(classifyBrokerSyncError(Object.assign(new Error("credential envelope failed"), { code: "BROKER_CREDENTIAL_RECONNECT_REQUIRED" })).code, "CREDENTIAL_DECRYPTION_FAILED");
assert.equal(classifyBrokerSyncError(new Error("request timeout")).code, "BROKER_SYNC_FAILED");


const portfolioStoreSource = readFileSync(new URL("../src/portfolio/portfolioStore.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const positionPageSource = readFileSync(new URL("../src/modules/portfolio-manager/components/PortfolioManagerPage.tsx", import.meta.url), "utf8");
const accountServiceSource = readFileSync(new URL("../server/exchanges/exchange-account-service.js", import.meta.url), "utf8");
const reconciliationSource = readFileSync(new URL("../server/exchanges/bybit-reconciliation.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../server/security/trading-schemas.js", import.meta.url), "utf8");
const oauthSource = readFileSync(new URL("../server/routes/exchange-accounts/oauth-start.js", import.meta.url), "utf8");
const apiClientSource = readFileSync(new URL("../src/portfolio/portfolioApiClient.ts", import.meta.url), "utf8");
const positionManagerSource = readFileSync(new URL("../src/positions/positionManager.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../supabase/migrations/202608120002_bybit_position_identity.sql", import.meta.url), "utf8");
const connectionManagerSource = readFileSync(new URL("../src/connectivity/connectionManager.ts", import.meta.url), "utf8");

assert.match(portfolioStoreSource, /lastVerifiedSnapshots/);
assert.match(portfolioStoreSource, /if \(lastVerified\) return markPortfolioSnapshotFallback/);
assert.match(appSource, /position\.snapshotStatus === "live"/, "stale position rows must be quarantined from active UI and chart overlays");
assert.match(appSource, /portfolioRequestSequenceRef/);
assert.match(appSource, /requestSequence !== portfolioRequestSequenceRef\.current/);
assert.match(appSource, /window\.clearInterval\(timer\)/);
assert.match(reconciliationSource, /getBybitPositions\(credentials\)/);
assert.doesNotMatch(reconciliationSource, /getBybitPositions\(credentials,\s*\{[^}]*symbol/);
assert.doesNotMatch(reconciliationSource, /createBybitOrder|amendBybitOrder|cancelBybitOrder/);
assert.match(positionManagerSource, /deduplicateCanonicalPositions\(positions\)/);
assert.match(positionManagerSource, /canonicalPositionKey\(position\)/);
assert.match(positionManagerSource, /lifecycleState:\s*"closed"/);
assert.match(connectionManagerSource, /connectInFlight/);
assert.match(connectionManagerSource, /reconnectInFlight/);
assert.match(connectionManagerSource, /if \(active\) return active/);
assert.match(connectionManagerSource, /if \(!authenticationFailure\) void this\.reconnect/, "credential failures must not enter a reconnect loop");

const connectStart = positionPageSource.indexOf("async function handleConnectCex");
const connectEnd = positionPageSource.indexOf("async function handleBrokerAuthorization");
const connectSurface = positionPageSource.slice(connectStart, connectEnd);
assert.ok(connectStart >= 0 && connectEnd > connectStart);
assert.match(migrationSource, /replace_bybit_positions_snapshot_v1/);
assert.match(migrationSource, /for update/);
assert.match(migrationSource, /p_snapshot_started_at < v_position_snapshot_started_at/);
assert.match(migrationSource, /on conflict \(account_id, canonical_key\)/);
assert.match(migrationSource, /revoke all on function[\s\S]*from public, anon, authenticated/);
assert.doesNotMatch(connectSurface, /window\.prompt|\bprompt\s*\(/);
assert.match(reconciliationSource, /upsertPositions\(supabase, account\.id, positions, startedAt\)/);
assert.match(reconciliationSource, /venue_updated_at:\s*order\.venueUpdatedTime/);
assert.match(reconciliationSource, /\.lte\("venue_updated_at", order\.venueUpdatedTime\)/);
assert.doesNotMatch(positionPageSource, /enable offline cloud|Global account|Bybit Mainnet Live — real funds/i);
assert.doesNotMatch(connectSurface, /executionEnvironment|endpointProfile|\bnetwork\s*:/);
assert.doesNotMatch(accountServiceSource, /input\.(?:network|executionEnvironment|endpointProfile|liveConfirmation)/);
assert.match(accountServiceSource, /BYBIT_EXECUTION_ENVIRONMENTS\.MAINNET_LIVE/);
assert.match(accountServiceSource, /endpointProfile:\s*"GLOBAL"/);
assert.doesNotMatch(schemaSource, /exchangeSchemas[\s\S]*?endpointProfile[\s\S]*?oauth-start/);
assert.doesNotMatch(oauthSource, /req\.body\.endpointProfile/);
assert.match(apiClientSource, /server-owned policy, never browser inputs/);

const productionBrokerSources = [accountServiceSource, reconciliationSource, schemaSource, oauthSource, apiClientSource, connectSurface].join("\n");
assert.doesNotMatch(productionBrokerSources, /ENABLE LIVE BYBIT EXECUTION/);

console.log("Bybit position identity, authoritative snapshot, race, lifecycle, and production-lock tests passed.");
const productionUiAndServer = [readProductionTree("src"), readProductionTree("server"), readProductionTree("api")].join("\n");
assert.doesNotMatch(productionUiAndServer, /\bwindow\.prompt\b|(?:^|[^\w.])prompt\s*\(/m, "production source must not use blocking native prompts");
assert.doesNotMatch(productionUiAndServer, /ENABLE LIVE BYBIT EXECUTION/);
assert.doesNotMatch(positionPageSource, /enable offline cloud/i);
assert.doesNotMatch(reconciliationSource, /placeBybitOrder|amendBybitOrder|cancelBybitOrder/);
