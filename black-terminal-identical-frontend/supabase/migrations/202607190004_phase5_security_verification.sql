begin;

do $$
declare
  required_table text;
  protected_table text;
  bytea_column_count integer;
begin
  foreach required_table in array array[
    'market_depth_memory','market_depth_snapshots','market_depth_deltas','market_depth_rollups',
    'market_depth_statistics','market_liquidity_walls','market_liquidity_events','market_depth_collector_status',
    'broker_connection_capabilities','broker_connection_health','broker_secret_references','broker_secret_vault',
    'execution_commands','execution_command_attempts','execution_audit_events','execution_incidents',
    'follower_execution_plans','group_execution_mandates','group_trade_intents','reconciliation_runs',
    'api_rate_limit_counters','ai_daily_usage','security_audit_events','execution_audit_archive'
  ] loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'Phase V verification failed: missing public.%', required_table;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='bt_users' and column_name='password'
  ) then
    raise exception 'Phase V verification failed: plaintext bt_users.password still exists';
  end if;

  if exists (select 1 from public.bt_users where auth_user_id is null) then
    raise exception 'Phase V verification failed: a bt_users profile is not linked to Supabase Auth';
  end if;

  foreach protected_table in array array['bt_users','bt_audit_logs','broker_secret_vault','security_audit_events','execution_audit_archive'] loop
    if not exists (select 1 from pg_class where oid=('public.' || protected_table)::regclass and relrowsecurity) then
      raise exception 'Phase V verification failed: RLS is disabled on public.%', protected_table;
    end if;
  end loop;

  if has_table_privilege('anon','public.bt_users','select') then
    raise exception 'Phase V verification failed: anon can still select bt_users';
  end if;
  if has_table_privilege('authenticated','public.broker_secret_vault','select') then
    raise exception 'Phase V verification failed: clients can select broker_secret_vault';
  end if;

  select count(*) into bytea_column_count
  from information_schema.columns
  where table_schema='public' and table_name='broker_secret_vault'
    and column_name in ('encrypted_secret','encryption_iv','authentication_tag')
    and data_type='bytea';
  if bytea_column_count <> 3 then
    raise exception 'Phase V verification failed: AES-GCM vault columns are incomplete';
  end if;

  if to_regprocedure('public.consume_api_rate_limit(text,uuid,text,integer,integer)') is null
    or to_regprocedure('public.consume_ai_daily_usage(uuid,date,integer)') is null
    or to_regprocedure('public.enforce_execution_audit_retention(integer)') is null then
    raise exception 'Phase V verification failed: a security RPC is missing';
  end if;
end
$$;

do $$
declare
  retention_result jsonb;
  pass integer := 0;
begin
  loop
    retention_result := public.enforce_execution_audit_retention(10000);
    pass := pass + 1;
    exit when coalesce((retention_result ->> 'archived')::integer,0)=0 or pass >= 20;
  end loop;
end
$$;

commit;
