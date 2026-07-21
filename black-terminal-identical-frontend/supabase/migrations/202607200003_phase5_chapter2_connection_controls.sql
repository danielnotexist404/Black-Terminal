-- Phase V, Chapter II: persistent broker lifecycle and emergency controls.
begin;

alter table public.connectivity_connections
  add column if not exists lifecycle_status text not null default 'CREATED',
  add column if not exists control_state text not null default 'ACTIVE',
  add column if not exists paused_at timestamptz,
  add column if not exists emergency_stopped_at timestamptz,
  add column if not exists emergency_stop_reason text;

alter table public.connectivity_connections
  drop constraint if exists connectivity_connections_lifecycle_status_check,
  add constraint connectivity_connections_lifecycle_status_check
    check (lifecycle_status in ('CREATED','VALIDATING','CONNECTED','HEALTHY','DEGRADED','RECONNECTING','FAILED','REVOKED')),
  drop constraint if exists connectivity_connections_control_state_check,
  add constraint connectivity_connections_control_state_check
    check (control_state in ('ACTIVE','PAUSED','EMERGENCY_STOP')),
  drop constraint if exists connectivity_connections_emergency_reason_size,
  add constraint connectivity_connections_emergency_reason_size
    check (emergency_stop_reason is null or length(emergency_stop_reason) <= 200);

update public.connectivity_connections set lifecycle_status = case
  when revoked_at is not null or health_status = 'REVOKED' then 'REVOKED'
  when health_status in ('CONNECTED_CLOUD','CONNECTED_HYBRID','CONNECTED_LOCAL') then 'HEALTHY'
  when health_status = 'DEGRADED' then 'DEGRADED'
  when health_status = 'RECONCILING' then 'RECONNECTING'
  when health_status in ('ERROR','AUTH_EXPIRED') then 'FAILED'
  else 'CREATED'
end;

create index if not exists idx_connectivity_connections_worker_control
  on public.connectivity_connections(connection_mode, control_state, lifecycle_status)
  where revoked_at is null and disabled_at is null;

commit;
