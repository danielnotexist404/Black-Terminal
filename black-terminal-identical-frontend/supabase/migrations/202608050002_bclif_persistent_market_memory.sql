-- Phase V, Chapter III-C: durable BCLIF market memory, collector identity,
-- canonical event chunks, cohort checkpoints and immutable thermal tile metadata.
--
-- This migration deliberately does not schedule work or claim a collector is
-- deployed. The long-running analytics node remains a separately deployed
-- service. Client access is mediated by authenticated, entitlement-protected
-- server routes; no BCLIF table or storage object is directly client-readable.
begin;

create extension if not exists pgcrypto;

create or replace function public.bclif_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.bclif_reject_immutable_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'BCLIF published records are immutable' using errcode = '55000';
end;
$$;

create table if not exists public.bclif_collector_nodes (
  node_id text primary key,
  environment text not null check (environment in ('PRODUCTION','STAGING','DEVELOPMENT')),
  region text not null,
  deployment_commit text not null,
  image_digest text not null,
  model_version text not null,
  current_instance_id text,
  fencing_epoch bigint not null default 0 check (fencing_epoch >= 0),
  lease_expires_at timestamptz,
  status text not null default 'STARTING' check (status in (
    'STARTING','SYNCING','BACKFILLING','LIVE','DEGRADED','DRAINING','OFFLINE'
  )),
  lifecycle_state text not null default 'PROCESS_STARTING' check (lifecycle_state in (
    'PROCESS_STARTING','CONFIG_VALIDATING','DATABASE_CONNECTING','SCHEMA_VALIDATING',
    'STORAGE_CONNECTING','CHECKPOINT_LOADING','STATE_REPLAYING','SOURCE_BACKFILLING',
    'SOURCE_CONNECTING','SOURCE_SYNCHRONIZING','LIVE','TRADES_STALE',
    'LIQUIDATIONS_STALE','ORDERBOOK_STALE','OI_STALE','STORAGE_DEGRADED',
    'CHECKPOINT_DEGRADED','PARTIAL_COVERAGE','CONFIGURATION_ERROR','SCHEMA_MISMATCH',
    'STORAGE_UNAVAILABLE','CHECKPOINT_CORRUPT','MODEL_VERSION_UNSUPPORTED',
    'DRAINING','STOPPED','FATAL'
  )),
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null default now(),
  source_freshness jsonb not null default '{}'::jsonb,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bclif_collector_nodes_identity_check check (
    node_id ~ '^(LIQUIDATION_INTELLIGENCE_NODE|IMM_NODE)_[0-9]{2}$'
  ),
  constraint bclif_collector_nodes_commit_check check (deployment_commit ~ '^[a-fA-F0-9]{7,40}$'),
  constraint bclif_collector_nodes_digest_check check (image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  constraint bclif_collector_nodes_json_check check (
    jsonb_typeof(source_freshness) = 'object' and jsonb_typeof(safe_metadata) = 'object'
  )
);

create index if not exists idx_bclif_collector_nodes_health
  on public.bclif_collector_nodes(status, last_heartbeat_at desc);

drop trigger if exists trg_bclif_collector_nodes_updated_at on public.bclif_collector_nodes;
create trigger trg_bclif_collector_nodes_updated_at
before update on public.bclif_collector_nodes
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_collector_instances (
  instance_id text primary key,
  node_id text not null references public.bclif_collector_nodes(node_id) on delete restrict,
  deployment_commit text not null,
  image_digest text not null,
  model_version text not null,
  started_at timestamptz not null,
  stopped_at timestamptz,
  stop_reason text,
  status text not null default 'STARTING' check (status in (
    'STARTING','SYNCING','BACKFILLING','LIVE','DEGRADED','DRAINING','OFFLINE'
  )),
  last_heartbeat_at timestamptz not null default now(),
  fencing_epoch bigint not null default 0 check (fencing_epoch >= 0),
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bclif_collector_instances_id_check check (instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  constraint bclif_collector_instances_commit_check check (deployment_commit ~ '^[a-fA-F0-9]{7,40}$'),
  constraint bclif_collector_instances_digest_check check (image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  constraint bclif_collector_instances_time_check check (stopped_at is null or stopped_at >= started_at),
  constraint bclif_collector_instances_json_check check (jsonb_typeof(safe_metadata) = 'object')
);

alter table public.bclif_collector_nodes
  add column if not exists fencing_epoch bigint not null default 0,
  add column if not exists lease_expires_at timestamptz;
alter table public.bclif_collector_instances
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_collector_nodes drop constraint if exists bclif_collector_nodes_fencing_epoch_check;
alter table public.bclif_collector_nodes add constraint bclif_collector_nodes_fencing_epoch_check check (fencing_epoch >= 0);
alter table public.bclif_collector_instances drop constraint if exists bclif_collector_instances_fencing_epoch_check;
alter table public.bclif_collector_instances add constraint bclif_collector_instances_fencing_epoch_check check (fencing_epoch >= 0);

create index if not exists idx_bclif_collector_instances_node_time
  on public.bclif_collector_instances(node_id, started_at desc);

drop trigger if exists trg_bclif_collector_instances_updated_at on public.bclif_collector_instances;
create trigger trg_bclif_collector_instances_updated_at
before update on public.bclif_collector_instances
for each row execute function public.bclif_set_updated_at();

alter table public.bclif_sources
  add column if not exists active_instance_id text,
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0,
  add column if not exists model_version text,
  add column if not exists source_freshness jsonb not null default '{}'::jsonb,
  add column if not exists source_cutoff_at timestamptz,
  add column if not exists continuity_state text not null default 'MISSING';

alter table public.bclif_sources drop constraint if exists bclif_sources_active_instance_fkey;
alter table public.bclif_sources add constraint bclif_sources_active_instance_fkey
  foreign key (active_instance_id) references public.bclif_collector_instances(instance_id) on delete set null;
alter table public.bclif_sources drop constraint if exists bclif_sources_writer_instance_fkey;
alter table public.bclif_sources add constraint bclif_sources_writer_instance_fkey
  foreign key (writer_instance_id) references public.bclif_collector_instances(instance_id) on delete restrict
  not valid;
alter table public.bclif_sources drop constraint if exists bclif_sources_fencing_epoch_check;
alter table public.bclif_sources add constraint bclif_sources_fencing_epoch_check check (fencing_epoch >= 0);

alter table public.bclif_sources drop constraint if exists bclif_sources_state_check;
alter table public.bclif_sources add constraint bclif_sources_state_check check (state in (
  'STARTING','COLLECTING','SYNCING','BACKFILLING','LIVE','STALE','DEGRADED','DRAINING','OFFLINE','FAILED','DISABLED'
));
alter table public.bclif_sources drop constraint if exists bclif_sources_continuity_state_check;
alter table public.bclif_sources add constraint bclif_sources_continuity_state_check check (continuity_state in (
  'OBSERVED','DERIVED','ESTIMATED_HIGH','ESTIMATED_MEDIUM','ESTIMATED_LOW','MISSING','SYNTHETIC_TEST'
));
alter table public.bclif_sources drop constraint if exists bclif_sources_json_check;
alter table public.bclif_sources add constraint bclif_sources_json_check check (
  jsonb_typeof(metadata) = 'object' and jsonb_typeof(source_freshness) = 'object'
);

drop trigger if exists trg_bclif_sources_updated_at on public.bclif_sources;
create trigger trg_bclif_sources_updated_at
before update on public.bclif_sources
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_source_offsets (
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  source_name text not null,
  source_partition text not null default 'default',
  source_version text not null,
  last_exchange_timestamp timestamptz,
  last_received_timestamp timestamptz,
  last_event_id text,
  last_sequence text,
  continuity_state text not null default 'MISSING' check (continuity_state in (
    'OBSERVED','DERIVED','ESTIMATED_HIGH','ESTIMATED_MEDIUM','ESTIMATED_LOW','MISSING','SYNTHETIC_TEST'
  )),
  gap_count bigint not null default 0 check (gap_count >= 0),
  reconnect_count bigint not null default 0 check (reconnect_count >= 0),
  safe_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (source_id, source_name, source_partition),
  constraint bclif_source_offsets_json_check check (jsonb_typeof(safe_metadata) = 'object')
);

create index if not exists idx_bclif_source_offsets_freshness
  on public.bclif_source_offsets(source_id, last_exchange_timestamp desc);

drop trigger if exists trg_bclif_source_offsets_updated_at on public.bclif_source_offsets;
create trigger trg_bclif_source_offsets_updated_at
before update on public.bclif_source_offsets
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_event_deduplication (
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  event_kind text not null check (event_kind in (
    'TRADE','LIQUIDATION','OPEN_INTEREST','BOOK_FRAME','FUNDING','MARK_INDEX',
    'POSITION_RATIO','RISK_TIER','INSTRUMENT_INFO'
  )),
  dedup_key text not null,
  exchange_timestamp timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  duplicate_count bigint not null default 0 check (duplicate_count >= 0),
  expires_at timestamptz not null,
  primary key (source_id, event_kind, dedup_key),
  constraint bclif_event_dedup_key_check check (dedup_key ~ '^sha256:[a-f0-9]{64}$'),
  constraint bclif_event_dedup_expiry_check check (expires_at > exchange_timestamp)
);

create index if not exists idx_bclif_event_deduplication_expiry
  on public.bclif_event_deduplication(expires_at);

create table if not exists public.bclif_canonical_event_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  event_kind text not null check (event_kind in (
    'TRADE','LIQUIDATION','OPEN_INTEREST','BOOK_FRAME','FUNDING','MARK_INDEX',
    'POSITION_RATIO','RISK_TIER','INSTRUMENT_INFO'
  )),
  schema_version integer not null check (schema_version between 1 and 32767),
  source_version text not null,
  chunk_start timestamptz not null,
  chunk_end timestamptz not null,
  source_cutoff_at timestamptz not null,
  event_count bigint not null check (event_count > 0),
  first_event_key text not null,
  last_event_key text not null,
  compression text not null check (compression = 'gzip-v1'),
  bucket_id text not null default 'bclif-field-chunks' check (bucket_id = 'bclif-field-chunks'),
  object_path text not null unique,
  checksum text not null,
  compressed_bytes bigint not null check (compressed_bytes between 1 and 52428800),
  -- Gzip framing can make very small chunks larger than their raw payload,
  -- so compressed and uncompressed bounds are validated independently.
  uncompressed_bytes bigint not null check (uncompressed_bytes between 1 and 536870912),
  created_by_node_id text not null references public.bclif_collector_nodes(node_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint bclif_canonical_event_chunks_time_check check (
    chunk_end > chunk_start and source_cutoff_at >= chunk_end
  ),
  constraint bclif_canonical_event_chunks_checksum_check check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  constraint bclif_canonical_event_chunks_path_check check (
    object_path ~ '^events/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(TRADE|LIQUIDATION|OPEN_INTEREST|BOOK_FRAME|FUNDING|MARK_INDEX|POSITION_RATIO|RISK_TIER|INSTRUMENT_INFO)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.events\\.gz$'
  ),
  unique (source_id, event_kind, schema_version, chunk_start, chunk_end, checksum)
);

create index if not exists idx_bclif_event_chunks_lookup
  on public.bclif_canonical_event_chunks(source_id, event_kind, chunk_start desc);

create table if not exists public.bclif_cohort_checkpoints (
  checkpoint_id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  venue text not null check (venue = 'BYBIT'),
  symbol text not null check (symbol ~ '^[A-Z0-9_-]{2,40}$'),
  model_version text not null,
  source_version text not null,
  schema_version integer not null check (schema_version between 1 and 32767),
  checkpoint_at timestamptz not null,
  source_cutoff_at timestamptz not null,
  cohort_count integer not null check (cohort_count >= 0),
  particle_count integer not null check (particle_count >= 0),
  bucket_id text not null default 'bclif-field-chunks' check (bucket_id = 'bclif-field-chunks'),
  object_path text not null unique,
  checksum text not null,
  compressed_bytes bigint not null check (compressed_bytes between 1 and 52428800),
  created_by_node_id text not null references public.bclif_collector_nodes(node_id) on delete restrict,
  reason text not null check (reason in ('INTERVAL','GRACEFUL_SHUTDOWN','BACKFILL_COMPLETE','MODEL_MIGRATION')),
  created_at timestamptz not null default now(),
  constraint bclif_cohort_checkpoints_time_check check (source_cutoff_at <= checkpoint_at),
  constraint bclif_cohort_checkpoints_checksum_check check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  constraint bclif_cohort_checkpoints_path_check check (
    object_path ~ '^checkpoints/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.checkpoint\\.gz$'
  )
);

create index if not exists idx_bclif_checkpoints_recovery
  on public.bclif_cohort_checkpoints(source_id, model_version, source_cutoff_at desc);

-- Coverage is measured independently for every horizon. Unknown measurements
-- are NULL, never a fabricated zero.
alter table public.bclif_coverage
  add column if not exists horizon text not null default '1D',
  add column if not exists model_start timestamptz,
  add column if not exists model_end timestamptz,
  add column if not exists funding_coverage_percent numeric,
  add column if not exists source_mode text not null default 'UNAVAILABLE',
  add column if not exists model_authority text not null default 'BROWSER_FALLBACK',
  add column if not exists source_cutoff_at timestamptz,
  add column if not exists source_intervals jsonb not null default '{"TRADE":[],"LIQUIDATION":[],"OPEN_INTEREST":[],"BOOK_FRAME":[],"FUNDING":[]}'::jsonb,
  add column if not exists coverage_version integer;

update public.bclif_coverage set coverage_version = 1 where coverage_version is null;
update public.bclif_coverage
set model_authority = 'BROWSER_FALLBACK'
where source_mode in ('BROWSER_SESSION','UNAVAILABLE');

alter table public.bclif_coverage alter column coverage_version set not null;
alter table public.bclif_coverage alter column coverage_version set default 2;
alter table public.bclif_coverage alter column model_authority set default 'BROWSER_FALLBACK';

alter table public.bclif_coverage alter column trade_coverage_percent drop not null;
alter table public.bclif_coverage alter column trade_coverage_percent drop default;
alter table public.bclif_coverage alter column open_interest_coverage_percent drop not null;
alter table public.bclif_coverage alter column open_interest_coverage_percent drop default;
alter table public.bclif_coverage alter column liquidation_coverage_percent drop not null;
alter table public.bclif_coverage alter column liquidation_coverage_percent drop default;
alter table public.bclif_coverage alter column orderbook_coverage_percent drop not null;
alter table public.bclif_coverage alter column orderbook_coverage_percent drop default;
alter table public.bclif_coverage alter column model_continuity_percent drop not null;
alter table public.bclif_coverage alter column model_continuity_percent drop default;

update public.bclif_coverage
set trade_coverage_percent = null,
    open_interest_coverage_percent = null,
    liquidation_coverage_percent = null,
    orderbook_coverage_percent = null,
    model_continuity_percent = null,
    funding_coverage_percent = null
where source_mode = 'UNAVAILABLE' and model_start is null and model_end is null;

alter table public.bclif_coverage drop constraint if exists bclif_coverage_pkey;
alter table public.bclif_coverage add primary key (source_id, horizon);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_horizon_check;
alter table public.bclif_coverage add constraint bclif_coverage_horizon_check check (
  horizon in ('6H','12H','1D','3D','1W','3W','1M','CUSTOM')
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_funding_percent_check;
alter table public.bclif_coverage add constraint bclif_coverage_funding_percent_check check (
  funding_coverage_percent is null or funding_coverage_percent between 0 and 100
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_source_mode_check;
alter table public.bclif_coverage add constraint bclif_coverage_source_mode_check check (
  source_mode in ('PERSISTENT_COLLECTOR','BROWSER_SESSION','MIXED','UNAVAILABLE')
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_authority_check;
alter table public.bclif_coverage add constraint bclif_coverage_authority_check check (
  model_authority in ('PERSISTENT_NODE','BROWSER_FALLBACK','REPLAY','TEST_FIXTURE')
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_version_check;
alter table public.bclif_coverage add constraint bclif_coverage_version_check check (
  coverage_version in (1,2)
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_mode_authority_check;
alter table public.bclif_coverage add constraint bclif_coverage_mode_authority_check check (
  (source_mode in ('PERSISTENT_COLLECTOR','MIXED') and model_authority = 'PERSISTENT_NODE') or
  (source_mode in ('BROWSER_SESSION','UNAVAILABLE') and model_authority = 'BROWSER_FALLBACK')
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_time_check;
alter table public.bclif_coverage add constraint bclif_coverage_time_check check (
  ((requested_start is null and requested_end is null) or (requested_start is not null and requested_end is not null and requested_end > requested_start)) and
  ((available_start is null and available_end is null) or (available_start is not null and available_end is not null and available_end > available_start)) and
  ((model_start is null and model_end is null) or (model_start is not null and model_end is not null and model_end > model_start)) and
  (coverage_version = 1 or (requested_start is not null and requested_end is not null)) and
  (coverage_version = 1 or source_mode not in ('PERSISTENT_COLLECTOR','MIXED') or source_cutoff_at is not null) and
  (requested_start is null or available_start is null or available_start >= requested_start) and
  (requested_end is null or available_end is null or available_end <= requested_end) and
  (requested_start is null or model_start is null or model_start >= requested_start) and
  (requested_end is null or model_end is null or model_end <= requested_end) and
  (source_cutoff_at is null or requested_start is null or source_cutoff_at >= requested_start) and
  (source_cutoff_at is null or requested_end is null or source_cutoff_at <= requested_end) and
  (source_cutoff_at is null or model_end is null or source_cutoff_at >= model_end)
);
alter table public.bclif_coverage drop constraint if exists bclif_coverage_json_check;
alter table public.bclif_coverage add constraint bclif_coverage_json_check check (
  jsonb_typeof(missing_intervals) = 'array' and
  jsonb_typeof(source_intervals) = 'object' and
  jsonb_typeof(source_intervals->'TRADE') = 'array' and
  jsonb_typeof(source_intervals->'LIQUIDATION') = 'array' and
  jsonb_typeof(source_intervals->'OPEN_INTEREST') = 'array' and
  jsonb_typeof(source_intervals->'BOOK_FRAME') = 'array' and
  jsonb_typeof(source_intervals->'FUNDING') = 'array' and
  octet_length(source_intervals::text) <= 4194304 and
  octet_length(missing_intervals::text) <= 1048576
);

-- Upgrade confirmed events with an immutable observed-event identity.
alter table public.bclif_confirmed_liquidation_events
  add column if not exists certainty text not null default 'OBSERVED',
  add column if not exists source_version text not null default 'BCLIF_SOURCE_UNKNOWN',
  add column if not exists event_checksum text;

update public.bclif_confirmed_liquidation_events
set event_checksum = 'sha256:' || encode(extensions.digest(
  source_id::text || '|' || venue_event_id || '|' || event_time::text || '|' ||
  liquidated_position_side || '|' || bankruptcy_price::text || '|' || quantity::text,
  'sha256'
), 'hex')
where event_checksum is null;

alter table public.bclif_confirmed_liquidation_events alter column event_checksum set not null;
alter table public.bclif_confirmed_liquidation_events drop constraint if exists bclif_confirmed_events_certainty_check;
alter table public.bclif_confirmed_liquidation_events add constraint bclif_confirmed_events_certainty_check check (certainty = 'OBSERVED');
alter table public.bclif_confirmed_liquidation_events drop constraint if exists bclif_confirmed_events_checksum_check;
alter table public.bclif_confirmed_liquidation_events add constraint bclif_confirmed_events_checksum_check check (event_checksum ~ '^sha256:[a-f0-9]{64}$');
alter table public.bclif_confirmed_liquidation_events drop constraint if exists bclif_confirmed_events_json_check;
alter table public.bclif_confirmed_liquidation_events add constraint bclif_confirmed_events_json_check check (jsonb_typeof(source_payload) = 'object');
create unique index if not exists idx_bclif_confirmed_events_checksum
  on public.bclif_confirmed_liquidation_events(source_id, event_checksum);

-- Evolve the existing field-chunk table into versioned immutable tile metadata.
alter table public.bclif_field_chunks
  add column if not exists schema_version integer not null default 1,
  add column if not exists tile_version integer not null default 1,
  add column if not exists time_step_ms bigint not null default 60000,
  add column if not exists price_step numeric not null default 0.01,
  add column if not exists bucket_id text not null default 'bclif-field-chunks',
  add column if not exists source_cutoff_at timestamptz not null default now(),
  add column if not exists coverage_quality text not null default 'INSUFFICIENT',
  add column if not exists model_authority text not null default 'PERSISTENT_NODE',
  add column if not exists channel_manifest jsonb not null default '{}'::jsonb,
  add column if not exists scale_metadata jsonb not null default '{}'::jsonb,
  add column if not exists publication_state text not null default 'FINALIZED',
  add column if not exists created_by_node_id text,
  add column if not exists published_at timestamptz not null default now();

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.bclif_field_chunks'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%source_id, model_version, horizon, chunk_start, columns, rows%'
  loop
    execute format('alter table public.bclif_field_chunks drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_horizon_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_horizon_check check (
  horizon in ('6H','12H','1D','3D','1W','3W','1M','CUSTOM')
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_versions_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_versions_check check (
  schema_version between 1 and 32767 and tile_version > 0
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_steps_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_steps_check check (
  time_step_ms > 0 and price_step > 0
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_bounds_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_bounds_check check (
  chunk_end > chunk_start and price_max > price_min and source_cutoff_at >= chunk_end
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_bucket_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_bucket_check check (bucket_id = 'bclif-field-chunks');
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_codec_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_codec_check check (compression = 'gzip-v1');
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_checksum_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_checksum_check check (checksum ~ '^sha256:[a-f0-9]{64}$');
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_path_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_path_check check (
  object_path ~ '^v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.bclif$'
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_quality_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_quality_check check (
  coverage_quality in ('EXCELLENT','HIGH','MIXED','LOW','INSUFFICIENT')
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_authority_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_authority_check check (
  model_authority in ('PERSISTENT_NODE','REPLAY')
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_publication_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_publication_check check (
  publication_state in ('STAGING','FINALIZED')
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_json_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_json_check check (
  jsonb_typeof(metadata) = 'object' and jsonb_typeof(channel_manifest) = 'object' and jsonb_typeof(scale_metadata) = 'object'
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_size_check;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_size_check check (
  (publication_state = 'STAGING' and (compressed_bytes is null or compressed_bytes between 1 and 52428800)) or
  (publication_state = 'FINALIZED' and compressed_bytes between 1 and 52428800)
);
alter table public.bclif_field_chunks drop constraint if exists bclif_field_chunks_created_by_node_fkey;
alter table public.bclif_field_chunks add constraint bclif_field_chunks_created_by_node_fkey
  foreign key (created_by_node_id) references public.bclif_collector_nodes(node_id) on delete restrict;

create unique index if not exists idx_bclif_field_chunks_object_path
  on public.bclif_field_chunks(object_path);
create unique index if not exists idx_bclif_field_chunks_version
  on public.bclif_field_chunks(source_id, horizon, chunk_start, chunk_end, model_version, schema_version, tile_version);
create index if not exists idx_bclif_field_chunks_manifest
  on public.bclif_field_chunks(source_id, horizon, publication_state, chunk_start desc);
create unique index if not exists idx_bclif_field_chunks_single_staging_bucket
  on public.bclif_field_chunks(source_id, horizon, chunk_start, model_version, schema_version, tile_version)
  where publication_state = 'STAGING';

create table if not exists public.bclif_tile_supersessions (
  superseded_tile_id uuid primary key references public.bclif_field_chunks(id) on delete restrict,
  replacement_tile_id uuid not null references public.bclif_field_chunks(id) on delete restrict,
  reason text not null,
  superseded_by_node_id text not null references public.bclif_collector_nodes(node_id) on delete restrict,
  superseded_at timestamptz not null default now(),
  constraint bclif_tile_supersessions_distinct_check check (superseded_tile_id <> replacement_tile_id)
);

create index if not exists idx_bclif_tile_supersessions_replacement
  on public.bclif_tile_supersessions(replacement_tile_id);

create table if not exists public.bclif_compaction_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  horizon text not null check (horizon in ('6H','12H','1D','3D','1W','3W','1M','CUSTOM')),
  state text not null check (state in ('QUEUED','RUNNING','VERIFIED','SUPERSEDED','FAILED')),
  input_tile_ids uuid[] not null,
  output_tile_id uuid references public.bclif_field_chunks(id) on delete restrict,
  source_exposure_sum numeric,
  output_exposure_sum numeric,
  checksum_verified boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_by_node_id text not null references public.bclif_collector_nodes(node_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bclif_compaction_runs_input_check check (cardinality(input_tile_ids) > 0),
  constraint bclif_compaction_runs_time_check check (completed_at is null or started_at is null or completed_at >= started_at),
  constraint bclif_compaction_runs_json_check check (jsonb_typeof(safe_metadata) = 'object')
);

drop trigger if exists trg_bclif_compaction_runs_updated_at on public.bclif_compaction_runs;
create trigger trg_bclif_compaction_runs_updated_at
before update on public.bclif_compaction_runs
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_retention_policies (
  tier text primary key check (tier in ('HOT','WARM','HISTORICAL','DEDUPLICATION')),
  retention_seconds bigint not null check (retention_seconds between 60 and 31557600),
  minimum_horizon text,
  enabled boolean not null default true,
  safe_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint bclif_retention_policies_json_check check (jsonb_typeof(safe_metadata) = 'object')
);

insert into public.bclif_retention_policies(tier, retention_seconds, minimum_horizon, safe_metadata)
values
  ('HOT', 3600, '6H', '{"description":"bounded high-resolution source and tile state"}'::jsonb),
  ('WARM', 604800, '1D', '{"description":"compressed recent market memory"}'::jsonb),
  ('HISTORICAL', 7257600, '1W', '{"description":"downsampled historical thermal tiles"}'::jsonb),
  ('DEDUPLICATION', 604800, null, '{"description":"reconnect and replay overlap protection"}'::jsonb)
on conflict (tier) do nothing;

drop trigger if exists trg_bclif_retention_policies_updated_at on public.bclif_retention_policies;
create trigger trg_bclif_retention_policies_updated_at
before update on public.bclif_retention_policies
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_object_deletion_queue (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null default 'bclif-field-chunks' check (bucket_id = 'bclif-field-chunks'),
  object_path text not null unique,
  object_kind text not null check (object_kind in ('TILE','EVENT_CHUNK','CHECKPOINT')),
  reason text not null,
  state text not null default 'PENDING' check (state in ('PENDING','CLAIMED','OBJECT_DELETED','FAILED')),
  not_before timestamptz not null,
  claimed_by_node_id text references public.bclif_collector_nodes(node_id) on delete restrict,
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bclif_object_deletion_queue_time_check check (
    completed_at is null or claimed_at is null or completed_at >= claimed_at
  )
);

create index if not exists idx_bclif_object_deletion_queue_pending
  on public.bclif_object_deletion_queue(state, not_before)
  where state in ('PENDING','FAILED');

drop trigger if exists trg_bclif_object_deletion_queue_updated_at on public.bclif_object_deletion_queue;
create trigger trg_bclif_object_deletion_queue_updated_at
before update on public.bclif_object_deletion_queue
for each row execute function public.bclif_set_updated_at();

create table if not exists public.bclif_cluster_predictions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  model_version text not null,
  source_cutoff_at timestamptz not null,
  created_at timestamptz not null default now(),
  price_min numeric not null,
  price_max numeric not null,
  notional_min numeric not null check (notional_min >= 0),
  notional_max numeric not null check (notional_max >= 0),
  confidence numeric not null check (confidence between 0 and 1),
  leverage_prior text not null,
  margin_mode_uncertainty numeric not null check (margin_mode_uncertainty between 0 and 1),
  predicted_side text not null check (predicted_side in ('LONG_LIQUIDATION','SHORT_LIQUIDATION')),
  cascade_state text not null check (cascade_state in ('SCAFFOLDED','EXPERIMENTAL','CALIBRATING','CERTIFIED')),
  immutable_context jsonb not null default '{}'::jsonb,
  constraint bclif_cluster_predictions_price_check check (price_max > price_min),
  constraint bclif_cluster_predictions_notional_check check (notional_max >= notional_min),
  constraint bclif_cluster_predictions_cutoff_check check (source_cutoff_at <= created_at),
  constraint bclif_cluster_predictions_json_check check (jsonb_typeof(immutable_context) = 'object')
);

create index if not exists idx_bclif_cluster_predictions_time
  on public.bclif_cluster_predictions(source_id, created_at desc);

create table if not exists public.bclif_cluster_outcomes (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.bclif_cluster_predictions(id) on delete restrict,
  evaluated_at timestamptz not null,
  confirmed_event_overlap numeric check (confirmed_event_overlap is null or confirmed_event_overlap between 0 and 1),
  price_error numeric,
  timing_error_ms bigint,
  outcome text not null check (outcome in ('HIT','FALSE_POSITIVE','MISSED','ABSORBED','CONTINUED','INCONCLUSIVE')),
  observed_sample_count integer not null default 0 check (observed_sample_count >= 0),
  immutable_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint bclif_cluster_outcomes_json_check check (jsonb_typeof(immutable_evidence) = 'object')
);

create unique index if not exists idx_bclif_cluster_outcomes_prediction
  on public.bclif_cluster_outcomes(prediction_id);

alter table public.bclif_model_evaluations
  add column if not exists sample_count integer not null default 0,
  add column if not exists missed_event_rate numeric,
  add column if not exists mean_price_error numeric,
  add column if not exists median_price_error numeric,
  add column if not exists mean_timing_error_ms numeric,
  add column if not exists confidence_calibration_error numeric,
  add column if not exists cascade_precision numeric,
  add column if not exists cascade_recall numeric,
  add column if not exists absorption_accuracy numeric,
  add column if not exists cascade_state text not null default 'SCAFFOLDED';

alter table public.bclif_model_evaluations drop constraint if exists bclif_model_evaluations_sample_check;
alter table public.bclif_model_evaluations add constraint bclif_model_evaluations_sample_check check (sample_count >= 0);
alter table public.bclif_model_evaluations drop constraint if exists bclif_model_evaluations_cascade_state_check;
alter table public.bclif_model_evaluations add constraint bclif_model_evaluations_cascade_state_check check (
  cascade_state in ('SCAFFOLDED','EXPERIMENTAL','CALIBRATING','CERTIFIED')
);

create table if not exists public.bclif_certification_records (
  id uuid primary key default gen_random_uuid(),
  node_id text references public.bclif_collector_nodes(node_id) on delete restrict,
  instance_id text,
  deployment_commit text not null,
  image_digest text not null,
  model_version text not null,
  certification_state text not null check (certification_state in (
    'REPOSITORY_COMPLETE','COLLECTOR_DEPLOYED','HISTORY_ACCUMULATING',
    'MULTI_HORIZON_ACTIVE','RESTART_CERTIFIED','VISUAL_CERTIFIED','PRODUCTION_CERTIFIED','FAILED'
  )),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint bclif_certification_commit_check check (deployment_commit ~ '^[a-fA-F0-9]{7,40}$'),
  constraint bclif_certification_digest_check check (image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  constraint bclif_certification_json_check check (jsonb_typeof(evidence) = 'object')
);

-- Every collector mutation carries an explicit fencing token. The legacy
-- sentinel lets this successor migration remain installable over an older,
-- empty-or-historical foundation while all new writes are rejected unless a
-- live registered instance supplies its real token.
alter table public.bclif_source_offsets
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_event_deduplication
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_canonical_event_chunks
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_cohort_checkpoints
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_coverage
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_confirmed_liquidation_events
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_field_chunks
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_compaction_runs
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_object_deletion_queue
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_cluster_predictions
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_cluster_outcomes
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_model_evaluations
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_tile_supersessions
  add column if not exists writer_instance_id text not null default 'UNFENCED_LEGACY',
  add column if not exists fencing_epoch bigint not null default 0;
alter table public.bclif_object_deletion_queue
  add column if not exists source_id uuid references public.bclif_sources(id) on delete cascade;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'bclif_source_offsets','bclif_event_deduplication','bclif_canonical_event_chunks',
    'bclif_cohort_checkpoints','bclif_coverage','bclif_confirmed_liquidation_events',
    'bclif_field_chunks','bclif_compaction_runs','bclif_object_deletion_queue',
    'bclif_cluster_predictions','bclif_cluster_outcomes','bclif_model_evaluations',
    'bclif_tile_supersessions'
  ]
  loop
    execute format('alter table public.%I drop constraint if exists %I', table_name, table_name || '_writer_instance_fkey');
    execute format(
      'alter table public.%I add constraint %I foreign key (writer_instance_id) references public.bclif_collector_instances(instance_id) on delete restrict not valid',
      table_name,
      table_name || '_writer_instance_fkey'
    );
    execute format('alter table public.%I drop constraint if exists %I', table_name, table_name || '_fencing_epoch_check');
    execute format(
      'alter table public.%I add constraint %I check (fencing_epoch > 0) not valid',
      table_name,
      table_name || '_fencing_epoch_check'
    );
  end loop;
end;
$$;

-- A collector instance must first insert its immutable instance row, then
-- acquire this node-scoped lease. The row lock serializes competing starts.
-- A retry from the same live instance is idempotent; a different unexpired
-- instance is rejected. Once a lease expires, the next holder receives a
-- strictly larger epoch, permanently fencing the stale process.
create or replace function public.bclif_acquire_collector_lease(
  p_node_id text,
  p_instance_id text,
  p_lease_ttl_ms integer
)
returns table(fencing_epoch bigint, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  locked_node public.bclif_collector_nodes%rowtype;
  instance_node_id text;
  next_epoch bigint;
  next_expiry timestamptz;
begin
  if p_lease_ttl_ms < 5000 or p_lease_ttl_ms > 300000 then
    raise exception 'BCLIF lease TTL is outside the safe bound' using errcode = '22023';
  end if;
  select * into locked_node
  from public.bclif_collector_nodes
  where node_id = p_node_id
  for update;
  if not found then
    raise exception 'BCLIF collector node is not registered' using errcode = 'P0002';
  end if;
  select node_id into instance_node_id
  from public.bclif_collector_instances
  where instance_id = p_instance_id;
  if instance_node_id is distinct from p_node_id then
    raise exception 'BCLIF collector instance does not belong to this node' using errcode = '28000';
  end if;
  if locked_node.current_instance_id = p_instance_id
     and locked_node.lease_expires_at > clock_timestamp() then
    next_epoch := locked_node.fencing_epoch;
  elsif locked_node.current_instance_id is not null
        and locked_node.current_instance_id <> p_instance_id
        and locked_node.lease_expires_at > clock_timestamp() then
    raise exception 'BCLIF collector authority lease is already held' using errcode = '55P03';
  else
    next_epoch := locked_node.fencing_epoch + 1;
  end if;
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_ttl_ms::double precision / 1000.0);
  update public.bclif_collector_nodes
  set current_instance_id = p_instance_id,
      fencing_epoch = next_epoch,
      lease_expires_at = next_expiry,
      last_heartbeat_at = clock_timestamp()
  where node_id = p_node_id;
  update public.bclif_collector_instances
  set fencing_epoch = next_epoch,
      last_heartbeat_at = clock_timestamp()
  where instance_id = p_instance_id and node_id = p_node_id;
  return query select next_epoch, next_expiry;
end;
$$;

create or replace function public.bclif_renew_collector_lease(
  p_node_id text,
  p_instance_id text,
  p_fencing_epoch bigint,
  p_lease_ttl_ms integer
)
returns table(lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_expiry timestamptz;
begin
  if p_lease_ttl_ms < 5000 or p_lease_ttl_ms > 300000 then
    raise exception 'BCLIF lease TTL is outside the safe bound' using errcode = '22023';
  end if;
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_ttl_ms::double precision / 1000.0);
  update public.bclif_collector_nodes
  set lease_expires_at = next_expiry,
      last_heartbeat_at = clock_timestamp()
  where node_id = p_node_id
    and current_instance_id = p_instance_id
    and fencing_epoch = p_fencing_epoch
    and lease_expires_at > clock_timestamp();
  if not found then
    raise exception 'BCLIF collector lease is stale or expired' using errcode = '55000';
  end if;
  update public.bclif_collector_instances
  set last_heartbeat_at = clock_timestamp()
  where instance_id = p_instance_id
    and node_id = p_node_id
    and fencing_epoch = p_fencing_epoch;
  return query select next_expiry;
end;
$$;

revoke all on function public.bclif_acquire_collector_lease(text,text,integer) from public, anon, authenticated;
revoke all on function public.bclif_renew_collector_lease(text,text,bigint,integer) from public, anon, authenticated;
grant execute on function public.bclif_acquire_collector_lease(text,text,integer) to service_role;
grant execute on function public.bclif_renew_collector_lease(text,text,bigint,integer) to service_role;

create or replace function public.bclif_assert_source_writer_fence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  active_instance text;
  active_epoch bigint;
  active_expiry timestamptz;
begin
  if new.collector_node is null
     or new.active_instance_id is distinct from new.writer_instance_id
     or new.writer_instance_id = 'UNFENCED_LEGACY'
     or new.fencing_epoch <= 0 then
    raise exception 'BCLIF source write is missing an active writer fence' using errcode = '55000';
  end if;
  select current_instance_id, fencing_epoch, lease_expires_at
  into active_instance, active_epoch, active_expiry
  from public.bclif_collector_nodes
  where node_id = new.collector_node;
  if active_instance is distinct from new.writer_instance_id
     or active_epoch is distinct from new.fencing_epoch
     or active_expiry is null
     or active_expiry <= clock_timestamp() then
    raise exception 'BCLIF source writer fence is stale' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.bclif_assert_row_writer_fence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_node text;
  source_instance text;
  source_epoch bigint;
  active_instance text;
  active_epoch bigint;
  active_expiry timestamptz;
begin
  select collector_node, writer_instance_id, fencing_epoch
  into source_node, source_instance, source_epoch
  from public.bclif_sources
  where id = new.source_id;
  if source_node is null
     or new.writer_instance_id is distinct from source_instance
     or new.fencing_epoch is distinct from source_epoch
     or new.writer_instance_id = 'UNFENCED_LEGACY'
     or new.fencing_epoch <= 0 then
    raise exception 'BCLIF row write is missing the source writer fence' using errcode = '55000';
  end if;
  select current_instance_id, fencing_epoch, lease_expires_at
  into active_instance, active_epoch, active_expiry
  from public.bclif_collector_nodes
  where node_id = source_node;
  if active_instance is distinct from new.writer_instance_id
     or active_epoch is distinct from new.fencing_epoch
     or active_expiry is null
     or active_expiry <= clock_timestamp() then
    raise exception 'BCLIF row writer fence is stale' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.bclif_assert_outcome_writer_fence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  prediction_source uuid;
begin
  select source_id into prediction_source
  from public.bclif_cluster_predictions
  where id = new.prediction_id;
  if prediction_source is null then
    raise exception 'BCLIF outcome prediction is unavailable' using errcode = '55000';
  end if;
  -- Reuse the direct-row assertion through the same source lookup without
  -- trusting a caller-supplied denormalized source ID.
  if not exists (
    select 1
    from public.bclif_sources source
    join public.bclif_collector_nodes node on node.node_id = source.collector_node
    where source.id = prediction_source
      and source.writer_instance_id = new.writer_instance_id
      and source.fencing_epoch = new.fencing_epoch
      and node.current_instance_id = new.writer_instance_id
      and node.fencing_epoch = new.fencing_epoch
      and node.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'BCLIF outcome writer fence is stale' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.bclif_assert_supersession_writer_fence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_uuid uuid;
  replacement_source uuid;
begin
  select source_id into source_uuid from public.bclif_field_chunks where id = new.superseded_tile_id;
  select source_id into replacement_source from public.bclif_field_chunks where id = new.replacement_tile_id;
  if source_uuid is null or replacement_source is distinct from source_uuid then
    raise exception 'BCLIF supersession crosses source authority' using errcode = '55000';
  end if;
  if not exists (
    select 1
    from public.bclif_sources source
    join public.bclif_collector_nodes node on node.node_id = source.collector_node
    where source.id = source_uuid
      and source.writer_instance_id = new.writer_instance_id
      and source.fencing_epoch = new.fencing_epoch
      and node.current_instance_id = new.writer_instance_id
      and node.fencing_epoch = new.fencing_epoch
      and node.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'BCLIF supersession writer fence is stale' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bclif_sources_writer_fence on public.bclif_sources;
create trigger trg_bclif_sources_writer_fence
before insert or update on public.bclif_sources
for each row execute function public.bclif_assert_source_writer_fence();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'bclif_source_offsets','bclif_event_deduplication','bclif_canonical_event_chunks',
    'bclif_cohort_checkpoints','bclif_coverage','bclif_confirmed_liquidation_events',
    'bclif_field_chunks','bclif_compaction_runs','bclif_object_deletion_queue',
    'bclif_cluster_predictions','bclif_model_evaluations'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', 'trg_' || table_name || '_writer_fence', table_name);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.bclif_assert_row_writer_fence()',
      'trg_' || table_name || '_writer_fence',
      table_name
    );
  end loop;
end;
$$;

drop trigger if exists trg_bclif_cluster_outcomes_writer_fence on public.bclif_cluster_outcomes;
create trigger trg_bclif_cluster_outcomes_writer_fence
before insert or update on public.bclif_cluster_outcomes
for each row execute function public.bclif_assert_outcome_writer_fence();

drop trigger if exists trg_bclif_tile_supersessions_writer_fence on public.bclif_tile_supersessions;
create trigger trg_bclif_tile_supersessions_writer_fence
before insert or update on public.bclif_tile_supersessions
for each row execute function public.bclif_assert_supersession_writer_fence();

-- Immutable publication and observed-event records. A STAGING tile may only be
-- finalized by replacing the row in one constrained update; after that it is
-- protected by the trigger below.
create or replace function public.bclif_guard_tile_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BCLIF tile metadata is immutable' using errcode = '55000';
  end if;
  if old.publication_state = 'STAGING'
     and new.publication_state = 'STAGING'
     and new.writer_instance_id <> old.writer_instance_id
     and new.fencing_epoch > old.fencing_epoch
     and (to_jsonb(new) - array['writer_instance_id','fencing_epoch']) =
         (to_jsonb(old) - array['writer_instance_id','fencing_epoch']) then
    -- Lease takeover may adopt an intact active snapshot without changing a
    -- single content byte. The writer-fence trigger independently proves the
    -- new token before this immutable guard runs.
    return new;
  end if;
  if old.publication_state = 'STAGING'
     and new.publication_state = 'STAGING'
     and new.columns > old.columns
     and new.chunk_end > old.chunk_end
     and new.source_cutoff_at >= new.chunk_end
     and new.source_cutoff_at > old.source_cutoff_at
     and new.object_path <> old.object_path
     and new.checksum <> old.checksum
     and (to_jsonb(new) - array[
       'chunk_end','columns','object_path','checksum','compressed_bytes','metadata',
       'source_cutoff_at','coverage_quality','channel_manifest','scale_metadata',
       'published_at','writer_instance_id','fencing_epoch'
     ]) = (to_jsonb(old) - array[
       'chunk_end','columns','object_path','checksum','compressed_bytes','metadata',
       'source_cutoff_at','coverage_quality','channel_manifest','scale_metadata',
       'published_at','writer_instance_id','fencing_epoch'
     ]) then
    return new;
  end if;
  if old.publication_state = 'STAGING'
     and new.publication_state = 'FINALIZED'
     and (to_jsonb(new) - array['publication_state','published_at']) =
         (to_jsonb(old) - array['publication_state','published_at']) then
    return new;
  end if;
  raise exception 'BCLIF tile metadata is immutable' using errcode = '55000';
end;
$$;

drop trigger if exists trg_bclif_field_chunks_immutable on public.bclif_field_chunks;
create trigger trg_bclif_field_chunks_immutable
before update or delete on public.bclif_field_chunks
for each row execute function public.bclif_guard_tile_change();

drop trigger if exists trg_bclif_confirmed_events_immutable on public.bclif_confirmed_liquidation_events;
create trigger trg_bclif_confirmed_events_immutable
before update or delete on public.bclif_confirmed_liquidation_events
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_event_chunks_immutable on public.bclif_canonical_event_chunks;
create trigger trg_bclif_event_chunks_immutable
before update or delete on public.bclif_canonical_event_chunks
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_checkpoints_immutable on public.bclif_cohort_checkpoints;
create trigger trg_bclif_checkpoints_immutable
before update or delete on public.bclif_cohort_checkpoints
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_tile_supersessions_immutable on public.bclif_tile_supersessions;
create trigger trg_bclif_tile_supersessions_immutable
before update or delete on public.bclif_tile_supersessions
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_cluster_predictions_immutable on public.bclif_cluster_predictions;
create trigger trg_bclif_cluster_predictions_immutable
before update or delete on public.bclif_cluster_predictions
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_cluster_outcomes_immutable on public.bclif_cluster_outcomes;
create trigger trg_bclif_cluster_outcomes_immutable
before update or delete on public.bclif_cluster_outcomes
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_bclif_certification_records_immutable on public.bclif_certification_records;
create trigger trg_bclif_certification_records_immutable
before update or delete on public.bclif_certification_records
for each row execute function public.bclif_reject_immutable_change();

-- RLS is deliberately service-only. Authenticated clients receive BCLIF data
-- through the entitlement-protected API and never query proprietary metadata.
alter table public.bclif_collector_nodes enable row level security;
alter table public.bclif_collector_instances enable row level security;
alter table public.bclif_source_offsets enable row level security;
alter table public.bclif_event_deduplication enable row level security;
alter table public.bclif_canonical_event_chunks enable row level security;
alter table public.bclif_cohort_checkpoints enable row level security;
alter table public.bclif_tile_supersessions enable row level security;
alter table public.bclif_compaction_runs enable row level security;
alter table public.bclif_retention_policies enable row level security;
alter table public.bclif_object_deletion_queue enable row level security;
alter table public.bclif_cluster_predictions enable row level security;
alter table public.bclif_cluster_outcomes enable row level security;
alter table public.bclif_certification_records enable row level security;

revoke all on public.bclif_sources from public, anon, authenticated, service_role;
revoke all on public.bclif_coverage from public, anon, authenticated, service_role;
revoke all on public.bclif_confirmed_liquidation_events from public, anon, authenticated, service_role;
revoke all on public.bclif_field_chunks from public, anon, authenticated, service_role;
revoke all on public.bclif_model_evaluations from public, anon, authenticated, service_role;
revoke all on public.bclif_collector_nodes from public, anon, authenticated;
revoke all on public.bclif_collector_instances from public, anon, authenticated;
revoke all on public.bclif_source_offsets from public, anon, authenticated;
revoke all on public.bclif_event_deduplication from public, anon, authenticated;
revoke all on public.bclif_canonical_event_chunks from public, anon, authenticated;
revoke all on public.bclif_cohort_checkpoints from public, anon, authenticated;
revoke all on public.bclif_tile_supersessions from public, anon, authenticated;
revoke all on public.bclif_compaction_runs from public, anon, authenticated;
revoke all on public.bclif_retention_policies from public, anon, authenticated;
revoke all on public.bclif_object_deletion_queue from public, anon, authenticated;
revoke all on public.bclif_cluster_predictions from public, anon, authenticated;
revoke all on public.bclif_cluster_outcomes from public, anon, authenticated;
revoke all on public.bclif_certification_records from public, anon, authenticated;

grant select, insert, update on public.bclif_sources to service_role;
grant select, insert, update on public.bclif_coverage to service_role;
grant select, insert on public.bclif_confirmed_liquidation_events to service_role;
grant select, insert, update on public.bclif_field_chunks to service_role;
grant select, insert on public.bclif_model_evaluations to service_role;
grant select, insert, update on public.bclif_collector_nodes to service_role;
grant select, insert, update on public.bclif_collector_instances to service_role;
grant select, insert, update on public.bclif_source_offsets to service_role;
grant select, insert, update, delete on public.bclif_event_deduplication to service_role;
grant select, insert on public.bclif_canonical_event_chunks to service_role;
grant select, insert on public.bclif_cohort_checkpoints to service_role;
grant select, insert on public.bclif_tile_supersessions to service_role;
grant select, insert, update on public.bclif_compaction_runs to service_role;
grant select, insert, update on public.bclif_retention_policies to service_role;
grant select, insert, update, delete on public.bclif_object_deletion_queue to service_role;
grant select, insert on public.bclif_cluster_predictions to service_role;
grant select, insert on public.bclif_cluster_outcomes to service_role;
grant select, insert on public.bclif_certification_records to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bclif-field-chunks',
  'bclif-field-chunks',
  false,
  52428800,
  array['application/octet-stream','application/gzip']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.bclif_storage_object_path_valid(candidate text)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select candidate ~ '^(v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.bclif|events/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(TRADE|LIQUIDATION|OPEN_INTEREST|BOOK_FRAME|FUNDING|MARK_INDEX|POSITION_RATIO|RISK_TIER|INSTRUMENT_INFO)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.events\\.gz|checkpoints/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\\.checkpoint\\.gz)$';
$$;
revoke all on function public.bclif_storage_object_path_valid(text) from public, anon, authenticated;
grant execute on function public.bclif_storage_object_path_valid(text) to service_role;

alter table public.bclif_object_deletion_queue drop constraint if exists bclif_object_deletion_queue_path_check;
alter table public.bclif_object_deletion_queue add constraint bclif_object_deletion_queue_path_check check (
  public.bclif_storage_object_path_valid(object_path)
);

drop policy if exists bclif_objects_service_select on storage.objects;
create policy bclif_objects_service_select
on storage.objects for select to service_role
using (
  bucket_id = 'bclif-field-chunks' and
  public.bclif_storage_object_path_valid(name)
);

drop policy if exists bclif_objects_service_insert on storage.objects;
create policy bclif_objects_service_insert
on storage.objects for insert to service_role
with check (
  bucket_id = 'bclif-field-chunks' and
  public.bclif_storage_object_path_valid(name)
);

drop policy if exists bclif_objects_service_delete on storage.objects;
create policy bclif_objects_service_delete
on storage.objects for delete to service_role
using (
  bucket_id = 'bclif-field-chunks' and
  public.bclif_storage_object_path_valid(name)
);

commit;
