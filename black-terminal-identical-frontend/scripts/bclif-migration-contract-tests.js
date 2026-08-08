import assert from "node:assert/strict";
import fs from "node:fs";

const foundationPath = "supabase/migrations/202608050001_bclif_liquidation_intelligence_foundation.sql";
const successorPath = "supabase/migrations/202608050002_bclif_persistent_market_memory.sql";
const foundation = fs.readFileSync(foundationPath, "utf8");
const sql = fs.readFileSync(successorPath, "utf8");
const security = fs.readFileSync("server/security/securityMiddleware.js", "utf8");
const api = fs.readFileSync("api/liquidation-intelligence/[action].js", "utf8");
const apiService = fs.readFileSync("server/liquidation-intelligence/api/service.js", "utf8");

for (const table of ["bclif_sources", "bclif_coverage", "bclif_confirmed_liquidation_events", "bclif_field_chunks", "bclif_model_evaluations"]) {
  assert.match(foundation, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, "i"), `${table} must remain rooted in the foundation migration`);
  assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"), `${table} must remain client-inaccessible`);
}

const newTables = [
  "bclif_collector_nodes",
  "bclif_collector_instances",
  "bclif_source_offsets",
  "bclif_event_deduplication",
  "bclif_canonical_event_chunks",
  "bclif_cohort_checkpoints",
  "bclif_tile_supersessions",
  "bclif_compaction_runs",
  "bclif_retention_policies",
  "bclif_object_deletion_queue",
  "bclif_cluster_predictions",
  "bclif_cluster_outcomes",
  "bclif_certification_records"
];

for (const table of newTables) {
  assert.match(sql, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, "i"), `${table} is required`);
  assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"), `${table} must enable RLS`);
  assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"), `${table} must revoke client roles`);
}

assert.match(sql, /primary key \(source_id, horizon\)/i);
assert.match(sql, /alter column trade_coverage_percent drop not null/i);
assert.match(sql, /source_intervals jsonb not null default/i);
assert.match(sql, /jsonb_typeof\(source_intervals->'OPEN_INTEREST'\) = 'array'/i);
assert.match(sql, /add column if not exists coverage_version integer;/i);
assert.match(sql, /update public\.bclif_coverage set coverage_version = 1 where coverage_version is null/i);
assert.match(sql, /alter column coverage_version set not null/i);
assert.match(sql, /alter column coverage_version set default 2/i);
assert.match(sql, /coverage_version in \(1,2\)/i);
assert.match(sql, /coverage_version = 1 or \(requested_start is not null and requested_end is not null\)/i);
assert.match(sql, /\(requested_start is null and requested_end is null\) or \(requested_start is not null and requested_end is not null and requested_end > requested_start\)/i);
assert.match(sql, /\(model_start is null and model_end is null\) or \(model_start is not null and model_end is not null and model_end > model_start\)/i);
assert.match(sql, /requested_start is null or available_start is null or available_start >= requested_start/i);
assert.match(sql, /requested_end is null or model_end is null or model_end <= requested_end/i);
assert.match(sql, /octet_length\(source_intervals::text\) <= 4194304/i);
assert.match(sql, /octet_length\(missing_intervals::text\) <= 1048576/i);
assert.match(sql, /source_mode in \('PERSISTENT_COLLECTOR','BROWSER_SESSION','MIXED','UNAVAILABLE'\)/);
assert.match(sql, /model_authority in \('PERSISTENT_NODE','BROWSER_FALLBACK','REPLAY','TEST_FIXTURE'\)/);
assert.match(sql, /source_mode in \('PERSISTENT_COLLECTOR','MIXED'\) and model_authority = 'PERSISTENT_NODE'/i);
assert.match(sql, /source_mode in \('BROWSER_SESSION','UNAVAILABLE'\) and model_authority = 'BROWSER_FALLBACK'/i);
assert.match(sql, /bclif_guard_tile_change/);
assert.match(sql, /trg_bclif_field_chunks_immutable/);
assert.match(sql, /trg_bclif_event_chunks_immutable/);
assert.match(sql, /trg_bclif_checkpoints_immutable/);
assert.match(sql, /bclif_tile_supersessions/);
assert.doesNotMatch(sql, /replacement_tile_id uuid not null unique/i);
assert.match(sql, /idx_bclif_tile_supersessions_replacement[\s\S]*replacement_tile_id/i);
assert.match(
  sql,
  /create\s+unique\s+index\s+if\s+not\s+exists\s+idx_bclif_cluster_outcomes_prediction[\s\S]*?on\s+public\.bclif_cluster_outcomes\s*\(prediction_id\)/i,
  "each immutable cluster prediction must have at most one outcome"
);
assert.match(sql, /compression = 'gzip-v1'/);
assert.match(sql, /checksum ~ '\^sha256:\[a-f0-9\]\{64\}\$'/);
assert.match(sql, /uncompressed_bytes bigint not null check \(uncompressed_bytes between 1 and 536870912\)/i);
assert.doesNotMatch(sql, /uncompressed_bytes\s*>=\s*compressed_bytes/i);
assert.match(sql, /object_path ~ '\^v\[1-9\]\[0-9\]\*\/BYBIT\/linear_perpetual/);
assert.match(sql, /\\\.bclif\$'/);
assert.match(sql, /foreign key \(active_instance_id\) references public\.bclif_collector_instances\(instance_id\)/i);
assert.match(sql, /foreign key \(created_by_node_id\) references public\.bclif_collector_nodes\(node_id\)/i);
assert.match(sql, /fencing_epoch bigint not null default 0/i);
assert.match(sql, /lease_expires_at timestamptz/i);
assert.match(sql, /create or replace function public\.bclif_acquire_collector_lease/i);
assert.match(sql, /for update;[\s\S]*collector authority lease is already held/i);
assert.match(sql, /create or replace function public\.bclif_renew_collector_lease/i);
assert.match(sql, /current_instance_id = p_instance_id[\s\S]*fencing_epoch = p_fencing_epoch[\s\S]*lease_expires_at > clock_timestamp\(\)/i);
assert.match(sql, /grant execute on function public\.bclif_acquire_collector_lease\(text,text,integer\) to service_role/i);
assert.match(sql, /create or replace function public\.bclif_assert_source_writer_fence/i);
assert.match(sql, /create or replace function public\.bclif_assert_row_writer_fence/i);
assert.match(sql, /trg_bclif_sources_writer_fence/i);
assert.match(sql, /idx_bclif_field_chunks_single_staging_bucket[\s\S]*where publication_state = 'STAGING'/i);
assert.match(sql, /old\.publication_state = 'STAGING'[\s\S]*new\.publication_state = 'STAGING'[\s\S]*new\.columns > old\.columns/i);
assert.doesNotMatch(sql, /tiles\/v\[1-9\]/);
assert.doesNotMatch(sql, /\\\.bclif\\\.(?:gz|br)/);
assert.match(sql, /insert into storage\.buckets/i);
assert.match(sql, /'bclif-field-chunks'.*false.*52428800/s);
assert.match(sql, /array\['application\/octet-stream','application\/gzip'\]/);
assert.match(sql, /'DRAINING','STOPPED','FATAL'/);
for (const operation of ["select", "insert", "delete"]) {
  assert.match(sql, new RegExp(`create\\s+policy\\s+bclif_objects_service_${operation}[\\s\\S]*?to\\s+service_role`, "i"));
}
assert.doesNotMatch(sql, /create\s+policy\s+bclif[^;]+to\s+(?:anon|authenticated)/i);
assert.doesNotMatch(sql, /grant\s+all/i);
assert.doesNotMatch(sql, /pg_cron|cron\.schedule/i);

assert.match(security, /allowed_indicators/);
assert.match(security, /policy\.indicator/);
assert.match(security, /INDICATOR_ENTITLEMENT_REQUIRED/);
assert.doesNotMatch(security, /app_metadata\?\.allowedIndicators/);
assert.doesNotMatch(security, /data\?\.role\s*\|\|\s*user\.app_metadata/);
assert.match(security, /SECURITY_IDENTITY_UNAVAILABLE/);
assert.match(api, /indicator:\s*BCLIF_INDICATOR_KEY/);
assert.match(api, /normalizeBclifRouteError/);
assert.match(apiService, /lte\("chunk_end", replayCutoff\)/);
assert.match(apiService, /lte\("source_cutoff_at", replayCutoff\)/);
assert.match(apiService, /query = query\.gte\("chunk_end", new Date\(scope\.from\)\.toISOString\(\)\)/);
assert.doesNotMatch(apiService, /lte\("chunk_start", new Date\(scope\.to\)/);

console.log(`BCLIF migration contracts passed: ${newTables.length} new service-only tables, private storage policies, immutable metadata, and entitlement-protected API source.`);
