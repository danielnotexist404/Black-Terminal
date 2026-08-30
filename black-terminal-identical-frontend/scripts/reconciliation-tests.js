import assert from "node:assert/strict";
import fs from "node:fs";
import { diffBalances, diffOrders, diffPositions, findStalePositions } from "../server/exchanges/bybit-reconciliation.js";
import { normalizeBybitAccountEquitySnapshot, upsertBybitAccountEquitySnapshot } from "../server/exchanges/bybit-snapshot-store.js";
import { authoritativeAccountMoney, mergeFreshness, resolveAccountEquityFreshness } from "../server/strategy-automation/repository.js";

assert.deepEqual(diffBalances([{ asset:"USDT",total:100 }],[{ asset:"USDT",total:120 }])[0].type, "balance_changed");
assert.deepEqual(diffPositions([{ symbol:"BTCUSDT",direction:"long",quantity:1 }],[{ symbol:"BTCUSDT",direction:"long",quantity:.8 }])[0].type, "position_quantity_changed");
assert.equal(diffOrders([{ id:"local",exchange_order_id:"venue-1",status:"working" }],[])[0].type, "order_not_in_open_snapshot");
assert.equal(findStalePositions([{ id:"p1",symbol:"BTCUSDT",direction:"long",quantity:1 }],[])[0].id, "p1");
assert.deepEqual(diffOrders([{ id:"local",exchange_order_id:"venue-1",status:"working" }],[{ orderId:"venue-1" }]), []);

const observedAt = Date.parse("2026-08-30T13:00:00.000Z");
const metrics = {
  accountType: "UNIFIED",
  walletBalanceUsd: 201.25,
  equityUsd: 198.75,
  marginBalanceUsd: 199.5,
  availableBalanceUsd: 142.125,
  initialMarginUsd: 55,
  maintenanceMarginUsd: 2.5,
  unrealizedPnlUsd: -2.5,
  accountImRate: 0.02,
  accountMmRate: 0.001,
  updatedAt: observedAt
};
const normalized = normalizeBybitAccountEquitySnapshot(metrics, "2026-08-30T13:00:01.000Z");
assert.equal(normalized.equityUsd, 198.75, "Bybit totalEquity remains the authoritative Strategy Lab equity");
assert.equal(normalized.availableBalanceUsd, 142.125, "Bybit totalAvailableBalance remains authoritative instead of being reconstructed from coin.locked");
assert.equal(normalized.observedAt, "2026-08-30T13:00:00.000Z", "the venue observation time survives persistence");

let persisted = null;
const fakeSupabase = {
  from(table) {
    assert.equal(table, "broker_account_equity_snapshots");
    return {
      async upsert(value, options) {
        persisted = { value, options };
        return { error: null };
      }
    };
  }
};
await upsertBybitAccountEquitySnapshot(fakeSupabase, {
  accountId: "account-1",
  userId: "user-1",
  executionEnvironment: "MAINNET_LIVE",
  accountMetrics: metrics,
  capturedAt: "2026-08-30T13:00:01.000Z"
});
assert.equal(persisted.value.equity_usd, 198.75);
assert.equal(persisted.value.available_balance_usd, 142.125);
assert.equal(persisted.value.execution_environment, "MAINNET_LIVE");
assert.deepEqual(persisted.options, { onConflict: "account_id" });

const row = { equity_usd: "198.75", available_balance_usd: "142.125", observed_at: normalized.observedAt };
assert.deepEqual(authoritativeAccountMoney(row), { equity: 198.75, available: 142.125, timestamp: observedAt });
assert.equal(resolveAccountEquityFreshness(row, observedAt + 89_999), "LIVE");
assert.equal(resolveAccountEquityFreshness(row, observedAt + 90_001), "STALE");
assert.equal(resolveAccountEquityFreshness(null, observedAt), "UNAVAILABLE");
assert.equal(mergeFreshness("LIVE", "DEGRADED"), "DEGRADED");
assert.equal(mergeFreshness("STALE", "LIVE"), "STALE");

const initialSyncSource = fs.readFileSync(new URL("../server/exchanges/bybit.js", import.meta.url), "utf8");
const recurringSyncSource = fs.readFileSync(new URL("../server/exchanges/bybit-reconciliation.js", import.meta.url), "utf8");
const strategyRepositorySource = fs.readFileSync(new URL("../server/strategy-automation/repository.js", import.meta.url), "utf8");
const supervisorSource = fs.readFileSync(new URL("../server/cloud-execution/connection-supervisor.js", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(new URL("../supabase/migrations/202608300002_authoritative_broker_account_equity.sql", import.meta.url), "utf8");
assert.match(initialSyncSource, /syncBybitAccountToSupabase[\s\S]*upsertBybitAccountEquitySnapshot/, "initial account connection persists authoritative account metrics");
assert.match(recurringSyncSource, /syncBybitSnapshotAndReconcile[\s\S]*upsertBybitAccountEquitySnapshot/, "periodic Demo and Mainnet reconciliation refreshes authoritative account metrics");
assert.match(strategyRepositorySource, /broker_account_equity_snapshots/, "Strategy Lab reads the authoritative account-equity store");
assert.doesNotMatch(strategyRepositorySource, /timestamp:\s*Date\.now\(\),[\s\S]{0,80}freshness,[\s\S]{0,80}equity:/, "Strategy target equity is never assigned a request-time freshness timestamp");
assert.match(supervisorSource, /reconciliation_status:\s*runtime\.reconciling \? "RUNNING" : synchronizationState/, "health rows preserve SYNCHRONIZED after reconciliation");
assert.match(migrationSource, /execution_environment in \('DEMO', 'MAINNET_LIVE'\)/, "Demo and Mainnet use the same environment-tagged equity contract");
assert.match(migrationSource, /available_balance_usd/);
assert.match(migrationSource, /observed_at/);

console.log("Reconciliation tests passed: balances, authoritative account equity, source freshness, partial positions, missing orders, stale repair and duplicate prevention.");
