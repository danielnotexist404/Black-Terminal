import assert from "node:assert/strict";
import fs from "node:fs";
import { validateBlackCloudRuntime } from "../server/cloud-execution/runtime-config.js";
import { classifyWorkerClockHealth } from "../server/cloud-execution/clock-health.js";
import { runBrokerCredentialCryptoSelfTest } from "../server/cloud-execution/secret-vault.js";
import { runMandateSignatureSelfTest } from "../server/cloud-execution/canonical.js";
import { WORKER_STARTUP_PHASES } from "../server/cloud-execution/worker.js";

const key = Buffer.alloc(32, 17).toString("base64");
const valid = {
  BLACK_CLOUD_NODE_ID: "BLACK_CLOUD_NODE_01",
  BLACK_CLOUD_WORKER_REGION: "eu-existing-vps",
  BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT: "PRODUCTION",
  BLACK_CLOUD_DEPLOYMENT_COMMIT: "7a75e7c",
  BLACK_CLOUD_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only",
  BLACK_CLOUD_SECRET_MASTER_KEY_V1: key,
  BLACK_CLOUD_MASTER_KEY_VERSION: "1",
  BLACK_CLOUD_INTENT_SIGNING_KEY: "black-cloud-production-self-test-signing-key",
  BLACK_CLOUD_EXECUTION_ENABLED: "true",
  INVESTMENT_GROUP_EXECUTION_ENABLED: "true",
  BYBIT_CLOUD_EXECUTION_ENABLED: "true",
  BLACK_CLOUD_EXECUTION_ENVIRONMENT: "DEMO",
  BYBIT_DEMO_ENABLED: "true",
  BLACK_CLOUD_MAINNET_ENABLED: "false",
  BYBIT_ENDPOINT_PROFILE: "GLOBAL"
};

const runtime = validateBlackCloudRuntime(valid);
assert.equal(runtime.nodeId, "BLACK_CLOUD_NODE_01");
assert.equal(runtime.deploymentEnvironment, "PRODUCTION");
assert.equal(runtime.maxClockDriftMs, 3_000);
assert.throws(() => validateBlackCloudRuntime({ ...valid, SUPABASE_URL: "" }), /SUPABASE_URL/);
assert.throws(() => validateBlackCloudRuntime({ ...valid, BLACK_CLOUD_SECRET_MASTER_KEY_V1: "" }), /MASTER_KEY|master key/i);
assert.throws(() => validateBlackCloudRuntime({ ...valid, BLACK_CLOUD_DEPLOYMENT_COMMIT: "wrong-image" }), /Git commit/);
assert.throws(() => validateBlackCloudRuntime({ ...valid, BLACK_CLOUD_IMAGE_DIGEST: "sha256:short" }), /sha256 digest/);
assert.throws(() => validateBlackCloudRuntime({ ...valid, BLACK_CLOUD_EXECUTION_ENVIRONMENT: "MAINNET_LIVE", BYBIT_DEMO_ENABLED: "false" }), /MAINNET_ENABLED/);

assert.equal(classifyWorkerClockHealth({ systemTimestamp: 10_000, referenceTimestamp: 9_900, maxDriftMs: 3_000 }).status, "HEALTHY");
assert.equal(classifyWorkerClockHealth({ systemTimestamp: 10_000, referenceTimestamp: 8_000, maxDriftMs: 3_000 }).status, "WARNING");
assert.equal(classifyWorkerClockHealth({ systemTimestamp: 10_000, referenceTimestamp: 1_000, maxDriftMs: 3_000 }).status, "UNSAFE");
assert.equal(classifyWorkerClockHealth({ systemTimestamp: 10_000, referenceTimestamp: null, maxDriftMs: 3_000 }).status, "UNSAFE");

const previous = {
  master: process.env.BLACK_CLOUD_SECRET_MASTER_KEY_V1,
  version: process.env.BLACK_CLOUD_MASTER_KEY_VERSION,
  signing: process.env.BLACK_CLOUD_INTENT_SIGNING_KEY
};
process.env.BLACK_CLOUD_SECRET_MASTER_KEY_V1 = key;
process.env.BLACK_CLOUD_MASTER_KEY_VERSION = "1";
process.env.BLACK_CLOUD_INTENT_SIGNING_KEY = valid.BLACK_CLOUD_INTENT_SIGNING_KEY;
const cryptoResult = runBrokerCredentialCryptoSelfTest({ executionEnvironment: "DEMO", masterKeyVersion: 1 });
assert.equal(cryptoResult.status, "PASS");
assert.equal(cryptoResult.checks.tamperRejected, true);
assert.equal(cryptoResult.checks.wrongTenantRejected, true);
assert.equal(cryptoResult.checks.wrongProviderRejected, true);
assert.equal(cryptoResult.checks.wrongEnvironmentRejected, true);
assert.equal(runMandateSignatureSelfTest().checks.revokedMandateRejected, true);
restore("BLACK_CLOUD_SECRET_MASTER_KEY_V1", previous.master);
restore("BLACK_CLOUD_MASTER_KEY_VERSION", previous.version);
restore("BLACK_CLOUD_INTENT_SIGNING_KEY", previous.signing);

for (const phase of ["PROCESS_STARTING", "CONFIG_VALIDATING", "CRYPTO_SELF_TEST", "DATABASE_CONNECTING", "SCHEMA_VALIDATING", "LEASE_SUBSYSTEM_READY", "QUEUE_READY", "WORKER_READY", "CLOCK_UNSAFE"]) {
  assert.equal(WORKER_STARTUP_PHASES[phase], phase);
}

const migration = read("../supabase/migrations/202608020003_phase5_chapter2d_black_cloud_node01.sql");
assert.match(migration, /create table if not exists public\.black_cloud_nodes/i);
assert.match(migration, /create table if not exists public\.black_cloud_certification_records/i);
assert.match(migration, /alter table public\.black_cloud_nodes enable row level security/i);
assert.match(migration, /revoke all on public\.black_cloud_nodes from public,anon,authenticated/i);

const compose = read("../docker-compose.black-cloud.yml");
assert.match(compose, /restart: always/);
assert.match(compose, /pull_policy: never/);
assert.match(compose, /read_only: true/);
assert.match(compose, /no-new-privileges:true/);
assert.match(compose, /max-size: "10m"/);
assert.doesNotMatch(compose, /docker\.sock|privileged:\s*true|network_mode:\s*host/);

const worker = read("../server/cloud-execution/worker.js");
const fence = worker.indexOf("await this.repository.assertFencingToken(connection.id, fencingToken)");
const clock = worker.indexOf("this.assertSubmissionClockSafe()", fence);
const broker = worker.indexOf("venueReport = await adapter.placeOrder", fence);
assert.ok(fence >= 0 && clock > fence && broker > clock, "clock and fencing checks must immediately precede external order submission");
assert.match(worker, /writeNodeState\("DRAINING"\)/);
assert.match(worker, /WORKER_CLOCK_UNSAFE/);

const statusRoute = read("../server/routes/cloud-execution/status.js");
assert.match(statusRoute, /heartbeatAgeMs > 45_000/);
assert.match(statusRoute, /status: stale \? "OFFLINE"/);

console.log("Black Cloud production deployment tests passed: manifest, crypto, clock, node registry, stale heartbeat, immutable Compose and submission gates.");

function read(path) { return fs.readFileSync(new URL(path, import.meta.url), "utf8"); }
function restore(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
