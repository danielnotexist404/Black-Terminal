begin;

-- Event Alpha scheduled evidence is collected before the event becomes
-- actionable. The original bootstrap constraints accidentally rejected that
-- causal ordering. Keep source publication causal while allowing a future
-- event/effective timestamp to be known now.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conrelid::regclass as relation_name, conname
    from pg_catalog.pg_constraint
    where contype = 'c'
      and conrelid in (
        'public.event_alpha_raw_events'::regclass,
        'public.event_alpha_event_revisions'::regclass
      )
      and (
        pg_catalog.pg_get_constraintdef(oid) ilike '%first_actionable_at <= observed_at%'
        or pg_catalog.pg_get_constraintdef(oid) ilike '%effective_at <= known_at%'
      )
  loop
    execute pg_catalog.format('alter table %s drop constraint %I', constraint_row.relation_name, constraint_row.conname);
  end loop;
end;
$$;

alter table public.event_alpha_raw_events
  add constraint event_alpha_raw_actionable_horizon_v2
  check (first_actionable_at <= observed_at + interval '10 years');

alter table public.event_alpha_event_revisions
  add constraint event_alpha_revision_effective_horizon_v2
  check (effective_at <= known_at + interval '10 years');

create or replace function public.event_alpha_ingest_canonical_v2(
  p_source_id uuid,
  p_source_event_id text,
  p_event_family text,
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
  p_event_status text,
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
  source_family text;
  next_revision integer;
begin
  if p_event_family not in ('TOKEN_SUPPLY','GOVERNANCE','PROTOCOL_ECONOMICS') then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_EVENT_FAMILY_INVALID';
  end if;
  if p_event_status not in ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED','INVALIDATED') then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_EVENT_STATUS_INVALID';
  end if;
  if p_first_actionable_at > p_event_time then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_ACTIONABLE_AFTER_EVENT';
  end if;
  if p_observed_at > pg_catalog.now() + interval '30 seconds' then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_OBSERVED_AT_IN_FUTURE';
  end if;
  select event_family into source_family from public.event_alpha_sources where id = p_source_id and enabled = true;
  if source_family is null or source_family <> p_event_family then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_SOURCE_FAMILY_MISMATCH';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_canonical_key, 0));

  insert into public.event_alpha_raw_events(
    source_id, source_event_id, event_family, observed_at, first_actionable_at,
    source_published_at, payload_hash, payload, ingestion_metadata
  ) values (
    p_source_id, p_source_event_id, p_event_family, p_observed_at, p_first_actionable_at,
    p_source_published_at, p_payload_hash, p_payload, coalesce(p_ingestion_metadata, '{}'::jsonb)
  )
  on conflict (source_id, source_event_id, payload_hash) do nothing
  returning * into raw_row;

  if raw_row.id is null then
    select * into raw_row
    from public.event_alpha_raw_events
    where source_id = p_source_id and source_event_id = p_source_event_id and payload_hash = p_payload_hash;
  end if;

  select * into event_row
  from public.event_alpha_canonical_events
  where canonical_key = p_canonical_key
  for update;

  if event_row.id is null then
    insert into public.event_alpha_canonical_events(
      canonical_key, event_family, asset_id, symbol, event_time, first_actionable_at,
      status, current_revision, current_payload_hash, source_confidence,
      dedupe_fingerprint, safe_summary
    ) values (
      p_canonical_key, p_event_family, p_asset_id, p_symbol, p_event_time, p_first_actionable_at,
      p_event_status, 1, p_payload_hash, p_source_confidence,
      p_dedupe_fingerprint, p_safe_summary
    ) returning * into event_row;

    insert into public.event_alpha_event_revisions(
      canonical_event_id, raw_event_id, revision, effective_at, known_at,
      payload_hash, normalized_payload, changed_fields, reason_code
    ) values (
      event_row.id, raw_row.id, 1, p_event_time, p_observed_at,
      p_payload_hash, p_normalized_payload,
      array(select pg_catalog.jsonb_object_keys(p_normalized_payload)),
      'INITIAL_SOURCE_EVIDENCE'
    );

    insert into public.event_alpha_processing_jobs(
      job_type, canonical_event_id, raw_event_id, payload, status, available_at, idempotency_key
    ) values (
      'ASSESS', event_row.id, raw_row.id,
      pg_catalog.jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', 1),
      'QUEUED', greatest(pg_catalog.now(), p_event_time),
      'assess:' || event_row.id::text || ':1'
    ) on conflict (idempotency_key) do nothing;

    return query select raw_row.id, event_row.id, 1, false;
    return;
  end if;

  if event_row.event_family <> p_event_family or event_row.asset_id <> p_asset_id or event_row.symbol <> p_symbol then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_CANONICAL_IDENTITY_CONFLICT';
  end if;

  if event_row.current_payload_hash = p_payload_hash then
    insert into public.event_alpha_processing_jobs(
      job_type, canonical_event_id, raw_event_id, payload, status, available_at, idempotency_key
    ) values (
      'ASSESS', event_row.id, raw_row.id,
      pg_catalog.jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', event_row.current_revision),
      'QUEUED', greatest(pg_catalog.now(), p_event_time),
      'assess:' || event_row.id::text || ':' || event_row.current_revision::text
    ) on conflict (idempotency_key) do nothing;
    return query select raw_row.id, event_row.id, event_row.current_revision, true;
    return;
  end if;

  next_revision := event_row.current_revision + 1;
  insert into public.event_alpha_event_revisions(
    canonical_event_id, raw_event_id, revision, effective_at, known_at,
    payload_hash, normalized_payload, changed_fields, reason_code
  ) values (
    event_row.id, raw_row.id, next_revision, p_event_time, p_observed_at,
    p_payload_hash, p_normalized_payload, array['SOURCE_REVISION'], 'MATERIAL_SOURCE_REVISION'
  );

  update public.event_alpha_canonical_events
  set event_time = p_event_time,
      first_actionable_at = least(first_actionable_at, p_first_actionable_at),
      status = p_event_status,
      current_revision = next_revision,
      current_payload_hash = p_payload_hash,
      source_confidence = p_source_confidence,
      dedupe_fingerprint = p_dedupe_fingerprint,
      safe_summary = p_safe_summary,
      updated_at = pg_catalog.now()
  where id = event_row.id
  returning * into event_row;

  insert into public.event_alpha_processing_jobs(
    job_type, canonical_event_id, raw_event_id, payload, status, available_at, idempotency_key
  ) values (
    'ASSESS', event_row.id, raw_row.id,
    pg_catalog.jsonb_build_object('canonicalEventId', event_row.id, 'eventRevision', next_revision),
    'QUEUED', greatest(pg_catalog.now(), p_event_time),
    'assess:' || event_row.id::text || ':' || next_revision::text
  ) on conflict (idempotency_key) do nothing;

  return query select raw_row.id, event_row.id, next_revision, false;
end;
$$;

revoke all on function public.event_alpha_ingest_canonical_v2(
  uuid,text,text,timestamptz,timestamptz,timestamptz,text,jsonb,jsonb,
  text,text,text,timestamptz,text,numeric,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.event_alpha_ingest_canonical_v2(
  uuid,text,text,timestamptz,timestamptz,timestamptz,text,jsonb,jsonb,
  text,text,text,timestamptz,text,numeric,text,text,jsonb
) to service_role;

create or replace function public.event_alpha_persist_live_assessment_v1(
  p_canonical_event_id uuid,
  p_event_revision integer,
  p_expectation_snapshot_id uuid,
  p_asset_profile jsonb,
  p_surprise jsonb,
  p_forecast jsonb,
  p_thesis jsonb
)
returns table(surprise_assessment_id uuid, response_forecast_id uuid, thesis_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  event_row public.event_alpha_canonical_events;
  expectation_row public.event_alpha_expectation_snapshots;
  surprise_row public.event_alpha_surprise_assessments;
  forecast_row public.event_alpha_response_forecasts;
  thesis_row public.event_alpha_theses;
  next_profile_version integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('assessment:' || p_canonical_event_id::text || ':' || p_event_revision::text, 0));

  select * into event_row from public.event_alpha_canonical_events where id = p_canonical_event_id;
  select * into expectation_row from public.event_alpha_expectation_snapshots where id = p_expectation_snapshot_id;
  if event_row.id is null or event_row.current_revision < p_event_revision then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_ASSESSMENT_EVENT_INVALID';
  end if;
  if expectation_row.id is null or expectation_row.canonical_event_id <> event_row.id
     or expectation_row.as_of >= event_row.first_actionable_at then
    raise exception using errcode = '22023', message = 'EVENT_ALPHA_ASSESSMENT_EXPECTATION_NONCAUSAL';
  end if;

  if not exists (
    select 1 from public.event_alpha_asset_profiles
    where asset_id = p_asset_profile->>'assetId'
      and known_at = (p_asset_profile->>'knownAt')::timestamptz
  ) then
    select coalesce(max(profile_version), 0) + 1 into next_profile_version
    from public.event_alpha_asset_profiles where asset_id = p_asset_profile->>'assetId';
    insert into public.event_alpha_asset_profiles(
      asset_id, profile_version, effective_from, known_at, circulating_supply,
      average_daily_dollar_volume, float_adjustment, liquid_supply_ratio,
      value_capture_score, benchmark_symbol, source_manifest
    ) values (
      p_asset_profile->>'assetId', next_profile_version,
      (p_asset_profile->>'effectiveFrom')::timestamptz,
      (p_asset_profile->>'knownAt')::timestamptz,
      nullif(p_asset_profile->>'circulatingSupply','')::numeric,
      nullif(p_asset_profile->>'averageDailyDollarVolume','')::numeric,
      coalesce(nullif(p_asset_profile->>'floatAdjustment','')::numeric, 1),
      nullif(p_asset_profile->>'liquidSupplyRatio','')::numeric,
      nullif(p_asset_profile->>'valueCaptureScore','')::numeric,
      p_asset_profile->>'benchmarkSymbol',
      coalesce(p_asset_profile->'sourceManifest', '{}'::jsonb)
    );
  end if;

  select * into surprise_row from public.event_alpha_surprise_assessments
  where canonical_event_id = p_canonical_event_id
    and event_revision = p_event_revision
    and expectation_snapshot_id = p_expectation_snapshot_id;
  if surprise_row.id is null then
    insert into public.event_alpha_surprise_assessments(
      canonical_event_id, event_revision, expectation_snapshot_id, assessed_at,
      quantity_surprise, timing_surprise, probability_surprise, structural_surprise,
      composite_surprise, confidence, economic_impact, reason_codes, calculation_manifest
    ) values (
      p_canonical_event_id, p_event_revision, p_expectation_snapshot_id,
      (p_surprise->>'assessedAt')::timestamptz,
      nullif(p_surprise->>'quantitySurprise','')::numeric,
      nullif(p_surprise->>'timingSurprise','')::numeric,
      nullif(p_surprise->>'probabilitySurprise','')::numeric,
      nullif(p_surprise->>'structuralSurprise','')::numeric,
      (p_surprise->>'compositeSurprise')::numeric,
      (p_surprise->>'confidence')::numeric,
      p_surprise->'economicImpact',
      array(select pg_catalog.jsonb_array_elements_text(coalesce(p_surprise->'reasonCodes', '[]'::jsonb))),
      p_surprise->'calculationManifest'
    ) returning * into surprise_row;
  end if;

  select f.* into forecast_row from public.event_alpha_response_forecasts f
  where f.surprise_assessment_id = surprise_row.id
    and f.horizon_seconds = (p_forecast->>'horizonSeconds')::integer
    and f.price_cutoff_at = (p_forecast->>'priceCutoffAt')::timestamptz;
  if forecast_row.id is null then
    insert into public.event_alpha_response_forecasts(
      surprise_assessment_id, horizon_seconds, benchmark_symbol,
      expected_abnormal_return_bps, realized_abnormal_return_bps,
      estimated_round_trip_cost_bps, uncertainty_penalty_bps,
      remaining_alpha_bps, outcome, confidence, price_cutoff_at, calculation_manifest
    ) values (
      surprise_row.id, (p_forecast->>'horizonSeconds')::integer,
      p_forecast->>'benchmarkSymbol',
      (p_forecast->>'expectedAbnormalReturnBps')::numeric,
      (p_forecast->>'realizedAbnormalReturnBps')::numeric,
      (p_forecast->>'estimatedRoundTripCostBps')::numeric,
      (p_forecast->>'uncertaintyPenaltyBps')::numeric,
      (p_forecast->>'remainingAlphaBps')::numeric,
      p_forecast->>'outcome', (p_forecast->>'confidence')::numeric,
      (p_forecast->>'priceCutoffAt')::timestamptz,
      p_forecast->'calculationManifest'
    ) returning * into forecast_row;
  end if;

  select t.* into thesis_row from public.event_alpha_theses t where t.thesis_key = p_thesis->>'thesisKey';
  if thesis_row.id is null then
    insert into public.event_alpha_theses(
      canonical_event_id, response_forecast_id, thesis_key, state, direction,
      event_family, confidence, remaining_alpha_bps, valid_from, expires_at,
      reason_codes, invalidation_conditions
    ) values (
      p_canonical_event_id, forecast_row.id, p_thesis->>'thesisKey',
      p_thesis->>'state', p_thesis->>'direction', event_row.event_family,
      (p_thesis->>'confidence')::numeric, (p_thesis->>'remainingAlphaBps')::numeric,
      (p_thesis->>'validFrom')::timestamptz, (p_thesis->>'expiresAt')::timestamptz,
      array(select pg_catalog.jsonb_array_elements_text(coalesce(p_thesis->'reasonCodes', '[]'::jsonb))),
      coalesce(p_thesis->'invalidationConditions', '[]'::jsonb)
    ) returning * into thesis_row;
  end if;

  return query select surprise_row.id, forecast_row.id, thesis_row.id;
end;
$$;

revoke all on function public.event_alpha_persist_live_assessment_v1(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.event_alpha_persist_live_assessment_v1(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb)
  to service_role;

commit;
