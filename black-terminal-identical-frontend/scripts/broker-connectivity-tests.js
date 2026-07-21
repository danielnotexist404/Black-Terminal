import assert from "node:assert/strict";
import { BlackCloudRepository } from "../server/cloud-execution/repository.js";
import { decryptBrokerCredential, storeBrokerCredential } from "../server/cloud-execution/secret-vault.js";
import { assertConnectionTransition, allowsNewCloudExecution, canTransitionConnection } from "../server/cloud-execution/connection-lifecycle.js";
import { createCloudExchangeAdapter } from "../server/cloud-execution/adapters/registry.js";
import { validateBlackCloudRuntime } from "../server/cloud-execution/runtime-config.js";
import { resolveBybitBaseUrlsForTests } from "../server/exchanges/bybit.js";

assert.equal(canTransitionConnection("CREATED", "VALIDATING"), true);
assert.equal(canTransitionConnection("HEALTHY", "RECONNECTING"), true);
assert.equal(canTransitionConnection("RECONNECTING", "HEALTHY"), true);
assert.equal(canTransitionConnection("REVOKED", "HEALTHY"), false);
assert.throws(() => assertConnectionTransition("REVOKED", "HEALTHY"), /Invalid broker lifecycle/);
assert.equal(allowsNewCloudExecution({ lifecycle_status: "HEALTHY", control_state: "ACTIVE", connection_mode: "CLOUD_DELEGATED" }), true);
assert.equal(allowsNewCloudExecution({ lifecycle_status: "HEALTHY", control_state: "EMERGENCY_STOP", connection_mode: "CLOUD_DELEGATED" }), false);

const adapter = createCloudExchangeAdapter("bybit", { credentials: {}, network: "testnet" });
assert.equal(typeof adapter.subscribePrivateEvents, "function");
assert.equal(typeof adapter.reconcile, "function");

const previousMasterKey = process.env.BLACK_CLOUD_SECRET_MASTER_KEY;
process.env.BLACK_CLOUD_SECRET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
try {
  const vaultDb = createVaultDatabase();
  const stored = await storeBrokerCredential(vaultDb, { userId:"user-1",connectionId:"connection-1",provider:"bybit",secret:{apiKey:"server-only",apiSecret:"never-client"},publicIdentifier:"server-only",authorizationType:"trade_only_api_credential",permissionScope:{trading:true},withdrawalEnabled:false });
  assert.equal(stored.withdrawalEnabled, false);
  assert.equal(JSON.stringify(vaultDb.tables.broker_secret_vault).includes("server-only"), false);
  assert.deepEqual(await decryptBrokerCredential(vaultDb, stored.id), { apiKey:"server-only", apiSecret:"never-client" });
  const repository = new BlackCloudRepository(vaultDb, "worker-test");
  assert.deepEqual(await repository.readBrokerSecret(stored.id, "reconciliation"), { apiKey:"server-only", apiSecret:"never-client" });
  assert.equal(vaultDb.tables.execution_audit_events.at(-1).event_type, "CREDENTIAL_USED");
  const rotated = await storeBrokerCredential(vaultDb, { userId:"user-1",connectionId:"connection-1",provider:"bybit",secret:{apiKey:"rotated",apiSecret:"rotated-secret"},publicIdentifier:"rotated",authorizationType:"trade_only_api_credential",permissionScope:{trading:true},withdrawalEnabled:false });
  assert.equal(rotated.credentialVersion, 2);
  assert.equal(vaultDb.tables.broker_secret_references.filter((row) => row.status === "ACTIVE").length, 1);
  assert.equal(vaultDb.tables.broker_secret_vault.filter((row) => row.rotation_status === "ACTIVE").length, 1);
  assert.deepEqual(await decryptBrokerCredential(vaultDb, rotated.id), { apiKey:"rotated", apiSecret:"rotated-secret" });
} finally {
  if (previousMasterKey === undefined) delete process.env.BLACK_CLOUD_SECRET_MASTER_KEY;
  else process.env.BLACK_CLOUD_SECRET_MASTER_KEY = previousMasterKey;
}
const validRuntime = { SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service",EXCHANGE_CREDENTIAL_MASTER_KEY:Buffer.alloc(32, 7).toString("base64"),BLACK_CLOUD_INTENT_SIGNING_KEY:"x".repeat(32),BLACK_CLOUD_EXECUTION_ENABLED:"true",INVESTMENT_GROUP_EXECUTION_ENABLED:"true",BYBIT_CLOUD_EXECUTION_ENABLED:"true",BLACK_CLOUD_NETWORK:"testnet" };
assert.equal(validateBlackCloudRuntime(validRuntime).network, "testnet");
assert.throws(() => validateBlackCloudRuntime({ ...validRuntime, BLACK_CLOUD_NETWORK:"mainnet" }), /MAINNET_ENABLED/);
assert.throws(() => validateBlackCloudRuntime({ ...validRuntime, EXCHANGE_CREDENTIAL_MASTER_KEY:"invalid" }), /32 bytes/);
assert.throws(() => validateBlackCloudRuntime({ ...validRuntime, BYBIT_BASE_URL:"https://api.bybit.com" }), /api-testnet/);
assert.deepEqual(resolveBybitBaseUrlsForTests({ network:"testnet" }), ["https://api-testnet.bybit.com"]);
assert.throws(() => resolveBybitBaseUrlsForTests({ network:"testnet", baseUrl:"https://api.bybit.com" }), /testnet/);
const previousBybitBaseUrl = process.env.BYBIT_BASE_URL;
process.env.BYBIT_BASE_URL = "https://api.bybit.com";
try {
  assert.deepEqual(resolveBybitBaseUrlsForTests({ network:"testnet" }), ["https://api-testnet.bybit.com"]);
} finally {
  if (previousBybitBaseUrl === undefined) delete process.env.BYBIT_BASE_URL;
  else process.env.BYBIT_BASE_URL = previousBybitBaseUrl;
}
console.log("Broker connectivity tests passed: lifecycle, reconnect, adapter contract, credential boundary, emergency stop.");

function createVaultDatabase() {
  const tables = { broker_secret_vault: [], broker_secret_references: [], execution_audit_events: [] };
  let sequence = 0;
  return { tables, from(name) { return builder(name); }, async rpc(name, payload) {
    assert.equal(name, "black_cloud_store_encrypted_broker_secret");
    const oldReferences = tables.broker_secret_references.filter((row) => row.connection_id === payload.p_connection_id && row.status === "ACTIVE");
    for (const row of oldReferences) row.status = "ROTATED";
    for (const row of tables.broker_secret_vault.filter((item) => item.connection_id === payload.p_connection_id && item.rotation_status === "ACTIVE")) row.rotation_status = "ROTATED";
    const version = Math.max(0, ...tables.broker_secret_references.filter((row) => row.connection_id === payload.p_connection_id).map((row) => row.credential_version)) + 1;
    const vaultId=`id-${++sequence}`, referenceId=`id-${++sequence}`;
    tables.broker_secret_vault.push({id:vaultId,user_id:payload.p_user_id,connection_id:payload.p_connection_id,provider:payload.p_provider,encrypted_secret:payload.p_encrypted_secret,encryption_iv:payload.p_encryption_iv,authentication_tag:payload.p_authentication_tag,encryption_version:1,rotation_status:"ACTIVE"});
    const reference={id:referenceId,user_id:payload.p_user_id,connection_id:payload.p_connection_id,provider:payload.p_provider,vault_secret_id:vaultId,credential_version:version,credential_fingerprint:payload.p_credential_fingerprint,authorization_type:payload.p_authorization_type,permission_scope:payload.p_permission_scope,withdrawal_enabled:false,status:"ACTIVE",activated_at:new Date().toISOString()};
    tables.broker_secret_references.push(reference);
    return {data:reference,error:null};
  } };
  function builder(name) {
    const state = { filters: [], payload: null, mode: null };
    const api = {
      insert(payload) { state.mode="insert"; state.payload=payload; return api; },
      update(payload) { state.mode="update"; state.payload=payload; return api; },
      select() { return api; },
      eq(key,value) { state.filters.push([key,value]); return api; },
      async single() {
        if (state.mode === "insert") {
          const row = { id:`id-${++sequence}`,secret_reference_id:`ref-${sequence}`,created_at:new Date().toISOString(),rotation_status:"ACTIVE",credential_version:1,activated_at:new Date().toISOString(),...state.payload };
          tables[name].push(row); return { data:row,error:null };
        }
        const row = tables[name].find((item) => state.filters.every(([key,value]) => item[key] === value));
        return { data:row || null,error:row?null:new Error(`${name} row missing`) };
      },
      then(resolve) {
        if (state.mode === "insert") { tables[name].push(structuredClone(state.payload)); return Promise.resolve({error:null}).then(resolve); }
        if (state.mode === "update") for (const row of tables[name].filter((item) => state.filters.every(([key,value]) => item[key] === value))) Object.assign(row,state.payload);
        return Promise.resolve({error:null}).then(resolve);
      }
    };
    return api;
  }
}
