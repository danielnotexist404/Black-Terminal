import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BYBIT_EXECUTION_ENVIRONMENTS, normalizeBybitExecutionEnvironment, resolveBybitEndpointSet } from "../server/exchanges/bybit-endpoints.js";
import { assertCanArmStrategyTarget, defaultPaperCapitalPolicy } from "../server/strategy-automation/domain.js";
import { validateBlackCloudRuntime } from "../server/cloud-execution/runtime-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const endpointSet = resolveBybitEndpointSet({ executionEnvironment: BYBIT_EXECUTION_ENVIRONMENTS.DEMO });

assert.equal(endpointSet.rest, "https://api-demo.bybit.com", "signed demo REST traffic uses Bybit's dedicated demo host");
assert.equal(endpointSet.publicRest, "https://api.bybit.com", "public market data remains on Bybit Mainnet");
assert.equal(endpointSet.privateWebSocket, "wss://stream-demo.bybit.com/v5/private", "private account events use Bybit Demo WebSocket");
assert.equal(endpointSet.tradeWebSocket, undefined, "demo order entry never assumes unsupported WebSocket trading");
assert.equal(endpointSet.simulatedFunds, true);
assert.throws(() => normalizeBybitExecutionEnvironment("testnet"), /not part of the active.*certification path/i, "testnet is not selectable");

const policy = { ...defaultPaperCapitalPolicy("FUTURES"), maximumDailyLoss: 500, maximumDrawdown: 20 };
assert.doesNotThrow(() => assertCanArmStrategyTarget({ policy, marketType: "FUTURES", validation: { eligible: true }, executionEnvironment: "DEMO", environment: { STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true" } }));
assert.throws(() => assertCanArmStrategyTarget({ policy, marketType: "FUTURES", validation: { eligible: true }, executionEnvironment: "MAINNET_LIVE", environment: { STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true", BYBIT_DEMO_ENABLED: "true" } }), /real-funds mainnet/i);

const validRuntime = {
  BLACK_CLOUD_NODE_ID: "BLACK_CLOUD_NODE_01",
  BLACK_CLOUD_WORKER_REGION: "Singapore",
  BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT: "PRODUCTION",
  BLACK_CLOUD_DEPLOYMENT_COMMIT: "abcdef1",
  BLACK_CLOUD_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  SUPABASE_URL: "https://database.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-identity",
  BLACK_CLOUD_INTENT_SIGNING_KEY: "test-only-signing-key-that-is-long-enough",
  BLACK_CLOUD_SECRET_MASTER_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
  BLACK_CLOUD_MASTER_KEY_VERSION: "1",
  BLACK_CLOUD_EXECUTION_ENABLED: "true",
  BYBIT_CLOUD_EXECUTION_ENABLED: "true",
  STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: "true",
  INVESTMENT_GROUP_EXECUTION_ENABLED: "false",
  BLACK_CLOUD_EXECUTION_ENVIRONMENT: "DEMO",
  BYBIT_DEMO_ENABLED: "true",
  BYBIT_ENDPOINT_PROFILE: "GLOBAL"
};
assert.equal(validateBlackCloudRuntime(validRuntime).executionEnvironment, "DEMO");
assert.throws(() => validateBlackCloudRuntime({ ...validRuntime, BLACK_CLOUD_EXECUTION_ENVIRONMENT: "MAINNET_LIVE", BLACK_CLOUD_MAINNET_ENABLED: "true" }), /DEMO-isolated worker/i, "demo automation cannot start inside a real-funds worker");

const connectRoute = read("server/routes/exchange-accounts/connect-demo.js");
const accountService = read("server/exchanges/exchange-account-service.js");
const cloudRoute = read("server/routes/cloud-execution/connection.js");
const signalWorker = read("scripts/strategy-automation-worker.ts");
const brokerWorker = read("server/cloud-execution/worker.js");
const connectionSupervisor = read("server/cloud-execution/connection-supervisor.js");
const migration = read("supabase/migrations/202608230002_bybit_demo_strategy_execution.sql");
const schema = read("server/security/trading-schemas.js");

assert.match(connectRoute, /executionEnvironment:\s*BYBIT_EXECUTION_ENVIRONMENTS\.DEMO/, "the server, not the browser, chooses demo execution");
assert.match(accountService, /Client-provided[\s\S]*environment\/region fields are ignored/);
assert.doesNotMatch(schema.match(/"connect-demo":[\s\S]*?\.strict\(\)/)?.[0] || "", /environment|network|region|endpointProfile/, "the demo connection envelope accepts no routing controls");
assert.match(cloudRoute, /executionEnvironment !== BYBIT_EXECUTION_ENVIRONMENTS\.DEMO/);
assert.match(cloudRoute, /permissionReport\.withdrawal/);
assert.match(cloudRoute, /permissionReport\.transfer/);
assert.match(cloudRoute, /allow_strategy_execution/);
assert.doesNotMatch(cloudRoute, /prompt\s*\(|window\.prompt|ENABLE OFFLINE CLOUD EXECUTION/, "demo delegation has no phrase-entry gate");

assert.match(signalWorker, /execution_commands/);
assert.match(signalWorker, /strategy_signal_key/);
assert.match(signalWorker, /deterministic_client_order_id/);
assert.match(signalWorker, /conflictResolution/);
assert.match(signalWorker, /"REVERSE"/, "close-then-reverse is represented as one durable state-machine command");
assert.match(signalWorker, /ACCOUNT_SYMBOL_OCCUPIED_BY_UNOWNED_POSITION/, "manual positions block strategy mutation instead of being adopted");
assert.doesNotMatch(signalWorker, /placeBybitOrder|placeOrder\s*\(|cancelBybitOrder|modifyBybitOrder/, "the signal evaluator only emits durable commands");
assert.match(brokerWorker, /credentialEnvironment !== "DEMO"/);
assert.match(brokerWorker, /REAL_FUNDS_STRATEGY_EXECUTION_FORBIDDEN/);
assert.match(brokerWorker, /adapter\.placeOrder\(orderDraft, venueValidation\)/, "only the fenced broker worker submits a demo order");
assert.match(brokerWorker, /findBybitOrderByClientOrderId/, "ambiguous acknowledgements reconcile by deterministic venue identity");
assert.match(brokerWorker, /STRATEGY_REVERSE_WAITING_FOR_FLAT/);
assert.match(brokerWorker, /deterministicStrategyLegId/, "reversal close and entry legs have separate deterministic venue identities");
assert.match(brokerWorker, /STRATEGY_MAX_DAILY_LOSS/);
assert.match(brokerWorker, /venueValidation\.normalized\.quantity/);
assert.match(brokerWorker, /STRATEGY_POSITION_OWNERSHIP_REQUIRED/);
assert.match(connectionSupervisor, /latestStrategyOrder/);
assert.match(connectionSupervisor, /strategy_target_binding_id/, "position attribution requires a preceding strategy order");

assert.match(migration, /idx_execution_commands_strategy_signal/);
assert.match(migration, /idx_strategy_target_one_live_per_account/);
assert.match(migration, /command_type='PLACE_ORDER'/);
assert.match(migration, /ACTIVATE_BYBIT_DEMO_STRATEGY_EXECUTION/);
assert.doesNotMatch(migration, /ENABLE OFFLINE CLOUD EXECUTION/);
assert.match(migration, /coalesce\(auth\.role\(\),''\) <> 'service_role'/, "only the server service boundary can arm a target");

console.log("Bybit Demo strategy execution tests PASS — official endpoint isolation, server-owned routing, demo-only arming, durable idempotent commands, fenced REST submission, risk ceilings and withdrawal/transfer prohibition verified without placing an order.");
