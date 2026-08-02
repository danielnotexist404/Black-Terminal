import assert from "node:assert/strict";
import fs from "node:fs";
import { PERSISTENT_ADAPTER_OPERATIONS } from "../server/cloud-execution/adapters/exchange-adapter.js";
import { createCloudExchangeAdapter } from "../server/cloud-execution/adapters/registry.js";
import { assertProviderEndpoint, isProviderEndpointApproved, resolveApprovedProviderEndpoint } from "../server/cloud-execution/provider-allowlist.js";
import { providerEventIdentity, redactObject } from "../server/cloud-execution/repository.js";
import { tradingSchemasForTests } from "../server/security/trading-schemas.js";
import { BybitPrivateStreamClient } from "../server/exchanges/bybit-private-stream.js";

assert.equal(resolveApprovedProviderEndpoint("bybit", "testnet", "https"), "https://api-testnet.bybit.com");
assert.equal(isProviderEndpointApproved({ provider: "bybit", environment: "testnet", endpoint: "wss://stream-testnet.bybit.com/v5/private", protocol: "wss" }), true);
assert.equal(isProviderEndpointApproved({ provider: "bybit", environment: "testnet", endpoint: "https://127.0.0.1/steal" }), false);
assert.throws(() => assertProviderEndpoint({ provider: "bybit", environment: "mainnet", endpoint: "http://api.bybit.com" }), /HTTPS and WSS/);
assert.throws(() => assertProviderEndpoint({ provider: "bybit", environment: "mainnet", endpoint: "https://evil.example" }), /not approved/);

const adapter = createCloudExchangeAdapter("bybit", { credentials: {}, network: "testnet", connectionId: "connection-1" });
for (const operation of PERSISTENT_ADAPTER_OPERATIONS) assert.equal(typeof adapter[operation], "function", `${operation} must exist`);
assert.throws(() => createCloudExchangeAdapter("binance", {}), /No Black Cloud adapter/);

class AuthenticatedPrivateSocket {
  constructor() {
    this.OPEN = 1;
    this.readyState = 0;
    this.handlers = new Map();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  send(raw) {
    const request = JSON.parse(raw);
    if (request.op === "auth") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ op: "auth", success: true }) }));
    if (request.op === "subscribe") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ op: "subscribe", success: true }) }));
  }
  close() { this.readyState = 3; this.emit("close", {}); }
  emit(name, event) { this.handlers.get(name)?.(event); }
}

const stream = new BybitPrivateStreamClient(
  { apiKey: "public-test-key", apiSecret: "private-test-secret" },
  { network: "testnet", connectionId: "readiness-test", WebSocketCtor: AuthenticatedPrivateSocket }
);
await stream.connect();
assert.equal(stream.diagnostics().authenticated, true);
assert.equal(stream.diagnostics().status, "connected");
assert.ok(stream.diagnostics().subscriptionAcknowledgedAt);
stream.disconnect();

const event = { type: "execution", time: 123, fill: { fillId: "fill-7", orderId: "order-1", quantity: 1 } };
assert.equal(providerEventIdentity("BYBIT", event), providerEventIdentity("bybit", structuredClone(event)));
assert.notEqual(providerEventIdentity("bybit", event), providerEventIdentity("bybit", { ...event, time: 124 }));

const control = tradingSchemasForTests.cloud.control;
assert.equal(control.safeParse({ connectionId: "c", action: "pause-new-entries" }).success, true);
assert.equal(control.safeParse({ connectionId: "c", action: "cancel-all", cancelProtectiveOrders: true }).success, true);
assert.equal(control.safeParse({ connectionId: "c", action: "arbitrary" }).success, false);

const workerSource = fs.readFileSync(new URL("../server/cloud-execution/worker.js", import.meta.url), "utf8");
const fenceIndex = workerSource.indexOf("await this.repository.assertFencingToken(connection.id, fencingToken)");
const placeIndex = workerSource.indexOf("venueReport = await adapter.placeOrder", fenceIndex);
assert.ok(fenceIndex >= 0 && placeIndex > fenceIndex, "fencing must be asserted immediately before the external place-order call");

const migration = fs.readFileSync(new URL("../supabase/migrations/202608020001_phase5_chapter2b_persistent_connectivity.sql", import.meta.url), "utf8");
for (const table of ["broker_automation_mandates", "strategy_deployments", "strategy_runtime_state", "durable_execution_intents", "execution_outbox", "execution_inbox", "connection_audit_events", "investment_group_connection_assignments"]) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`, "i"));
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}
assert.match(migration, /black_cloud_assert_current_fencing_token/);
assert.match(migration, /black_cloud_store_encrypted_broker_secret_v2/);
assert.match(migration, /black_cloud_activate_automation_mandate/);
assert.equal(redactObject({ agentPrivateKey: "never", safe: "yes" }).agentPrivateKey, "[REDACTED]");

console.log("Persistent connectivity tests passed: allowlist, adapter contract, durable identity, emergency schema, fencing order, migration and redaction.");
