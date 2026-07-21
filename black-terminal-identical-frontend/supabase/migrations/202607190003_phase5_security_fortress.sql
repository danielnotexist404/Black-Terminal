begin;

create extension if not exists pgcrypto;

-- Supabase Auth is the only password authority. Public profiles reference auth.users.
alter table public.bt_users
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists product_tier text not null default 'retail',
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.bt_users alter column allowed_indicators set default array['orderBookHeatmap','liquidationHeatmap','volatilityHeatmap','adaptiveSwingStrategy','vwap','ema20','ema50','ema200','sma20','sma50','bollinger','openInterestOscillator','zScoreOscillator','waveTrendOscillator','volume']::text[];

update public.bt_users profile
set auth_user_id = identity.id,
    email_verified = coalesce(identity.email_confirmed_at is not null, false)
from auth.users identity
where lower(profile.email) = lower(identity.email)
  and profile.auth_user_id is null;

create unique index if not exists idx_bt_users_auth_user_id on public.bt_users(auth_user_id) where auth_user_id is not null;
alter table public.bt_users drop column if exists password;
alter table public.bt_users enable row level security;

revoke all on public.bt_users from anon;
revoke insert, update, delete on public.bt_users from authenticated;
grant select on public.bt_users to authenticated;
grant insert (username,email,role,status,auth_user_id,display_name,first_name,last_name,organization,billing_address,purpose_of_use,phone,newsletter_opt_in,referred_by,email_verified) on public.bt_users to authenticated;
grant update (display_name,last_login,active_indicators,workspaces,workspace_snapshots,active_workspace,alerts,scripts,alert_event_logs,first_name,last_name,organization,billing_address,purpose_of_use,phone,newsletter_opt_in,referred_by,email_verified,ai_messages_count,ai_last_message_timestamp) on public.bt_users to authenticated;

create or replace function public.is_black_terminal_admin()
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.bt_users where auth_user_id=auth.uid() and role='admin' and status <> 'suspended') $$;
revoke all on function public.is_black_terminal_admin() from public;
grant execute on function public.is_black_terminal_admin() to authenticated,service_role;

drop policy if exists bt_users_select_own_or_admin on public.bt_users;
create policy bt_users_select_own_or_admin on public.bt_users for select to authenticated
using (auth.uid() = auth_user_id or public.is_black_terminal_admin());
drop policy if exists bt_users_insert_own on public.bt_users;
create policy bt_users_insert_own on public.bt_users for insert to authenticated
with check (auth.uid() = auth_user_id and role = 'user' and product_tier = 'retail' and permissions = '[]'::jsonb);
drop policy if exists bt_users_update_own on public.bt_users;
create policy bt_users_update_own on public.bt_users for update to authenticated
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

create or replace function public.black_terminal_create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text;
begin
  desired_username := lower(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1), 'user'), '[^a-zA-Z0-9_-]', '', 'g'));
  if length(desired_username) < 3 then desired_username := 'user_' || substr(new.id::text, 1, 8); end if;
  if exists (select 1 from public.bt_users where username = desired_username and auth_user_id is distinct from new.id) then
    desired_username := left(desired_username, 48) || '_' || substr(new.id::text, 1, 6);
  end if;
  insert into public.bt_users (username,email,role,status,auth_user_id,display_name,email_verified,product_tier,permissions)
  values (desired_username,new.email,'user','offline',new.id,coalesce(new.raw_user_meta_data ->> 'display_name',desired_username),new.email_confirmed_at is not null,'retail','[]'::jsonb)
  on conflict (username) do update set auth_user_id=excluded.auth_user_id,email=excluded.email,email_verified=excluded.email_verified;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_black_terminal on auth.users;
create trigger on_auth_user_created_black_terminal
after insert or update of email_confirmed_at on auth.users
for each row execute function public.black_terminal_create_profile();

-- Persistent per-IP/per-user/endpoint rate limiting for serverless APIs.
create table if not exists public.api_rate_limit_counters (
  endpoint text not null,
  subject_key text not null,
  window_kind text not null check (window_kind in ('minute','day')),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (endpoint,subject_key,window_kind,window_start)
);
alter table public.api_rate_limit_counters enable row level security;
revoke all on public.api_rate_limit_counters from anon, authenticated;

create or replace function public.consume_api_rate_limit(
  p_endpoint text,
  p_user_id uuid,
  p_ip_hash text,
  p_minute_limit integer,
  p_daily_limit integer
) returns table(allowed boolean, minute_count integer, daily_count integer)
language plpgsql security definer set search_path=public
as $$
declare
  v_subject text := coalesce(p_user_id::text, 'ip:' || p_ip_hash);
  v_minute timestamptz := date_trunc('minute', now());
  v_day timestamptz := date_trunc('day', now());
begin
  insert into public.api_rate_limit_counters(endpoint,subject_key,window_kind,window_start,request_count)
  values (left(p_endpoint,160),v_subject,'minute',v_minute,1)
  on conflict (endpoint,subject_key,window_kind,window_start) do update set request_count=api_rate_limit_counters.request_count+1,updated_at=now()
  returning request_count into minute_count;
  insert into public.api_rate_limit_counters(endpoint,subject_key,window_kind,window_start,request_count)
  values (left(p_endpoint,160),v_subject,'day',v_day,1)
  on conflict (endpoint,subject_key,window_kind,window_start) do update set request_count=api_rate_limit_counters.request_count+1,updated_at=now()
  returning request_count into daily_count;
  allowed := minute_count <= greatest(1,p_minute_limit) and daily_count <= greatest(1,p_daily_limit);
  if mod(daily_count,100) = 1 then delete from public.api_rate_limit_counters where window_start < now()-interval '2 days'; end if;
  return next;
end;
$$;
revoke all on function public.consume_api_rate_limit(text,uuid,text,integer,integer) from public;
grant execute on function public.consume_api_rate_limit(text,uuid,text,integer,integer) to service_role;

create table if not exists public.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,usage_day)
);
alter table public.ai_daily_usage enable row level security;
revoke all on public.ai_daily_usage from anon, authenticated;
create or replace function public.consume_ai_daily_usage(p_user_id uuid,p_usage_day date,p_daily_limit integer)
returns table(allowed boolean,current_count integer)
language plpgsql security definer set search_path=public
as $$
begin
  insert into public.ai_daily_usage(user_id,usage_day,request_count) values(p_user_id,p_usage_day,1)
  on conflict(user_id,usage_day) do update set request_count=ai_daily_usage.request_count+1,updated_at=now()
  returning ai_daily_usage.request_count into current_count;
  allowed := current_count <= greatest(1,p_daily_limit);
  return next;
end;
$$;
revoke all on function public.consume_ai_daily_usage(uuid,date,integer) from public;
grant execute on function public.consume_ai_daily_usage(uuid,date,integer) to service_role;

-- Security audit events contain only classified, non-secret metadata.
create table if not exists public.security_audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  severity text not null check (severity in ('INFO','WARNING','ERROR','CRITICAL')),
  endpoint text,
  ip_hash text,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_security_audit_events_user_time on public.security_audit_events(user_id,created_at desc);
create index if not exists idx_security_audit_events_type_time on public.security_audit_events(event_type,created_at desc);
alter table public.security_audit_events enable row level security;
revoke all on public.security_audit_events from anon, authenticated;

alter table public.bt_audit_logs enable row level security;
revoke all on public.bt_audit_logs from anon, authenticated;
revoke all on sequence public.bt_audit_logs_id_seq from anon, authenticated;

-- AES-256-GCM ciphertext only. Wrapping keys remain in server/KMS environment.
create table if not exists public.broker_secret_vault (
  id uuid primary key default gen_random_uuid(),
  secret_reference_id uuid not null unique default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  provider text not null,
  encrypted_secret bytea not null,
  encryption_iv bytea not null,
  authentication_tag bytea not null,
  encryption_version integer not null default 1,
  rotation_status text not null default 'ACTIVE' check (rotation_status in ('ACTIVE','ROTATION_PENDING','ROTATED','REVOKED','FAILED')),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists idx_broker_secret_vault_active_connection on public.broker_secret_vault(connection_id) where rotation_status='ACTIVE';
alter table public.broker_secret_vault enable row level security;
revoke all on public.broker_secret_vault from anon, authenticated;

-- Hot 90d / archive 1y lifecycle for the existing high-churn execution ledger.
create table if not exists public.execution_audit_archive (like public.execution_audit_logs including defaults including constraints including indexes);
alter table public.execution_audit_archive add column if not exists archived_at timestamptz not null default now();
alter table public.execution_audit_archive enable row level security;
revoke all on public.execution_audit_archive from anon, authenticated;

create or replace function public.enforce_execution_audit_retention(p_batch_size integer default 5000)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare v_archived integer := 0; v_deleted integer := 0;
begin
  with candidates as (select id from public.execution_audit_logs where created_at < now()-interval '90 days' order by created_at limit greatest(1,least(p_batch_size,10000))),
  moved as (delete from public.execution_audit_logs source using candidates where source.id=candidates.id returning source.*)
  insert into public.execution_audit_archive select moved.*,now() from moved;
  get diagnostics v_archived = row_count;
  delete from public.execution_audit_archive where created_at < now()-interval '1 year';
  get diagnostics v_deleted = row_count;
  delete from public.security_audit_events where created_at < now()-interval '1 year';
  return jsonb_build_object('archived',v_archived,'coldDeleted',v_deleted);
end;
$$;
revoke all on function public.enforce_execution_audit_retention(integer) from public;
grant execute on function public.enforce_execution_audit_retention(integer) to service_role;

create or replace function public.trigger_execution_audit_retention()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
  if mod(abs(hashtextextended(new.id::text,0)::numeric),1000)=0 then perform public.enforce_execution_audit_retention(1000); end if;
  return new;
end $$;
drop trigger if exists trg_execution_audit_retention on public.execution_audit_logs;
create trigger trg_execution_audit_retention after insert on public.execution_audit_logs for each row execute function public.trigger_execution_audit_retention();

commit;
