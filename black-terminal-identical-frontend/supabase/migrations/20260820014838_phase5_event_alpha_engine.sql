begin;

-- BT-EAE-001: Event Alpha is a research and paper-execution control plane.
-- Every table is server-only. The browser consumes bounded projections through
-- /api/event-alpha and never receives direct table authority.

create table if not exists public.event_alpha_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique check (source_key ~ '^[A-Z0-9_:-]{3,80}$'),
  display_name text not null check (char_length(display_name) between 1 and 160),
  event_family text not null check (event_family in ('TOKEN_SUPPLY','GOVERNANCE','PROTOCOL_ECONOMICS')),
  adapter_version text not null check (char_length(adapter_version) between 1 and 80),
  authority_class text not null check (authority_class in ('PRIMARY','VERIFIED_PROVIDER','SECONDARY')),
  enabled boolean not null default false,
  health_status text not null default 'DISABLED' check (health_status in ('DISABLED','HEALTHY','DEGRADED','QUARANTINED')),
  last_success_at timestamptz,
  last_error_at timestamptz,
  safe_error_code text,
  configuration_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_alpha_raw_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.event_alpha_sources(id) on delete restrict,
  source_event_id text not null check (char_length(source_event_id) between 1 and 240),
  event_family text not null check (event_family in ('TOKEN_SUPPLY','GOVERNANCE','PROTOCOL_ECONOMICS')),
  observed_at timestamptz not null,
  first_actionable_at timestamptz not null,
  source_published_at timestamptz,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576),
  ingestion_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(ingestion_metadata) = 'object' and octet_length(ingestion_metadata::text) <= 65536),
  quarantined boolean not null default false,
  quarantine_reason_code text,
  ingested_at timestamptz not null default now(),
  unique (source_id, source_event_id, payload_hash),
  check (source_published_at is null or source_published_at <= observed_at),
  check (first_actionable_at <= observed_at)
);

create table if not exists public.event_alpha_canonical_events (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique check (char_length(canonical_key) between 16 and 240),
  event_family text not null check (event_family in ('TOKEN_SUPPLY','GOVERNANCE','PROTOCOL_ECONOMICS')),
  asset_id text not null check (asset_id ~ '^[A-Z0-9._:-]{2,80}$'),
  symbol text not null check (symbol ~ '^[A-Z0-9]{2,40}$'),
  venue_scope text[] not null default '{}'::text[],
  event_time timestamptz not null,
  first_actionable_at timestamptz not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED','INVALIDATED')),
  current_revision integer not null default 1 check (current_revision > 0),
  current_payload_hash text not null check (current_payload_hash ~ '^[a-f0-9]{64}$'),
  source_confidence numeric(7,6) not null check (source_confidence between 0 and 1),
  dedupe_fingerprint text not null check (dedupe_fingerprint ~ '^[a-f0-9]{64}$'),
  safe_summary text not null default '' check (char_length(safe_summary) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (first_actionable_at <= event_time)
);

create table if not exists public.event_alpha_event_revisions (
  id uuid primary key default gen_random_uuid(),
  canonical_event_id uuid not null references public.event_alpha_canonical_events(id) on delete restrict,
  raw_event_id uuid not null references public.event_alpha_raw_events(id) on delete restrict,
  revision integer not null check (revision > 0),
  effective_at timestamptz not null,
  known_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  normalized_payload jsonb not null check (jsonb_typeof(normalized_payload) = 'object' and octet_length(normalized_payload::text) <= 524288),
  changed_fields text[] not null default '{}'::text[],
  reason_code text not null check (char_length(reason_code) between 3 and 80),
  created_at timestamptz not null default now(),
  unique (canonical_event_id, revision),
  unique (canonical_event_id, payload_hash),
  check (effective_at <= known_at)
);

create table if not exists public.event_alpha_expectation_snapshots (
  id uuid primary key default gen_random_uuid(),
  canonical_event_id uuid not null references public.event_alpha_canonical_events(id) on delete restrict,
  expectation_key text not null unique check (expectation_key ~ '^[a-f0-9]{64}$'),
  snapshot_version integer not null check (snapshot_version > 0),
  as_of timestamptz not null,
  first_actionable_at timestamptz not null,
  model_key text not null check (char_length(model_key) between 3 and 120),
  model_version text not null check (char_length(model_version) between 1 and 80),
  expected_value numeric,
  expected_time timestamptz,
  expected_probability numeric(7,6) check (expected_probability is null or expected_probability between 0 and 1),
  dispersion numeric check (dispersion is null or dispersion >= 0),
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  contributor_count integer not null default 0 check (contributor_count >= 0),
  contributors jsonb not null default '[]'::jsonb check (jsonb_typeof(contributors) = 'array' and octet_length(contributors::text) <= 262144),
  feature_manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_manifest) = 'object' and octet_length(feature_manifest::text) <= 262144),
  created_at timestamptz not null default now(),
  unique (canonical_event_id, snapshot_version),
  check (as_of < first_actionable_at)
);

create table if not exists public.event_alpha_asset_profiles (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null,
  profile_version integer not null check (profile_version > 0),
  effective_from timestamptz not null,
  known_at timestamptz not null,
  circulating_supply numeric check (circulating_supply is null or circulating_supply >= 0),
  average_daily_dollar_volume numeric check (average_daily_dollar_volume is null or average_daily_dollar_volume >= 0),
  float_adjustment numeric(7,6) not null default 1 check (float_adjustment between 0 and 1),
  liquid_supply_ratio numeric(7,6) check (liquid_supply_ratio is null or liquid_supply_ratio between 0 and 1),
  value_capture_score numeric(7,6) check (value_capture_score is null or value_capture_score between 0 and 1),
  benchmark_symbol text,
  source_manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(source_manifest) = 'object' and octet_length(source_manifest::text) <= 262144),
  created_at timestamptz not null default now(),
  unique (asset_id, profile_version),
  check (effective_from <= known_at)
);

create table if not exists public.event_alpha_surprise_assessments (
  id uuid primary key default gen_random_uuid(),
  canonical_event_id uuid not null references public.event_alpha_canonical_events(id) on delete restrict,
  event_revision integer not null,
  expectation_snapshot_id uuid not null references public.event_alpha_expectation_snapshots(id) on delete restrict,
  assessed_at timestamptz not null,
  quantity_surprise numeric,
  timing_surprise numeric,
  probability_surprise numeric,
  structural_surprise numeric,
  composite_surprise numeric not null,
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  economic_impact jsonb not null check (jsonb_typeof(economic_impact) = 'object' and octet_length(economic_impact::text) <= 262144),
  reason_codes text[] not null default '{}'::text[],
  calculation_manifest jsonb not null check (jsonb_typeof(calculation_manifest) = 'object' and octet_length(calculation_manifest::text) <= 262144),
  created_at timestamptz not null default now(),
  unique (canonical_event_id, event_revision, expectation_snapshot_id)
);

create table if not exists public.event_alpha_response_forecasts (
  id uuid primary key default gen_random_uuid(),
  surprise_assessment_id uuid not null references public.event_alpha_surprise_assessments(id) on delete restrict,
  horizon_seconds integer not null check (horizon_seconds between 60 and 2592000),
  benchmark_symbol text,
  expected_abnormal_return_bps numeric not null,
  realized_abnormal_return_bps numeric not null,
  estimated_round_trip_cost_bps numeric not null check (estimated_round_trip_cost_bps >= 0),
  uncertainty_penalty_bps numeric not null check (uncertainty_penalty_bps >= 0),
  remaining_alpha_bps numeric not null,
  outcome text not null check (outcome in ('UNDERREACTION','FULLY_PRICED','OVERREACTION','AMBIGUOUS','NO_TRADE')),
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  price_cutoff_at timestamptz not null,
  calculation_manifest jsonb not null check (jsonb_typeof(calculation_manifest) = 'object' and octet_length(calculation_manifest::text) <= 262144),
  created_at timestamptz not null default now(),
  unique (surprise_assessment_id, horizon_seconds, price_cutoff_at)
);

create table if not exists public.event_alpha_theses (
  id uuid primary key default gen_random_uuid(),
  canonical_event_id uuid not null references public.event_alpha_canonical_events(id) on delete restrict,
  response_forecast_id uuid not null references public.event_alpha_response_forecasts(id) on delete restrict,
  thesis_key text not null unique check (char_length(thesis_key) between 16 and 240),
  state text not null default 'DRAFT' check (state in ('DRAFT','OBSERVING','ARMED','TRIGGERED','PAPER_ACTIVE','RESOLVED','EXPIRED','INVALIDATED','REJECTED')),
  direction text not null check (direction in ('LONG','SHORT','NEUTRAL')),
  event_family text not null check (event_family in ('TOKEN_SUPPLY','GOVERNANCE','PROTOCOL_ECONOMICS')),
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  remaining_alpha_bps numeric not null,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  tactical_setup_key text,
  last_triggered_at timestamptz,
  trigger_count integer not null default 0 check (trigger_count >= 0),
  reason_codes text[] not null default '{}'::text[],
  invalidation_conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(invalidation_conditions) = 'array' and octet_length(invalidation_conditions::text) <= 131072),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > valid_from)
);

create table if not exists public.event_alpha_thesis_transitions (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null references public.event_alpha_theses(id) on delete restrict,
  transition_sequence integer not null check (transition_sequence > 0),
  from_state text,
  to_state text not null,
  reason_codes text[] not null,
  actor_type text not null check (actor_type in ('SYSTEM','ADMIN','BC_RDA','PAPER_OMS')),
  actor_id uuid,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 131072),
  occurred_at timestamptz not null default now(),
  unique (thesis_id, transition_sequence)
);

create table if not exists public.event_alpha_risk_decisions (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null references public.event_alpha_theses(id) on delete restrict,
  decision_key text not null unique,
  decision text not null check (decision in ('ALLOW_PAPER','REJECT','EXPIRE','CANCEL')),
  approved_notional numeric not null default 0 check (approved_notional >= 0),
  max_loss numeric not null default 0 check (max_loss >= 0),
  reason_codes text[] not null,
  evidence_cutoff_at timestamptz not null,
  policy_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.event_alpha_trade_intents (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null references public.event_alpha_theses(id) on delete restrict,
  risk_decision_id uuid not null references public.event_alpha_risk_decisions(id) on delete restrict,
  client_intent_id text not null unique,
  mode text not null default 'PAPER' check (mode = 'PAPER'),
  symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  order_type text not null check (order_type in ('MARKET','LIMIT')),
  quantity numeric not null check (quantity > 0),
  limit_price numeric check (limit_price is null or limit_price > 0),
  expires_at timestamptz not null,
  status text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL','APPROVED','QUEUED','FILLED','CANCELLED','EXPIRED','REJECTED')),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  canonical_payload jsonb not null check (jsonb_typeof(canonical_payload) = 'object' and octet_length(canonical_payload::text) <= 131072),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_alpha_paper_orders (
  id uuid primary key default gen_random_uuid(),
  trade_intent_id uuid not null references public.event_alpha_trade_intents(id) on delete restrict,
  paper_order_id text not null unique,
  status text not null check (status in ('QUEUED','OPEN','PARTIALLY_FILLED','FILLED','CANCELLED','EXPIRED','REJECTED')),
  submitted_at timestamptz,
  filled_quantity numeric not null default 0 check (filled_quantity >= 0),
  average_fill_price numeric check (average_fill_price is null or average_fill_price > 0),
  total_fees numeric not null default 0 check (total_fees >= 0),
  version integer not null default 1 check (version > 0),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object' and octet_length(safe_metadata::text) <= 131072),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_alpha_paper_fills (
  id uuid primary key default gen_random_uuid(),
  paper_order_id uuid not null references public.event_alpha_paper_orders(id) on delete restrict,
  fill_key text not null unique,
  quantity numeric not null check (quantity > 0),
  price numeric not null check (price > 0),
  fee numeric not null check (fee >= 0),
  slippage_bps numeric not null,
  filled_at timestamptz not null,
  market_data_cutoff_at timestamptz not null,
  model_version text not null,
  created_at timestamptz not null default now(),
  check (market_data_cutoff_at <= filled_at)
);

create table if not exists public.event_alpha_paper_positions (
  id uuid primary key default gen_random_uuid(),
  thesis_id uuid not null unique references public.event_alpha_theses(id) on delete restrict,
  trade_intent_id uuid not null unique references public.event_alpha_trade_intents(id) on delete restrict,
  paper_order_id uuid not null unique references public.event_alpha_paper_orders(id) on delete restrict,
  symbol text not null check (symbol ~ '^[A-Z0-9]{2,40}$'),
  direction text not null check (direction in ('LONG','SHORT')),
  quantity numeric not null check (quantity > 0),
  average_entry_price numeric not null check (average_entry_price > 0),
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  total_fees numeric not null default 0 check (total_fees >= 0),
  total_funding numeric not null default 0,
  opened_at timestamptz not null,
  market_data_cutoff_at timestamptz not null,
  closed_at timestamptz,
  version integer not null default 1 check (version > 0),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object' and octet_length(safe_metadata::text) <= 131072),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'CLOSED') = (closed_at is not null)),
  check (market_data_cutoff_at <= opened_at)
);

create table if not exists public.event_alpha_decision_audit (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null,
  canonical_event_id uuid references public.event_alpha_canonical_events(id) on delete restrict,
  thesis_id uuid references public.event_alpha_theses(id) on delete restrict,
  decision_type text not null check (char_length(decision_type) between 3 and 100),
  outcome text not null check (char_length(outcome) between 2 and 100),
  reason_codes text[] not null default '{}'::text[],
  model_versions jsonb not null default '{}'::jsonb check (jsonb_typeof(model_versions) = 'object' and octet_length(model_versions::text) <= 65536),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object' and octet_length(safe_metadata::text) <= 131072),
  actor_type text not null check (actor_type in ('SYSTEM','ADMIN','BC_RDA','PAPER_OMS')),
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.event_alpha_source_checkpoints (
  source_id uuid primary key references public.event_alpha_sources(id) on delete cascade,
  cursor_value text,
  watermark_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  backoff_until timestamptz,
  last_error_code text,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_alpha_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('NORMALIZE','ASSESS','FORECAST','THESIS','PAPER_EXECUTE','REPLAY')),
  canonical_event_id uuid references public.event_alpha_canonical_events(id) on delete restrict,
  raw_event_id uuid references public.event_alpha_raw_events(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 131072),
  status text not null default 'QUEUED' check (status in ('QUEUED','PROCESSING','COMPLETED','FAILED','DEAD_LETTER')),
  priority integer not null default 100,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  idempotency_key text not null unique,
  safe_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'PROCESSING') = (locked_by is not null and locked_until is not null))
);

create table if not exists public.event_alpha_model_artifacts (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  model_version text not null,
  artifact_hash text not null check (artifact_hash ~ '^[a-f0-9]{64}$'),
  training_cutoff_at timestamptz not null,
  feature_manifest jsonb not null check (jsonb_typeof(feature_manifest) = 'object' and octet_length(feature_manifest::text) <= 262144),
  evaluation_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(evaluation_metrics) = 'object' and octet_length(evaluation_metrics::text) <= 131072),
  status text not null check (status in ('CANDIDATE','ACTIVE','RETIRED','REJECTED')),
  created_at timestamptz not null default now(),
  unique (model_key, model_version)
);

create table if not exists public.event_alpha_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  status text not null check (status in ('QUEUED','RUNNING','COMPLETED','FAILED')),
  point_in_time_cutoff timestamptz not null,
  input_manifest jsonb not null check (jsonb_typeof(input_manifest) = 'object' and octet_length(input_manifest::text) <= 524288),
  result_manifest jsonb check (result_manifest is null or (jsonb_typeof(result_manifest) = 'object' and octet_length(result_manifest::text) <= 1048576)),
  model_versions jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_event_alpha_raw_observed on public.event_alpha_raw_events(source_id, observed_at desc, id);
create index if not exists idx_event_alpha_raw_quarantine on public.event_alpha_raw_events(observed_at desc) where quarantined;
create index if not exists idx_event_alpha_events_feed on public.event_alpha_canonical_events(first_actionable_at desc, id);
create index if not exists idx_event_alpha_events_asset on public.event_alpha_canonical_events(asset_id, event_time desc, id);
create index if not exists idx_event_alpha_revisions_known on public.event_alpha_event_revisions(canonical_event_id, known_at desc, revision desc);
create index if not exists idx_event_alpha_revisions_raw on public.event_alpha_event_revisions(raw_event_id);
create index if not exists idx_event_alpha_expectations_asof on public.event_alpha_expectation_snapshots(canonical_event_id, as_of desc, snapshot_version desc);
create index if not exists idx_event_alpha_profiles_pit on public.event_alpha_asset_profiles(asset_id, known_at desc, profile_version desc);
create index if not exists idx_event_alpha_forecasts_created on public.event_alpha_response_forecasts(created_at desc, id);
create index if not exists idx_event_alpha_surprises_expectation on public.event_alpha_surprise_assessments(expectation_snapshot_id);
create index if not exists idx_event_alpha_forecasts_surprise on public.event_alpha_response_forecasts(surprise_assessment_id);
create index if not exists idx_event_alpha_theses_state on public.event_alpha_theses(state, expires_at, id);
create index if not exists idx_event_alpha_theses_event on public.event_alpha_theses(canonical_event_id, created_at desc, id);
create index if not exists idx_event_alpha_theses_forecast on public.event_alpha_theses(response_forecast_id);
create index if not exists idx_event_alpha_transitions_thesis on public.event_alpha_thesis_transitions(thesis_id, transition_sequence desc);
create index if not exists idx_event_alpha_intents_status on public.event_alpha_trade_intents(status, expires_at, id);
create index if not exists idx_event_alpha_intents_thesis on public.event_alpha_trade_intents(thesis_id, created_at desc, id);
create index if not exists idx_event_alpha_intents_risk on public.event_alpha_trade_intents(risk_decision_id);
create unique index if not exists idx_event_alpha_paper_orders_intent on public.event_alpha_paper_orders(trade_intent_id);
create index if not exists idx_event_alpha_paper_fills_order on public.event_alpha_paper_fills(paper_order_id, filled_at, id);
create index if not exists idx_event_alpha_paper_positions_status on public.event_alpha_paper_positions(status, opened_at desc, id);
create index if not exists idx_event_alpha_jobs_claim on public.event_alpha_processing_jobs(priority, available_at, id) where status = 'QUEUED';
create index if not exists idx_event_alpha_jobs_expired_lease on public.event_alpha_processing_jobs(locked_until, priority, id) where status = 'PROCESSING';
create index if not exists idx_event_alpha_audit_event on public.event_alpha_decision_audit(canonical_event_id, created_at desc, id);
create index if not exists idx_event_alpha_audit_thesis on public.event_alpha_decision_audit(thesis_id, created_at desc, id);
create unique index if not exists idx_event_alpha_audit_idempotency on public.event_alpha_decision_audit(correlation_id, decision_type, outcome, evidence_hash);

create or replace function public.event_alpha_reject_immutable_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'EVENT_ALPHA_IMMUTABLE_LEDGER';
end;
$$;

create or replace function public.event_alpha_ingest_token_unlock_v1(
  p_source_id uuid,
  p_source_event_id text,
  p_observed_at timestamptz,
  p_first_actionable_at timestamptz,
  p_source_published_at timestamptz,
  p_payload_hash text,
  p_payload jsonb,
  p_ingestion_metadata jsonb,
  p_canonical_key text,
  p_asset_id text,
  p_symbol text,
  p_event_time timestamptz,
  p_source_confidence numeric,
  p_dedupe_fingerprint text,
  p_safe_summary text,
  p_normalized_payload jsonb
)
returns table(raw_event_id uuid, canonical_event_id uuid, event_revision integer, was_duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  raw_row public.event_alpha_raw_events;
  event_row public.event_alpha_canonical_events;
  next_revision integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_canonical_key, 0));

  insert into public.event_alpha_raw_events(
    source_id, source_event_id, event_family, observed_at, first_actionable_at,
    source_published_at, payload_hash, payload, ingestion_metadata
  ) values (
    p_source_id, p_source_event_id, 'TOKEN_SUPPLY', p_observed_at, p_first_actionable_at,
    p_source_published_at, p_payload_hash, p_payload, coalesce(p_ingestion_metadata, '{}'::jsonb)
  )
  on conflict (source_id, source_event_id, payload_hash) do nothing
  returning * into raw_row;

  if raw_row.id is null then
    select * into raw_row
    from public.event_alpha_raw_events
    where source_id = p_source_id and source_event_id = p_source_event_id and payload_hash = p_payload_hash;
  end if;

  select * into event_row from public.event_alpha_canonical_events
  where canonical_key = p_canonical_key for update;

  if event_row.id is null then
    insert into public.event_alpha_canonical_events(
      canonical_key, event_family, asset_id, symbol, event_time, first_actionable_at,
      current_revision, current_payload_hash, source_confidence, dedupe_fingerprint, safe_summary
    ) values (
      p_canonical_key, 'TOKEN_SUPPLY', p_asset_id, p_symbol, p_event_time, p_first_actionable_at,
      1, p_payload_hash, p_source_confidence, p_dedupe_fingerprint, p_safe_summary
    ) returning * into event_row;
    insert into public.event_alpha_event_revisions(
      canonical_event_id, raw_event_id, revision, effective_at, known_at, payload_hash,
      normalized_payload, changed_fields, reason_code
    ) values (
      event_row.id, raw_row.id, 1, p_first_actionable_at, now(), p_payload_hash,
      p_normalized_payload, array(select jsonb_object_keys(p_normalized_payload)), 'INITIAL_SOURCE_EVIDENCE'
    );
    insert into public.event_alpha_processing_jobs(job_type, canonical_event_id, raw_event_id, payload, status, idempotency_key)
    values ('ASSESS', event_row.id, raw_row.id, jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', 1), 'QUEUED', 'assess:' || event_row.id::text || ':1')
    on conflict (idempotency_key) do nothing;
    return query select raw_row.id, event_row.id, 1, false;
    return;
  end if;

  if event_row.current_payload_hash = p_payload_hash then
    insert into public.event_alpha_processing_jobs(job_type, canonical_event_id, raw_event_id, payload, status, idempotency_key)
    values ('ASSESS', event_row.id, raw_row.id, jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', event_row.current_revision), 'QUEUED', 'assess:' || event_row.id::text || ':' || event_row.current_revision::text)
    on conflict (idempotency_key) do nothing;
    return query select raw_row.id, event_row.id, event_row.current_revision, true;
    return;
  end if;

  next_revision := event_row.current_revision + 1;
  insert into public.event_alpha_event_revisions(
    canonical_event_id, raw_event_id, revision, effective_at, known_at, payload_hash,
    normalized_payload, changed_fields, reason_code
  ) values (
    event_row.id, raw_row.id, next_revision, p_first_actionable_at, now(), p_payload_hash,
    p_normalized_payload, array['SOURCE_REVISION'], 'MATERIAL_SOURCE_REVISION'
  );
  update public.event_alpha_canonical_events
     set current_revision = next_revision,
         current_payload_hash = p_payload_hash,
         source_confidence = p_source_confidence,
         dedupe_fingerprint = p_dedupe_fingerprint,
         safe_summary = p_safe_summary,
         updated_at = now()
   where id = event_row.id
  returning * into event_row;
  insert into public.event_alpha_processing_jobs(job_type, canonical_event_id, raw_event_id, payload, status, idempotency_key)
  values ('ASSESS', event_row.id, raw_row.id, jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', next_revision), 'QUEUED', 'assess:' || event_row.id::text || ':' || next_revision::text)
  on conflict (idempotency_key) do nothing;
  return query select raw_row.id, event_row.id, next_revision, false;
end;
$$;

drop trigger if exists event_alpha_raw_immutable on public.event_alpha_raw_events;
create trigger event_alpha_raw_immutable before update or delete on public.event_alpha_raw_events
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_revision_immutable on public.event_alpha_event_revisions;
create trigger event_alpha_revision_immutable before update or delete on public.event_alpha_event_revisions
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_expectation_immutable on public.event_alpha_expectation_snapshots;
create trigger event_alpha_expectation_immutable before update or delete on public.event_alpha_expectation_snapshots
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_transition_immutable on public.event_alpha_thesis_transitions;
create trigger event_alpha_transition_immutable before update or delete on public.event_alpha_thesis_transitions
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_risk_immutable on public.event_alpha_risk_decisions;
create trigger event_alpha_risk_immutable before update or delete on public.event_alpha_risk_decisions
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_fill_immutable on public.event_alpha_paper_fills;
create trigger event_alpha_fill_immutable before update or delete on public.event_alpha_paper_fills
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_audit_immutable on public.event_alpha_decision_audit;
create trigger event_alpha_audit_immutable before update or delete on public.event_alpha_decision_audit
for each row execute function public.event_alpha_reject_immutable_mutation_v1();

create or replace function public.event_alpha_claim_jobs_v1(
  p_worker_id text,
  p_limit integer default 20,
  p_lease_seconds integer default 60
)
returns setof public.event_alpha_processing_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(btrim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_WORKER_ID_REQUIRED';
  end if;
  if p_limit < 1 or p_limit > 100 or p_lease_seconds < 10 or p_lease_seconds > 600 then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_CLAIM_BOUND_INVALID';
  end if;
  return query
  with candidates as (
    select j.id
    from public.event_alpha_processing_jobs j
    where (j.status = 'QUEUED' and j.available_at <= now())
       or (j.status = 'PROCESSING' and j.locked_until <= now())
    order by j.priority asc, j.available_at asc, j.id asc
    for update skip locked
    limit p_limit
  )
  update public.event_alpha_processing_jobs j
     set status = 'PROCESSING',
         attempts = j.attempts + 1,
         locked_by = p_worker_id,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
    from candidates c
   where j.id = c.id
  returning j.*;
end;
$$;

create or replace function public.event_alpha_insert_expectation_v1(
  p_canonical_event_id uuid,
  p_expectation_key text,
  p_as_of timestamptz,
  p_first_actionable_at timestamptz,
  p_model_key text,
  p_model_version text,
  p_expected_value numeric,
  p_expected_time timestamptz,
  p_expected_probability numeric,
  p_dispersion numeric,
  p_confidence numeric,
  p_contributors jsonb,
  p_feature_manifest jsonb
)
returns public.event_alpha_expectation_snapshots
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_row public.event_alpha_expectation_snapshots;
  next_version integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_canonical_event_id::text, 1));
  select * into existing_row from public.event_alpha_expectation_snapshots where expectation_key = p_expectation_key;
  if existing_row.id is not null then
    if existing_row.canonical_event_id <> p_canonical_event_id then
      raise exception using errcode = '23505', message = 'EVENT_ALPHA_EXPECTATION_IDENTITY_COLLISION';
    end if;
    return existing_row;
  end if;
  select coalesce(max(snapshot_version), 0) + 1 into next_version
  from public.event_alpha_expectation_snapshots where canonical_event_id = p_canonical_event_id;
  insert into public.event_alpha_expectation_snapshots(
    canonical_event_id, expectation_key, snapshot_version, as_of, first_actionable_at,
    model_key, model_version, expected_value, expected_time, expected_probability,
    dispersion, confidence, contributor_count, contributors, feature_manifest
  ) values (
    p_canonical_event_id, p_expectation_key, next_version, p_as_of, p_first_actionable_at,
    p_model_key, p_model_version, p_expected_value, p_expected_time, p_expected_probability,
    p_dispersion, p_confidence, jsonb_array_length(coalesce(p_contributors, '[]'::jsonb)),
    coalesce(p_contributors, '[]'::jsonb), coalesce(p_feature_manifest, '{}'::jsonb)
  ) returning * into existing_row;
  return existing_row;
end;
$$;

create or replace function public.event_alpha_approve_paper_intent_v1(
  p_intent_id uuid,
  p_symbol text,
  p_market_price numeric,
  p_market_cutoff_at timestamptz,
  p_job_idempotency_key text
)
returns public.event_alpha_trade_intents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row public.event_alpha_trade_intents;
  event_id uuid;
begin
  select * into intent_row from public.event_alpha_trade_intents where id = p_intent_id for update;
  if intent_row.id is null then raise exception using errcode = 'P0002', message = 'EVENT_ALPHA_INTENT_NOT_FOUND'; end if;
  if intent_row.status = 'QUEUED' then return intent_row; end if;
  if intent_row.status <> 'PENDING_APPROVAL' or intent_row.expires_at <= now() then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_INTENT_NOT_APPROVABLE';
  end if;
  if intent_row.symbol <> p_symbol or p_market_price <= 0 or p_market_cutoff_at > now()
     or p_market_cutoff_at < now() - interval '120 seconds' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PAPER_MARKET_INVALID';
  end if;
  select canonical_event_id into event_id from public.event_alpha_theses where id = intent_row.thesis_id;
  insert into public.event_alpha_processing_jobs(
    job_type, canonical_event_id, payload, status, priority, idempotency_key
  ) values (
    'PAPER_EXECUTE', event_id,
    jsonb_build_object('intentId', intent_row.id, 'market', jsonb_build_object('symbol', p_symbol, 'price', p_market_price, 'cutoffAt', p_market_cutoff_at)),
    'QUEUED', 20, p_job_idempotency_key
  ) on conflict (idempotency_key) do nothing;
  update public.event_alpha_trade_intents set status = 'QUEUED', updated_at = now()
  where id = intent_row.id returning * into intent_row;
  return intent_row;
end;
$$;

create or replace function public.event_alpha_create_paper_intent_v1(
  p_thesis_id uuid,
  p_expected_thesis_version integer,
  p_decision_key text,
  p_approved_notional numeric,
  p_max_loss numeric,
  p_reason_codes text[],
  p_evidence_cutoff_at timestamptz,
  p_policy_version text,
  p_client_intent_id text,
  p_symbol text,
  p_side text,
  p_quantity numeric,
  p_expires_at timestamptz,
  p_idempotency_key text,
  p_canonical_payload jsonb,
  p_tactical_setup_key text,
  p_actor_id uuid
)
returns public.event_alpha_trade_intents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  thesis_row public.event_alpha_theses;
  risk_row public.event_alpha_risk_decisions;
  intent_row public.event_alpha_trade_intents;
  next_sequence integer;
  expected_symbol text;
begin
  select * into intent_row from public.event_alpha_trade_intents where idempotency_key = p_idempotency_key;
  if intent_row.id is not null then
    if intent_row.thesis_id <> p_thesis_id then raise exception using errcode = '23505', message = 'EVENT_ALPHA_INTENT_IDENTITY_COLLISION'; end if;
    return intent_row;
  end if;
  select * into thesis_row from public.event_alpha_theses where id = p_thesis_id for update;
  if thesis_row.id is null then raise exception using errcode = 'P0002', message = 'EVENT_ALPHA_THESIS_NOT_FOUND'; end if;
  if thesis_row.version <> p_expected_thesis_version then raise exception using errcode = '40001', message = 'EVENT_ALPHA_THESIS_VERSION_CONFLICT'; end if;
  if thesis_row.state <> 'ARMED' or thesis_row.expires_at <= now() then raise exception using errcode = '22023', message = 'EVENT_ALPHA_THESIS_NOT_ARMED'; end if;
  select symbol into expected_symbol from public.event_alpha_canonical_events where id = thesis_row.canonical_event_id;
  if p_quantity <= 0 or p_approved_notional <= 0 or p_max_loss < 0 or p_expires_at <> thesis_row.expires_at
     or p_symbol <> expected_symbol or coalesce(cardinality(p_reason_codes), 0) = 0
     or nullif(btrim(p_tactical_setup_key), '') is null or jsonb_typeof(p_canonical_payload) <> 'object'
     or p_evidence_cutoff_at > now() or p_evidence_cutoff_at < now() - interval '120 seconds' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PAPER_INTENT_INVALID';
  end if;
  if (thesis_row.direction = 'LONG' and p_side <> 'BUY') or (thesis_row.direction = 'SHORT' and p_side <> 'SELL') or thesis_row.direction = 'NEUTRAL' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PAPER_DIRECTION_INVALID';
  end if;
  insert into public.event_alpha_risk_decisions(
    thesis_id, decision_key, decision, approved_notional, max_loss, reason_codes,
    evidence_cutoff_at, policy_version
  ) values (
    p_thesis_id, p_decision_key, 'ALLOW_PAPER', p_approved_notional, p_max_loss,
    p_reason_codes, p_evidence_cutoff_at, p_policy_version
  ) on conflict (decision_key) do nothing;
  select * into risk_row from public.event_alpha_risk_decisions where decision_key = p_decision_key;
  if risk_row.thesis_id <> p_thesis_id or risk_row.decision <> 'ALLOW_PAPER' then
    raise exception using errcode = '23505', message = 'EVENT_ALPHA_RISK_IDENTITY_COLLISION';
  end if;
  insert into public.event_alpha_trade_intents(
    thesis_id, risk_decision_id, client_intent_id, mode, symbol, side, order_type,
    quantity, expires_at, status, idempotency_key, canonical_payload, created_by
  ) values (
    p_thesis_id, risk_row.id, p_client_intent_id, 'PAPER', p_symbol, p_side, 'MARKET',
    p_quantity, p_expires_at, 'PENDING_APPROVAL', p_idempotency_key, p_canonical_payload, p_actor_id
  ) returning * into intent_row;
  select coalesce(max(transition_sequence), 0) + 1 into next_sequence
  from public.event_alpha_thesis_transitions where thesis_id = p_thesis_id;
  insert into public.event_alpha_thesis_transitions(
    thesis_id, transition_sequence, from_state, to_state, reason_codes, actor_type, actor_id, evidence
  ) values (
    p_thesis_id, next_sequence, 'ARMED', 'TRIGGERED', p_reason_codes, 'BC_RDA', p_actor_id,
    jsonb_build_object('tacticalSetupKey', p_tactical_setup_key, 'paperIntentId', intent_row.id)
  );
  update public.event_alpha_theses
     set state = 'TRIGGERED', tactical_setup_key = p_tactical_setup_key,
         last_triggered_at = now(), trigger_count = trigger_count + 1,
         version = version + 1, updated_at = now()
   where id = p_thesis_id;
  return intent_row;
end;
$$;

create or replace function public.event_alpha_mark_paper_active_v1(p_intent_id uuid)
returns public.event_alpha_theses
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row public.event_alpha_trade_intents;
  thesis_row public.event_alpha_theses;
  next_sequence integer;
begin
  select * into intent_row from public.event_alpha_trade_intents where id = p_intent_id;
  if intent_row.id is null or intent_row.status <> 'FILLED' then raise exception using errcode = '22023', message = 'EVENT_ALPHA_PAPER_FILL_NOT_FINAL'; end if;
  select * into thesis_row from public.event_alpha_theses where id = intent_row.thesis_id for update;
  if thesis_row.state = 'PAPER_ACTIVE' then return thesis_row; end if;
  if thesis_row.state <> 'TRIGGERED' then raise exception using errcode = '22023', message = 'EVENT_ALPHA_THESIS_NOT_TRIGGERED'; end if;
  select coalesce(max(transition_sequence), 0) + 1 into next_sequence
  from public.event_alpha_thesis_transitions where thesis_id = thesis_row.id;
  insert into public.event_alpha_thesis_transitions(
    thesis_id, transition_sequence, from_state, to_state, reason_codes, actor_type, evidence
  ) values (
    thesis_row.id, next_sequence, 'TRIGGERED', 'PAPER_ACTIVE', array['PAPER_FILL_CONFIRMED'], 'PAPER_OMS',
    jsonb_build_object('paperIntentId', intent_row.id)
  );
  update public.event_alpha_theses set state = 'PAPER_ACTIVE', version = version + 1, updated_at = now()
  where id = thesis_row.id returning * into thesis_row;
  return thesis_row;
end;
$$;

create or replace function public.event_alpha_transition_thesis_v1(
  p_thesis_id uuid,
  p_expected_version integer,
  p_to_state text,
  p_reason_codes text[],
  p_actor_type text,
  p_actor_id uuid default null,
  p_evidence jsonb default '{}'::jsonb
)
returns public.event_alpha_theses
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.event_alpha_theses;
  allowed boolean := false;
  next_sequence integer;
begin
  select * into current_row from public.event_alpha_theses where id = p_thesis_id for update;
  if current_row.id is null then raise exception using errcode = 'P0002', message = 'EVENT_ALPHA_THESIS_NOT_FOUND'; end if;
  if current_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'EVENT_ALPHA_THESIS_VERSION_CONFLICT'; end if;
  if coalesce(cardinality(p_reason_codes), 0) = 0 then raise exception using errcode = '22023', message = 'EVENT_ALPHA_REASON_CODE_REQUIRED'; end if;
  allowed := case current_row.state
    when 'DRAFT' then p_to_state in ('OBSERVING','REJECTED','INVALIDATED')
    when 'OBSERVING' then p_to_state in ('ARMED','EXPIRED','INVALIDATED','REJECTED')
    when 'ARMED' then p_to_state in ('TRIGGERED','OBSERVING','EXPIRED','INVALIDATED','REJECTED')
    when 'TRIGGERED' then p_to_state in ('PAPER_ACTIVE','RESOLVED','EXPIRED','INVALIDATED','REJECTED')
    when 'PAPER_ACTIVE' then p_to_state in ('RESOLVED','EXPIRED','INVALIDATED')
    else false
  end;
  if not allowed then raise exception using errcode = '22023', message = 'EVENT_ALPHA_TRANSITION_INVALID'; end if;
  select coalesce(max(transition_sequence), 0) + 1 into next_sequence
  from public.event_alpha_thesis_transitions where thesis_id = p_thesis_id;
  insert into public.event_alpha_thesis_transitions(thesis_id, transition_sequence, from_state, to_state, reason_codes, actor_type, actor_id, evidence)
  values (p_thesis_id, next_sequence, current_row.state, p_to_state, p_reason_codes, p_actor_type, p_actor_id, coalesce(p_evidence, '{}'::jsonb));
  update public.event_alpha_theses
     set state = p_to_state,
         version = version + 1,
         updated_at = now(),
         last_triggered_at = case when p_to_state = 'TRIGGERED' then now() else last_triggered_at end,
         trigger_count = trigger_count + case when p_to_state = 'TRIGGERED' then 1 else 0 end
   where id = p_thesis_id
  returning * into current_row;
  return current_row;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_alpha_sources','event_alpha_raw_events','event_alpha_canonical_events','event_alpha_event_revisions',
    'event_alpha_expectation_snapshots','event_alpha_asset_profiles','event_alpha_surprise_assessments',
    'event_alpha_response_forecasts','event_alpha_theses','event_alpha_thesis_transitions','event_alpha_risk_decisions',
    'event_alpha_trade_intents','event_alpha_paper_orders','event_alpha_paper_fills','event_alpha_paper_positions','event_alpha_decision_audit',
    'event_alpha_source_checkpoints','event_alpha_processing_jobs','event_alpha_model_artifacts','event_alpha_backtest_runs'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update on table public.%I to service_role', table_name);
  end loop;
end $$;

revoke all on function public.event_alpha_reject_immutable_mutation_v1() from public, anon, authenticated;
revoke all on function public.event_alpha_ingest_token_unlock_v1(uuid, text, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb, text, text, text, timestamptz, numeric, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.event_alpha_claim_jobs_v1(text, integer, integer) from public, anon, authenticated;
revoke all on function public.event_alpha_insert_expectation_v1(uuid, text, timestamptz, timestamptz, text, text, numeric, timestamptz, numeric, numeric, numeric, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.event_alpha_approve_paper_intent_v1(uuid, text, numeric, timestamptz, text) from public, anon, authenticated;
revoke all on function public.event_alpha_create_paper_intent_v1(uuid, integer, text, numeric, numeric, text[], timestamptz, text, text, text, text, numeric, timestamptz, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.event_alpha_mark_paper_active_v1(uuid) from public, anon, authenticated;
revoke all on function public.event_alpha_transition_thesis_v1(uuid, integer, text, text[], text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.event_alpha_claim_jobs_v1(text, integer, integer) to service_role;
grant execute on function public.event_alpha_insert_expectation_v1(uuid, text, timestamptz, timestamptz, text, text, numeric, timestamptz, numeric, numeric, numeric, jsonb, jsonb) to service_role;
grant execute on function public.event_alpha_approve_paper_intent_v1(uuid, text, numeric, timestamptz, text) to service_role;
grant execute on function public.event_alpha_create_paper_intent_v1(uuid, integer, text, numeric, numeric, text[], timestamptz, text, text, text, text, numeric, timestamptz, text, jsonb, text, uuid) to service_role;
grant execute on function public.event_alpha_mark_paper_active_v1(uuid) to service_role;
grant execute on function public.event_alpha_ingest_token_unlock_v1(uuid, text, timestamptz, timestamptz, timestamptz, text, jsonb, jsonb, text, text, text, timestamptz, numeric, text, text, jsonb) to service_role;
grant execute on function public.event_alpha_transition_thesis_v1(uuid, integer, text, text[], text, uuid, jsonb) to service_role;

comment on schema public is 'Black Terminal application schema. Event Alpha tables are service-role-only and exposed through authenticated bounded projections.';
comment on table public.event_alpha_raw_events is 'Immutable source evidence. Raw external text is untrusted data and never executable instructions.';
comment on table public.event_alpha_expectation_snapshots is 'Point-in-time expectation evidence; as_of must precede first_actionable_at.';
comment on table public.event_alpha_trade_intents is 'Paper-only Event Alpha intent ledger. The schema check forbids live mode.';

commit;
