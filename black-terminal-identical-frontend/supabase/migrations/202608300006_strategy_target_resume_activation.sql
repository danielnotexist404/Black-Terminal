begin;

-- A target that has already been armed resumes directly to LIVE. Keep the
-- parent strategy in the evaluator's active set at the same atomic boundary;
-- otherwise the UI can show a LIVE target while the VPS evaluator continues
-- to skip its PAPER_PAUSED parent strategy.
create or replace function public.black_core_control_strategy_target(
  p_owner_user_id uuid,p_strategy_id uuid,p_binding_id uuid,p_expected_row_version integer,
  p_action text,p_validation_snapshot jsonb,p_disconnect_policy text,p_request_hash text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_status text;
  event_name text;
  now_at timestamptz:=now();
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  if p_action='ARM' then
    if binding.target_type not in ('BROKER_ACCOUNT','INVESTMENT_GROUP') or binding.status<>'READY' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    if binding.strategy_allocation_value<=0 or binding.trade_amount_value<=0 or binding.maximum_position_percent<=0 or binding.maximum_exposure_percent<=0 or binding.maximum_daily_loss<=0 or binding.maximum_drawdown<=0 then raise exception 'strategy target risk policy is not armed' using errcode='55000'; end if;
    next_status:='LIVE';
    event_name:=case when binding.target_type='INVESTMENT_GROUP' then 'STRATEGY_GROUP_TARGET_ARMED' else 'STRATEGY_BROKER_TARGET_ARMED' end;
    update public.strategy_target_bindings set status=next_status,armed_at=now_at,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
    update public.strategy_automation_strategies set status='LIVE_ACTIVE',updated_at=now_at where id=p_strategy_id and owner_user_id=p_owner_user_id;
  elsif p_action='PAUSE' then
    if binding.status not in ('READY','LIVE','DEGRADED','RISK_SUSPENDED') then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    next_status:='PAUSED';event_name:='STRATEGY_TARGET_PAUSED';
    update public.strategy_target_bindings set status=next_status,paused_at=now_at,row_version=row_version+1 where id=binding.id;
  elsif p_action='RESUME' then
    if binding.status<>'PAUSED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    next_status:=case when binding.armed_at is null then 'READY' else 'LIVE' end;event_name:='STRATEGY_TARGET_RESUMED';
    update public.strategy_target_bindings set status=next_status,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
    if next_status='LIVE' then
      update public.strategy_automation_strategies set status='LIVE_ACTIVE',updated_at=now_at where id=p_strategy_id and owner_user_id=p_owner_user_id;
    end if;
  elsif p_action='DISCONNECT' then
    if binding.status='DISCONNECTED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if p_disconnect_policy not in ('DETACH_MANUAL','CLOSE_STRATEGY_POSITIONS','KEEP_PROTECTED','DISCONNECT_WHEN_FLAT') then raise exception 'invalid disconnect policy' using errcode='22023'; end if;
    next_status:='DISCONNECTED';event_name:='STRATEGY_TARGET_DISCONNECTED';
    update public.strategy_target_bindings set status=next_status,disconnected_at=now_at,disconnect_policy=p_disconnect_policy,row_version=row_version+1 where id=binding.id;
  else raise exception 'invalid strategy target action' using errcode='22023'; end if;
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,next_status);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,severity,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,event_name,case when p_action='DISCONNECT' then 'WARNING' else 'INFO' end,
    case when p_action='ARM' then 'A broker or Investment Group target was armed for server-authoritative Strategy Lab execution.' when p_action='DISCONNECT' then 'A target binding was revoked and its slot was returned to empty.' else 'A strategy target lifecycle action was applied atomically.' end,
    jsonb_build_object('action',p_action,'targetType',binding.target_type,'slotIndex',binding.slot_index,'status',next_status,'disconnectPolicy',p_disconnect_policy,'historicalRecordsPreserved',true));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'status',next_status,'idempotent',false);
end;
$$;

revoke all on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) to service_role;

comment on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) is
  'Atomically controls Strategy Lab target lifecycle and reactivates the parent VPS evaluator when an armed target resumes to LIVE.';

commit;
