begin;

-- Equity PEAD is isolated from Crypto Event Drift. These server-only tables
-- preserve point-in-time consensus, announcement facts and factor-adjusted
-- returns without pretending that a crypto protocol event is an earnings event.

create table if not exists public.event_alpha_pead_providers (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique check (provider_key ~ '^[A-Z0-9_:-]{3,80}$'),
  display_name text not null check (char_length(display_name) between 1 and 160),
  adapter_version text not null check (char_length(adapter_version) between 1 and 80),
  enabled boolean not null default false,
  health_status text not null default 'DISABLED' check (health_status in ('DISABLED','HEALTHY','DEGRADED','QUARANTINED')),
  last_success_at timestamptz,
  last_error_at timestamptz,
  safe_error_code text,
  cursor_value text,
  configuration_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_alpha_pead_events (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique check (canonical_key ~ '^EQUITY_PEAD:' and char_length(canonical_key) <= 320),
  provider_id uuid not null references public.event_alpha_pead_providers(id) on delete restrict,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 240),
  cik text check (cik is null or cik ~ '^[0-9]{10}$'),
  ticker text not null check (ticker ~ '^[A-Z0-9][A-Z0-9.-]{0,14}$'),
  issuer text not null check (char_length(issuer) between 1 and 240),
  fiscal_period text not null check (char_length(fiscal_period) between 1 and 40),
  announced_at timestamptz not null,
  first_actionable_at timestamptz not null,
  expectation_as_of timestamptz not null,
  announcement_session text not null check (announcement_session in ('PRE_MARKET','REGULAR','AFTER_HOURS','UNKNOWN')),
  status text not null default 'ASSESSED' check (status in ('AWAITING_EVIDENCE','ASSESSED','INVALIDATED')),
  current_revision integer not null default 1 check (current_revision > 0),
  current_evidence_hash text not null check (current_evidence_hash ~ '^[a-f0-9]{64}$'),
  source_confidence numeric(7,6) not null check (source_confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, provider_event_id),
  check (expectation_as_of < first_actionable_at),
  check (announced_at <= first_actionable_at + interval '1 minute')
);

create table if not exists public.event_alpha_pead_evidence (
  id uuid primary key default gen_random_uuid(),
  pead_event_id uuid not null references public.event_alpha_pead_events(id) on delete restrict,
  revision integer not null check (revision > 0),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  expectation_as_of timestamptz not null,
  first_actionable_at timestamptz not null,
  immutable_evidence jsonb not null check (jsonb_typeof(immutable_evidence) = 'object' and octet_length(immutable_evidence::text) <= 1048576),
  source_manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(source_manifest) = 'object' and octet_length(source_manifest::text) <= 262144),
  filing_url text,
  consensus_source_url text,
  price_source_url text,
  known_at timestamptz not null default now(),
  unique (pead_event_id, revision),
  unique (pead_event_id, evidence_hash),
  check (expectation_as_of < first_actionable_at)
);

create table if not exists public.event_alpha_pead_signals (
  id uuid primary key default gen_random_uuid(),
  pead_event_id uuid not null references public.event_alpha_pead_events(id) on delete restrict,
  evidence_id uuid not null references public.event_alpha_pead_evidence(id) on delete restrict,
  signal_state text not null check (signal_state in ('POSITIVE_DRIFT','NEGATIVE_DRIFT','FULLY_PRICED','OVERREACTION','NO_TRADE')),
  direction text not null check (direction in ('LONG','SHORT','NEUTRAL')),
  eps_sue numeric not null,
  revenue_sue numeric not null,
  guidance_sue numeric,
  margin_sue numeric,
  composite_surprise numeric not null,
  immediate_car_bps numeric not null,
  total_car_bps numeric not null,
  expected_drift_bps numeric not null,
  remaining_drift_bps numeric not null,
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  reason_codes text[] not null default '{}'::text[],
  methodology_version text not null check (char_length(methodology_version) between 3 and 80),
  calculation_manifest jsonb not null check (jsonb_typeof(calculation_manifest) = 'object' and octet_length(calculation_manifest::text) <= 262144),
  calculated_at timestamptz not null default now(),
  unique (evidence_id, methodology_version)
);

create table if not exists public.event_alpha_pead_return_points (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.event_alpha_pead_signals(id) on delete restrict,
  point_index integer not null check (point_index >= 0 and point_index < 256),
  observed_at timestamptz not null,
  price numeric check (price is null or price > 0),
  stock_return_bps numeric not null,
  market_return_bps numeric not null,
  sector_return_bps numeric not null,
  abnormal_return_bps numeric not null,
  cumulative_abnormal_return_bps numeric not null,
  created_at timestamptz not null default now(),
  unique (signal_id, point_index),
  unique (signal_id, observed_at)
);

create index if not exists idx_event_alpha_pead_latest on public.event_alpha_pead_events(announced_at desc, id desc);
create index if not exists idx_event_alpha_pead_signal_rank on public.event_alpha_pead_signals(signal_state, confidence desc, abs(remaining_drift_bps) desc);
create index if not exists idx_event_alpha_pead_returns on public.event_alpha_pead_return_points(signal_id, point_index);

drop trigger if exists event_alpha_pead_evidence_immutable on public.event_alpha_pead_evidence;
create trigger event_alpha_pead_evidence_immutable before update or delete on public.event_alpha_pead_evidence
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_pead_signal_immutable on public.event_alpha_pead_signals;
create trigger event_alpha_pead_signal_immutable before update or delete on public.event_alpha_pead_signals
for each row execute function public.event_alpha_reject_immutable_mutation_v1();
drop trigger if exists event_alpha_pead_return_immutable on public.event_alpha_pead_return_points;
create trigger event_alpha_pead_return_immutable before update or delete on public.event_alpha_pead_return_points
for each row execute function public.event_alpha_reject_immutable_mutation_v1();

create or replace function public.event_alpha_ingest_pead_v1(
  p_provider_id uuid,
  p_assessment jsonb
)
returns table(pead_event_id uuid, evidence_id uuid, signal_id uuid, event_revision integer, was_duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  event_row public.event_alpha_pead_events;
  evidence_row public.event_alpha_pead_evidence;
  signal_row public.event_alpha_pead_signals;
  next_revision integer;
  evidence jsonb := p_assessment->'evidence';
  metrics jsonb := p_assessment->'metrics';
  signal jsonb := p_assessment->'signal';
  path jsonb := p_assessment->'returnPath';
begin
  if jsonb_typeof(p_assessment) <> 'object' or jsonb_typeof(evidence) <> 'object'
     or jsonb_typeof(metrics) <> 'object' or jsonb_typeof(signal) <> 'object'
     or jsonb_typeof(path) <> 'array' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PEAD_ASSESSMENT_INVALID';
  end if;
  if not exists(select 1 from public.event_alpha_pead_providers where id = p_provider_id and enabled = true) then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PEAD_PROVIDER_DISABLED';
  end if;
  if (evidence->>'expectationAsOf')::timestamptz >= (evidence->>'firstActionableAt')::timestamptz then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PEAD_EXPECTATION_LOOKAHEAD';
  end if;
  if p_assessment->>'methodologyVersion' <> 'BC_PEAD_CAUSAL_V1' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_PEAD_METHODOLOGY_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_assessment->>'canonicalKey', 0));
  select * into event_row from public.event_alpha_pead_events
   where canonical_key = p_assessment->>'canonicalKey' for update;

  if event_row.id is null then
    insert into public.event_alpha_pead_events(
      canonical_key,provider_id,provider_event_id,cik,ticker,issuer,fiscal_period,
      announced_at,first_actionable_at,expectation_as_of,announcement_session,status,
      current_revision,current_evidence_hash,source_confidence
    ) values (
      p_assessment->>'canonicalKey',p_provider_id,evidence->>'providerEventId',nullif(evidence->>'cik',''),
      evidence->>'ticker',evidence->>'issuer',evidence->>'fiscalPeriod',(evidence->>'announcedAt')::timestamptz,
      (evidence->>'firstActionableAt')::timestamptz,(evidence->>'expectationAsOf')::timestamptz,
      evidence->>'session','ASSESSED',1,p_assessment->>'evidenceHash',(evidence->>'sourceConfidence')::numeric
    ) returning * into event_row;
    next_revision := 1;
  elsif event_row.current_evidence_hash = p_assessment->>'evidenceHash' then
    select e.* into evidence_row from public.event_alpha_pead_evidence e
     where e.pead_event_id = event_row.id and e.evidence_hash = event_row.current_evidence_hash;
    select s.* into signal_row from public.event_alpha_pead_signals s where s.evidence_id = evidence_row.id;
    return query select event_row.id,evidence_row.id,signal_row.id,event_row.current_revision,true;
    return;
  else
    next_revision := event_row.current_revision + 1;
    update public.event_alpha_pead_events set
      current_revision=next_revision,current_evidence_hash=p_assessment->>'evidenceHash',
      source_confidence=(evidence->>'sourceConfidence')::numeric,expectation_as_of=(evidence->>'expectationAsOf')::timestamptz,
      first_actionable_at=(evidence->>'firstActionableAt')::timestamptz,status='ASSESSED',updated_at=pg_catalog.now()
    where id=event_row.id returning * into event_row;
  end if;

  insert into public.event_alpha_pead_evidence(
    pead_event_id,revision,evidence_hash,expectation_as_of,first_actionable_at,
    immutable_evidence,source_manifest,filing_url,consensus_source_url,price_source_url
  ) values (
    event_row.id,next_revision,p_assessment->>'evidenceHash',(evidence->>'expectationAsOf')::timestamptz,
    (evidence->>'firstActionableAt')::timestamptz,evidence,coalesce(evidence->'sourceManifest','{}'::jsonb),
    nullif(evidence->>'filingUrl',''),nullif(evidence->>'consensusSourceUrl',''),nullif(evidence->>'priceSourceUrl','')
  ) returning * into evidence_row;

  insert into public.event_alpha_pead_signals(
    pead_event_id,evidence_id,signal_state,direction,eps_sue,revenue_sue,guidance_sue,margin_sue,
    composite_surprise,immediate_car_bps,total_car_bps,expected_drift_bps,remaining_drift_bps,
    confidence,reason_codes,methodology_version,calculation_manifest
  ) values (
    event_row.id,evidence_row.id,signal->>'state',signal->>'direction',(metrics->>'epsSue')::numeric,
    (metrics->>'revenueSue')::numeric,nullif(metrics->>'guidanceSue','')::numeric,nullif(metrics->>'marginSue','')::numeric,
    (metrics->>'compositeSurprise')::numeric,(metrics->>'immediateCarBps')::numeric,(metrics->>'totalCarBps')::numeric,
    (metrics->>'expectedDriftBps')::numeric,(metrics->>'remainingDriftBps')::numeric,(metrics->>'confidence')::numeric,
    array(select jsonb_array_elements_text(coalesce(signal->'reasonCodes','[]'::jsonb))),
    p_assessment->>'methodologyVersion',jsonb_build_object('evidenceHash',p_assessment->>'evidenceHash','metrics',metrics)
  ) returning * into signal_row;

  insert into public.event_alpha_pead_return_points(
    signal_id,point_index,observed_at,price,stock_return_bps,market_return_bps,sector_return_bps,
    abnormal_return_bps,cumulative_abnormal_return_bps
  ) select signal_row.id,(ordinality-1)::integer,(row->>'observedAt')::timestamptz,
    nullif(row->>'price','')::numeric,(row->>'stockReturnBps')::numeric,(row->>'marketReturnBps')::numeric,
    (row->>'sectorReturnBps')::numeric,(row->>'abnormalReturnBps')::numeric,(row->>'cumulativeAbnormalReturnBps')::numeric
  from jsonb_array_elements(path) with ordinality as points(row,ordinality);

  return query select event_row.id,evidence_row.id,signal_row.id,next_revision,false;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_alpha_pead_providers','event_alpha_pead_events','event_alpha_pead_evidence',
    'event_alpha_pead_signals','event_alpha_pead_return_points'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update on table public.%I to service_role', table_name);
  end loop;
end $$;

revoke all on function public.event_alpha_ingest_pead_v1(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.event_alpha_ingest_pead_v1(uuid,jsonb) to service_role;

comment on table public.event_alpha_pead_evidence is 'Immutable point-in-time earnings actual, consensus and provenance evidence.';
comment on table public.event_alpha_pead_signals is 'Immutable factor-adjusted Post-Earnings Announcement Drift classification; never direct broker authority.';

commit;
