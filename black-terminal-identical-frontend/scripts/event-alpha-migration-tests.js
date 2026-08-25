import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "supabase/migrations/20260820014838_phase5_event_alpha_engine.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
const liveSql = fs.readFileSync(path.join(root, "supabase/migrations/20260825013000_event_alpha_live_pipeline.sql"), "utf8");
const tables = [
  "event_alpha_sources","event_alpha_raw_events","event_alpha_canonical_events","event_alpha_event_revisions",
  "event_alpha_expectation_snapshots","event_alpha_asset_profiles","event_alpha_surprise_assessments","event_alpha_response_forecasts",
  "event_alpha_theses","event_alpha_thesis_transitions","event_alpha_risk_decisions","event_alpha_trade_intents",
  "event_alpha_paper_orders","event_alpha_paper_fills","event_alpha_paper_positions","event_alpha_decision_audit","event_alpha_source_checkpoints",
  "event_alpha_processing_jobs","event_alpha_model_artifacts","event_alpha_backtest_runs"
];
for (const table of tables) {
  assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, "i"), `${table} must exist`);
}
assert.match(sql, /foreach table_name[\s\S]*?enable row level security/i, "all Event Alpha tables must enable RLS");
assert.match(sql, /revoke all on table public\.%I from public, anon, authenticated/i, "browser roles must receive no direct table authority");
assert.match(sql, /grant select, insert, update on table public\.%I to service_role/i, "service role is the explicit server authority");
assert.doesNotMatch(sql, /grant select, insert, update, delete/i, "routine Event Alpha service authority does not include destructive delete");
assert.match(sql, /check \(as_of < first_actionable_at\)/i, "expectations must predate first actionable evidence");
assert.match(sql, /mode text not null default 'PAPER' check \(mode = 'PAPER'\)/i, "database must forbid Event Alpha live intents");
assert.match(sql, /for update skip locked/i, "job claims must be concurrent-worker safe");
assert.match(sql, /event_alpha_ingest_token_unlock_v1[\s\S]*?pg_advisory_xact_lock[\s\S]*?for update/i, "ingestion must serialize each canonical identity transactionally");
assert.match(sql, /event_alpha_ingest_token_unlock_v1[\s\S]*?insert into public\.event_alpha_processing_jobs[\s\S]*?'ASSESS'[\s\S]*?on conflict \(idempotency_key\) do nothing/i, "ingestion and assessment enqueue must share one durable transaction");
assert.match(sql, /event_alpha_insert_expectation_v1[\s\S]*?expectation_key = p_expectation_key/i, "expectation snapshots require atomic idempotency");
assert.match(sql, /event_alpha_create_paper_intent_v1[\s\S]*?EVENT_ALPHA_THESIS_VERSION_CONFLICT[\s\S]*?PENDING_APPROVAL/i, "risk, tactical trigger, and paper intent are atomic and version fenced");
assert.match(sql, /event_alpha_approve_paper_intent_v1[\s\S]*?PAPER_EXECUTE[\s\S]*?status = 'QUEUED'/i, "manual approval and durable paper enqueue are atomic");
assert.match(sql, /status = 'PROCESSING' and j\.locked_until <= now\(\)/i, "expired work leases must be restart recoverable");
assert.match(sql, /event_alpha_reject_immutable_mutation_v1/i, "immutable ledgers require mutation rejection");
assert.match(sql, /idx_event_alpha_audit_idempotency[\s\S]*?correlation_id, decision_type, outcome, evidence_hash/i, "audit trace writes require stable idempotency");
assert.equal((sql.match(/^begin;$/gim) || []).length, 1, "migration has one transaction start");
assert.equal((sql.match(/^commit;$/gim) || []).length, 1, "migration has one transaction commit");
assert.ok(sql.trimEnd().endsWith("commit;"), "no SQL may trail the final commit");
assert.equal((sql.match(/\$\$/g) || []).length % 2, 0, "dollar-quoted function bodies must be balanced");
assert.doesNotMatch(sql, /grant\s+.*\s+to\s+(?:anon|authenticated)/i, "no Event Alpha grant may expose direct browser authority");
assert.equal((sql.match(/create or replace function public\.event_alpha_/gi) || []).length, 8, "the migration contains the reviewed Event Alpha function set");
assert.match(liveSql, /event_alpha_ingest_canonical_v2[\s\S]*?pg_advisory_xact_lock[\s\S]*?event_alpha_processing_jobs/i, "live canonical ingestion and assessment enqueue are atomic");
assert.match(liveSql, /event_alpha_persist_live_assessment_v1/i, "live assessment persistence must be transactional");
assert.match(liveSql, /revoke all on function public\.event_alpha_ingest_canonical_v2[\s\S]*?from public, anon, authenticated/i, "live ingestion RPC must remain server-only");
assert.doesNotMatch(liveSql, /grant\s+.*\s+to\s+(?:anon|authenticated)/i, "live Event Alpha RPCs cannot be exposed to browser roles");
assert.ok(liveSql.trimEnd().endsWith("commit;"), "live migration must commit atomically");

console.log(`Event Alpha migration contracts PASS — ${tables.length} service-only RLS tables and causal/paper invariants verified.`);
