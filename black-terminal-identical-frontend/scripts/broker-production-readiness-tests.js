import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canTransitionConnection, derivePersistedConnectionLifecycle } from "../server/exchanges/connection-lifecycle.js";
import { getBrokerAdapterDefinition, listBrokerAdapterDefinitions } from "../server/exchanges/broker-adapter-registry.js";
import { hashOAuthState, safeOAuthReturnPath } from "../server/exchanges/bybit-oauth.js";
import { ExchangeAdapter, assertExchangeAdapter } from "../server/cloud-execution/adapters/exchange-adapter.js";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

assert.equal(canTransitionConnection("DISCONNECTED", "RESTORING"), true);
assert.equal(canTransitionConnection("RESTORING", "CONNECTED_TRADING"), true);
assert.equal(canTransitionConnection("CONNECTED_TRADING", "AUTHENTICATION_ERROR"), false);
assert.equal(canTransitionConnection("CONNECTED_TRADING", "RECONNECTING"), true);
assert.equal(derivePersistedConnectionLifecycle({ status: "connected", trading_enabled: true, is_read_only: false, last_synced_at: new Date().toISOString() }), "CONNECTED_TRADING");
assert.equal(derivePersistedConnectionLifecycle({ status: "connected", trading_enabled: true, is_read_only: false, last_synced_at: new Date().toISOString() }, { private_stream: "disconnected" }), "EXECUTION_BLOCKED");
assert.equal(derivePersistedConnectionLifecycle({ status: "connected", trading_enabled: true, is_read_only: false }), "SYNCING");
assert.equal(derivePersistedConnectionLifecycle({ status: "connected", trading_enabled: false, is_read_only: true }), "CONNECTED_READ_ONLY");
assert.equal(derivePersistedConnectionLifecycle({ api_health: "failed" }), "AUTHENTICATION_ERROR");
assert.equal(derivePersistedConnectionLifecycle({}, null, { credential_state: "EXPIRED" }), "TOKEN_EXPIRED");

const bybit = getBrokerAdapterDefinition("bybit");
assert.equal(bybit.authorization.oauthAuthorization, true);
assert.equal(bybit.authorization.apiCredentials, true);
assert.equal(bybit.authorization.walletConnection, false);
assert.ok(listBrokerAdapterDefinitions().some((adapter) => adapter.id === "bybit"));
assert.equal(assertExchangeAdapter(new ExchangeAdapter({})).getCapabilities().provider, "unknown");

assert.equal(hashOAuthState("state-a"), hashOAuthState("state-a"));
assert.notEqual(hashOAuthState("state-a"), hashOAuthState("state-b"));
assert.equal(safeOAuthReturnPath("/positions"), "/positions");
assert.equal(safeOAuthReturnPath("https://attacker.invalid"), "/");
assert.equal(safeOAuthReturnPath("//attacker.invalid"), "/");

const router = read("src/execution/brokerRouter.ts");
assert.doesNotMatch(router, /getBrokerAdapter\(/, "Production BrokerRouter must not fall back to mock exchange execution.");
assert.match(router, /BROKER_CONNECTION_REQUIRED/);
assert.equal(fs.existsSync(path.join(root, "src/broker/mockExchangeBroker.ts")), false, "Mock execution adapter must not ship in the production path.");
assert.equal(fs.existsSync(path.join(root, "src/broker/brokerRegistry.ts")), false, "Mock broker registry must not ship in the production path.");

const orderRoute = read("server/routes/execution/order.js");
assert.match(orderRoute, /client_order_id/);
assert.match(orderRoute, /Idempotent-Replay/);
assert.match(orderRoute, /createCloudExchangeAdapter/);
assert.match(orderRoute, /adapter\.findOrderByClientOrderId/);
assert.match(orderRoute, /Automatic resubmission is blocked/);
assert.doesNotMatch(orderRoute, /account\.exchange\s*===\s*["']bybit["']/);
for (const route of [read("server/routes/execution/cancel.js"), read("server/routes/execution/modify.js")]) {
  assert.match(route, /createCloudExchangeAdapter/);
  assert.doesNotMatch(route, /account\.exchange\s*===\s*["']bybit["']/);
}
const migration = read("supabase/migrations/202608120001_broker_oauth_and_order_idempotency.sql");
assert.match(migration, /unique index if not exists idx_execution_orders_user_account_client_idempotency/i);
assert.match(migration, /broker_oauth_states/);

const callback = read("server/routes/exchange-accounts/oauth-callback.js");
assert.match(callback, /state_hash/);
assert.match(callback, /consumed_at/);
assert.doesNotMatch(callback, /apiSecret.*searchParams|accessToken.*searchParams|refreshToken.*searchParams/);
const clientSource = read("src/portfolio/portfolioApiClient.ts") + read("src/modules/portfolio-manager/components/PortfolioManagerPage.tsx");
assert.doesNotMatch(clientSource, /BYBIT_OAUTH_CLIENT_SECRET|EXCHANGE_CREDENTIAL_MASTER_KEY|SUPABASE_SERVICE_ROLE_KEY/);

const bybitSource = read("server/exchanges/bybit.js");
for (const code of ["INVALID_API_KEY", "INVALID_SIGNATURE", "INSUFFICIENT_PERMISSIONS", "RATE_LIMITED", "IP_RESTRICTION", "NETWORK_TIMEOUT"]) {
  assert.match(bybitSource, new RegExp(code));
}
assert.match(bybitSource, /X-Bapi-Limit-Status/);
assert.match(bybitSource, /X-Bapi-Limit-Reset-Timestamp/);

const adapterContract = read("server/cloud-execution/adapters/exchange-adapter.js");
for (const operation of ["beginAuthorization", "completeAuthorization", "refreshAuthorization", "validateCredentials", "getBalances", "getPositions", "placeOrder", "cancelOrder", "modifyOrder", "subscribePrivateData", "healthCheck", "reconnect"]) {
  assert.match(adapterContract, new RegExp(`${operation}\\(`), `Normalized adapter contract must expose ${operation}().`);
}

console.log("broker production readiness tests passed");
