-- BC-RDA emergency signal-integrity containment.
-- Preserves research data while preventing repainting or uncertified causal
-- output from entering paper, demo, group, or live strategy execution.
begin;

create or replace function public.black_core_definition_is_bcrda(p_definition jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path=public
as $$
  select lower(coalesce(p_definition::text,'')) like any(array[
    '%black-core-dda-pro%',
    '%bc-rda%',
    '%risk distribution analysis%',
    '%ddapro%'
  ]);
$$;

alter table public.strategy_automation_strategies
  add column if not exists signal_integrity_status text not null default 'NOT_APPLICABLE',
  add column if not exists performance_statistics_status text not null default 'VALID';

do $$ begin
  if not exists(select 1 from pg_constraint where conname='strategy_signal_integrity_status_check') then
    alter table public.strategy_automation_strategies add constraint strategy_signal_integrity_status_check
      check(signal_integrity_status in ('NOT_APPLICABLE','BLOCKED_LEGACY_REPAINTING','SOURCE_CERTIFIED_AUTOMATION_BLOCKED','CERTIFIED'));
  end if;
  if not exists(select 1 from pg_constraint where conname='strategy_performance_statistics_status_check') then
    alter table public.strategy_automation_strategies add constraint strategy_performance_statistics_status_check
      check(performance_statistics_status in ('VALID','INVALIDATED_REPAINTING_SOURCE','CAUSAL_MODEL_ONLY'));
  end if;
end $$;

create temporary table bcrda_contained_strategies on commit drop as
select distinct s.id,s.owner_user_id,
  case when lower(coalesce(s.definition::text,'') || coalesce(s.draft_definition::text,'')) like '%bc_rda_causal_v2%'
    then 'SOURCE_CERTIFIED_AUTOMATION_BLOCKED' else 'BLOCKED_LEGACY_REPAINTING' end as integrity_status,
  case when lower(coalesce(s.definition::text,'') || coalesce(s.draft_definition::text,'')) like '%bc_rda_causal_v2%'
    then 'CAUSAL_MODEL_ONLY' else 'INVALIDATED_REPAINTING_SOURCE' end as statistics_status
from public.strategy_automation_strategies s
where public.black_core_definition_is_bcrda(s.definition)
   or public.black_core_definition_is_bcrda(s.draft_definition)
   or exists(
     select 1 from public.strategy_automation_versions v
     where v.strategy_id=s.id and public.black_core_definition_is_bcrda(v.definition)
   );

update public.strategy_target_bindings b
set status='PAUSED',paused_at=coalesce(paused_at,now()),row_version=row_version+1
from bcrda_contained_strategies c
where b.strategy_id=c.id and b.status in ('PENDING','READY','LIVE','DEGRADED','RISK_SUSPENDED');

update public.strategy_paper_accounts p
set status='PAUSED',updated_at=now(),state_version=state_version+1
from bcrda_contained_strategies c
where p.strategy_id=c.id and p.status='ACTIVE';

update public.strategy_automation_runtime_state r
set runtime_state='DEGRADED',safe_error_code='BC_RDA_SIGNAL_INTEGRITY_BLOCKED',
    lease_owner=null,lease_expires_at=null,state_version=state_version+1,updated_at=now()
from bcrda_contained_strategies c
where r.strategy_id=c.id;

update public.strategy_automation_strategies s
set status='PAUSED',signal_integrity_status=c.integrity_status,
    performance_statistics_status=c.statistics_status,updated_at=now()
from bcrda_contained_strategies c
where s.id=c.id;

insert into public.strategy_automation_audit_events(
  owner_user_id,strategy_id,event_type,severity,message,safe_metadata
)
select c.owner_user_id,c.id,'BC_RDA_SIGNAL_INTEGRITY_CONTAINED','CRITICAL',
  'BC-RDA execution was paused because the legacy model repaints and Causal V2 is not automation-certified.',
  jsonb_build_object('signalIntegrityStatus',c.integrity_status,'statisticsStatus',c.statistics_status,'ordersMutated',false)
from bcrda_contained_strategies c
where not exists(
  select 1 from public.strategy_automation_audit_events a
  where a.strategy_id=c.id and a.event_type='BC_RDA_SIGNAL_INTEGRITY_CONTAINED'
);

create or replace function public.black_core_guard_bcrda_strategy_activation()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if public.black_core_definition_is_bcrda(new.definition)
     or public.black_core_definition_is_bcrda(new.draft_definition) then
    if new.status in ('PAPER_ACTIVE','LIVE_READY','LIVE_ACTIVE') then
      raise exception 'BC_RDA_SIGNAL_INTEGRITY_BLOCKED' using errcode='55000';
    end if;
    new.signal_integrity_status := case
      when lower(coalesce(new.definition::text,'') || coalesce(new.draft_definition::text,'')) like '%bc_rda_causal_v2%'
      then 'SOURCE_CERTIFIED_AUTOMATION_BLOCKED' else 'BLOCKED_LEGACY_REPAINTING' end;
    new.performance_statistics_status := case
      when new.signal_integrity_status='SOURCE_CERTIFIED_AUTOMATION_BLOCKED' then 'CAUSAL_MODEL_ONLY'
      else 'INVALIDATED_REPAINTING_SOURCE' end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_bcrda_strategy_activation on public.strategy_automation_strategies;
create trigger trg_guard_bcrda_strategy_activation
before insert or update of status,definition,draft_definition on public.strategy_automation_strategies
for each row execute function public.black_core_guard_bcrda_strategy_activation();

create or replace function public.black_core_guard_bcrda_runtime_activation()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if (tg_table_name='strategy_paper_accounts' and new.status='ACTIVE')
     or (tg_table_name='strategy_target_bindings' and new.status in ('READY','LIVE')) then
    if exists(
      select 1 from public.strategy_automation_strategies s
      where s.id=new.strategy_id and (
        public.black_core_definition_is_bcrda(s.definition)
        or public.black_core_definition_is_bcrda(s.draft_definition)
        or exists(select 1 from public.strategy_automation_versions v where v.strategy_id=s.id and public.black_core_definition_is_bcrda(v.definition))
      )
    ) then
      raise exception 'BC_RDA_SIGNAL_INTEGRITY_BLOCKED' using errcode='55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_bcrda_paper_activation on public.strategy_paper_accounts;
create trigger trg_guard_bcrda_paper_activation
before insert or update of status on public.strategy_paper_accounts
for each row execute function public.black_core_guard_bcrda_runtime_activation();

drop trigger if exists trg_guard_bcrda_target_activation on public.strategy_target_bindings;
create trigger trg_guard_bcrda_target_activation
before insert or update of status on public.strategy_target_bindings
for each row execute function public.black_core_guard_bcrda_runtime_activation();

revoke all on function public.black_core_definition_is_bcrda(jsonb) from public,anon,authenticated;
revoke all on function public.black_core_guard_bcrda_strategy_activation() from public,anon,authenticated;
revoke all on function public.black_core_guard_bcrda_runtime_activation() from public,anon,authenticated;
grant execute on function public.black_core_definition_is_bcrda(jsonb) to service_role;

commit;
