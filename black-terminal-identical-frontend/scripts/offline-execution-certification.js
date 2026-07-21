import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for offline execution certification.`);
  return value;
};

const workerUrl = required("BLACK_CLOUD_WORKER_URL").replace(/\/$/, "");
const connectionId = required("BLACK_CLOUD_CERT_CONNECTION_ID");
const intentId = required("BLACK_CLOUD_CERT_INTENT_ID");
const startedAt = required("BLACK_CLOUD_CERT_STARTED_AT");
assert.equal(required("BLACK_CLOUD_OFFLINE_OPERATOR_CONFIRMATION"), "BROWSER CLOSED AND DEVICE OFFLINE", "Offline operator confirmation is invalid.");
const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });

const healthResponse = await fetch(`${workerUrl}/ready`, { signal: AbortSignal.timeout(10_000) });
assert.equal(healthResponse.ok, true, `Worker readiness returned ${healthResponse.status}.`);
const health = await healthResponse.json();
assert.equal(health.status, "ready");
assert.equal(health.running, true);
assert.equal(health.network, "testnet", "Offline certification must begin on testnet.");
assert.ok(Date.now() - Date.parse(health.lastTickAt) < 15_000, "Worker tick is stale.");

const [connection, snapshots, reconciliations, plans, audits, lease] = await Promise.all([
  one("connectivity_connections", "id,health_status,lifecycle_status,control_state,last_private_event_at,last_reconciled_at,last_error_code", (query) => query.eq("id", connectionId)),
  many("broker_connection_health", "worker_id,health_status,private_stream_status,reconciliation_status,reconnect_count,captured_at", (query) => query.eq("connection_id", connectionId).gte("captured_at", startedAt).order("captured_at", { ascending:false }).limit(20)),
  many("reconciliation_runs", "worker_id,trigger_type,status,differences,repairs,started_at,completed_at", (query) => query.eq("connection_id", connectionId).gte("started_at", startedAt).order("started_at", { ascending:false }).limit(20)),
  many("follower_execution_plans", "id,execution_order_id,risk_result,execution_status,rejection_reason,updated_at", (query) => query.eq("group_intent_id", intentId)),
  many("execution_audit_events", "worker_id,event_type,severity,created_at", (query) => query.eq("connection_id", connectionId).gte("created_at", startedAt).order("created_at", { ascending:false }).limit(200)),
  one("worker_leases", "worker_id,fencing_token,heartbeat_at,expires_at", (query) => query.eq("lease_key", `connection:${connectionId}`))
]);

assert.equal(connection.lifecycle_status, "HEALTHY");
assert.equal(connection.health_status, "CONNECTED_CLOUD");
assert.equal(connection.control_state, "ACTIVE");
assert.ok(Date.parse(connection.last_private_event_at) >= Date.parse(startedAt), "No private event arrived during the offline window.");
assert.ok(Date.parse(connection.last_reconciled_at) >= Date.parse(startedAt), "No reconciliation completed during the offline window.");
assert.ok(snapshots.some((row) => row.private_stream_status === "connected"), "No connected private-stream health snapshot exists.");
assert.ok(reconciliations.some((row) => ["MATCHED","REPAIRED"].includes(row.status)), "No successful offline reconciliation exists.");
assert.ok(plans.length > 0 && plans.every((row) => row.risk_result === "PASSED" && ["WORKING","PARTIALLY_FILLED","FILLED"].includes(row.execution_status)), "Follower execution plan did not pass and execute.");
assert.ok(plans.every((row) => row.execution_order_id), "A follower plan has no canonical OMS order.");
for (const event of ["PRIVATE_STREAM_STARTED","ORDER_SUBMITTED","VENUE_ACKNOWLEDGED"]) assert.ok(audits.some((row) => row.event_type === event), `Missing ${event} audit evidence.`);
assert.equal(lease.worker_id, health.workerId, "Health endpoint and database lease identify different workers.");
assert.ok(Date.parse(lease.expires_at) > Date.now(), "Worker lease is expired.");

console.log(JSON.stringify({ decision:"PASS",connectionId,intentId,workerId:health.workerId,fencingToken:lease.fencing_token,healthSnapshots:snapshots.length,reconciliations:reconciliations.length,followerPlans:plans.length,auditEvents:audits.length,certifiedAt:new Date().toISOString() }, null, 2));

async function one(table, columns, decorate) {
  const { data, error } = await decorate(supabase.from(table).select(columns)).single();
  if (error || !data) throw error || new Error(`${table} evidence missing.`);
  return data;
}
async function many(table, columns, decorate) {
  const { data, error } = await decorate(supabase.from(table).select(columns));
  if (error) throw error;
  return data || [];
}
