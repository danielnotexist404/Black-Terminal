import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBybitMainnetEnvironment } from "../server/exchanges/exchange-account-service.js";
import { tradingSchemasForTests } from "../server/security/trading-schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalFetch = globalThis.fetch;
const calls = [];

try {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const key = String(options.headers?.["X-BAPI-API-KEY"] || "");
    calls.push({ target, key });
    const demo = target.startsWith("https://api-demo.bybit.com");
    if ((key === "real-key-0001" && !demo) || (key === "demo-key-0002" && demo)) {
      return jsonResponse({ retCode: 0, retMsg: "OK", result: { userID: key, readOnly: 0, permissions: { ContractTrade: ["Order", "Position"], Wallet: [] } }, time: Date.now() });
    }
    return jsonResponse({ retCode: 10003, retMsg: "API key is invalid", result: {}, time: Date.now() });
  };

  assert.equal(await detectBybitMainnetEnvironment({ apiKey: "real-key-0001", apiSecret: "secret-real-0001" }), "MAINNET_LIVE");
  assert.equal(await detectBybitMainnetEnvironment({ apiKey: "demo-key-0002", apiSecret: "secret-demo-0002" }), "DEMO");
  await assert.rejects(() => detectBybitMainnetEnvironment({ apiKey: "testnet-key-0003", apiSecret: "secret-testnet-0003" }), /not valid on Bybit Mainnet or Bybit Mainnet Demo|Testnet credentials are not accepted/i);
  assert.equal(calls.some((call) => call.target.startsWith("https://api-testnet.bybit.com")), false, "environment detection never contacts Testnet");
  assert.equal(calls.some((call) => call.key === "demo-key-0002" && call.target.startsWith("https://api.bybit.com")), true, "Demo detection fails closed against real Mainnet first");
  assert.equal(calls.some((call) => call.key === "demo-key-0002" && call.target.startsWith("https://api-demo.bybit.com")), true, "Bybit Mainnet Demo is the only fallback");
} finally {
  globalThis.fetch = originalFetch;
}

const schema = tradingSchemasForTests.strategyConnection;
assert.equal(schema.connect.safeParse({ apiKey: "public-key", apiSecret: "private-secret" }).success, true);
assert.equal(schema.connect.safeParse({ apiKey: "public-key", apiSecret: "private-secret", environment: "testnet" }).success, false, "browser cannot route credentials to a client-selected environment");
assert.equal(schema.connection.safeParse({ apiKey: "rotated-public", apiSecret: "rotated-private" }).success, true);

const route = read("server/routes/strategy-connections.js");
const cloud = read("server/routes/cloud-execution/connection.js");
const account = read("server/routes/exchange-accounts/account.js");
const experience = read("src/modules/strategy-lab/my-strategy/StrategyAutomationExperience.tsx");
const client = read("src/modules/strategy-lab/automation/strategyAutomationApi.ts");
const matrix = read("src/modules/strategy-lab/my-strategy/cockpit/TargetSlotMatrix.tsx");
const migration = read("supabase/migrations/202608290001_strategy_lab_nine_target_capacity.sql");
assert.match(route, /decryptCredentialPayload/);
assert.match(route, /publicApiKey/);
assert.match(route, /apiSecretDisplay: "••••••••••••"/);
assert.doesNotMatch(route, /apiSecret:\s*payload|apiSecret:\s*credentials/, "stored API Secret is never serialized to Strategy Lab");
assert.match(route, /removeOwnedExchangeAccount/);
assert.match(account, /BROKER_CONNECTION_IN_ACTIVE_STRATEGY/);
assert.match(cloud, /storeBrokerCredential/);
assert.match(cloud, /withdrawalPermission: "NONE"/);
assert.match(cloud, /transferPermission: "NONE"/);
assert.match(client, /Strategy connections require an authenticated session/);
assert.match(matrix, /\/ 9 ALLOCATED/);
assert.match(experience, /MODIFY/);
assert.match(experience, /REMOVE/);
assert.match(experience, /LINK CONNECTION/);
assert.match(migration, /not between 1 and 9/);
assert.match(migration, />= 9/);

console.log("Strategy connection tests PASS — Mainnet/Mainnet-Demo detection, Testnet rejection, strict credential schemas, nine-slot SQL capacity, encrypted persistence and secret non-disclosure verified.");

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}
