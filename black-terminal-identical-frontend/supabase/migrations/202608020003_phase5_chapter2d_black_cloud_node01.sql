-- Phase V, Chapter II-D: persistent Black Cloud node identity, heartbeat state,
-- and redacted external-certification evidence. No broker secret material is
-- accepted by either table.
begin;

create table if not exists public.black_cloud_nodes (
  node_id text primary key,
  deployment_environment text not null default 'PRODUCTION',
  region text not null,
  hostname text not null,
  deployment_commit text not null,
  image_digest text not null,
  software_version text not null,
  node_version text not null,
  worker_instance_id text not null,
  execution_environment text not null,
  status text not null default 'STARTING',
  startup_phase text not null default 'PROCESS_STARTING',
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null default now(),
  clock_health jsonb not null default '{}'::jsonb,
  crypto_self_test jsonb not null default '{}'::jsonb,
  active_connection_count integer not null default 0,
  ready_connection_count integer not null default 0,
  degraded_connection_count integer not null default 0,
  active_strategy_count integer not null default 0,
  queue_depth integer not null default 0,
  oldest_queue_age_ms bigint not null default 0,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint black_cloud_nodes_node_id_check check (node_id ~ '^BLACK_CLOUD_NODE_[0-9]{2}$'),
  constraint black_cloud_nodes_deployment_environment_check check (deployment_environment = 'PRODUCTION'),
  constraint black_cloud_nodes_execution_environment_check check (execution_environment in ('DEMO','MAINNET_LIVE')),
  constraint black_cloud_nodes_status_check check (status in ('STARTING','READY','DEGRADED','DRAINING','OFFLINE')),
  constraint black_cloud_nodes_commit_check check (deployment_commit ~ '^[a-fA-F0-9]{7,40}$'),
  constraint black_cloud_nodes_digest_check check (image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  constraint black_cloud_nodes_nonnegative_metrics check (
    active_connection_count >= 0 and ready_connection_count >= 0 and
    degraded_connection_count >= 0 and active_strategy_count >= 0 and
    queue_depth >= 0 and oldest_queue_age_ms >= 0
  ),
  constraint black_cloud_nodes_json_objects check (
    jsonb_typeof(clock_health) = 'object' and jsonb_typeof(crypto_self_test) = 'object' and jsonb_typeof(safe_metadata) = 'object'
  )
);

create index if not exists idx_black_cloud_nodes_health
  on public.black_cloud_nodes(status,last_heartbeat_at desc);

drop trigger if exists trg_black_cloud_nodes_updated_at on public.black_cloud_nodes;
create trigger trg_black_cloud_nodes_updated_at before update on public.black_cloud_nodes
  for each row execute function public.black_cloud_set_updated_at();

create table if not exists public.black_cloud_certification_records (
  id uuid primary key default gen_random_uuid(),
  certification_environment text not null check (certification_environment in ('DEMO','MAINNET_LIVE')),
  node_id text not null references public.black_cloud_nodes(node_id) on delete restrict,
  worker_instance_id text not null,
  deployment_commit text not null check (deployment_commit ~ '^[a-fA-F0-9]{7,40}$'),
  image_digest text not null check (image_digest ~ '^sha256:[a-fA-F0-9]{64}$'),
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  account_reference_hash text,
  permission_snapshot jsonb not null default '{}'::jsonb,
  mandate_id uuid references public.broker_automation_mandates(id) on delete set null,
  risk_policy_id uuid references public.broker_risk_policy_versions(id) on delete set null,
  certification_state text not null default 'INFRASTRUCTURE_READY',
  evidence jsonb not null default '{}'::jsonb,
  final_account_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint black_cloud_certification_json_objects check (
    jsonb_typeof(permission_snapshot) = 'object' and jsonb_typeof(evidence) = 'object' and jsonb_typeof(final_account_state) = 'object'
  ),
  constraint black_cloud_certification_state_check check (certification_state in (
    'INFRASTRUCTURE_READY','MANUAL_EXECUTION_VERIFIED','PRIVATE_EVENTS_VERIFIED',
    'PROTECTION_VERIFIED','BROWSER_OFFLINE_VERIFIED','RESTART_RECOVERY_VERIFIED','FULLY_ACTIVATED','FAILED'
  ))
);

create index if not exists idx_black_cloud_certification_records_node
  on public.black_cloud_certification_records(node_id,created_at desc);
create index if not exists idx_black_cloud_certification_records_connection
  on public.black_cloud_certification_records(connection_id,created_at desc)
  where connection_id is not null;

alter table public.black_cloud_nodes enable row level security;
alter table public.black_cloud_certification_records enable row level security;

revoke all on public.black_cloud_nodes from public,anon,authenticated;
revoke all on public.black_cloud_certification_records from public,anon,authenticated;
grant select,insert,update on public.black_cloud_nodes to service_role;
grant select,insert on public.black_cloud_certification_records to service_role;

drop trigger if exists trg_black_cloud_certification_records_immutable on public.black_cloud_certification_records;
create trigger trg_black_cloud_certification_records_immutable
  before update or delete on public.black_cloud_certification_records
  for each row execute function public.black_cloud_prevent_immutable_change();

commit;
