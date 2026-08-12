begin;

create or replace function public.black_cloud_activate_automation_mandate_v2(
  p_user_id uuid, p_connection_id uuid, p_policy jsonb,
  p_canonical_hash text, p_service_signature text, p_consent_evidence jsonb,
  p_risk_policy jsonb, p_risk_canonical_hash text, p_risk_service_signature text
)
returns public.broker_automation_mandates
language plpgsql security definer set search_path=public
as $$
declare
  next_version integer;
  next_risk_version integer;
  expected_version integer;
  expected_risk_version integer;
  environment text;
  result public.broker_automation_mandates;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  environment := p_policy->>'executionEnvironment';
  if environment <> 'MAINNET_LIVE' then raise exception 'production Bybit mandates require MAINNET_LIVE' using errcode='22023'; end if;
  if not exists(
    select 1 from public.connectivity_connections
    where id=p_connection_id and user_id=p_user_id and revoked_at is null and disabled_at is null
      and provider='bybit' and execution_environment='MAINNET_LIVE' and endpoint_profile='GLOBAL'
  ) then raise exception 'connection ownership or locked production environment mismatch' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowWithdrawals')::boolean,false) then raise exception 'withdrawal automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowTransfers')::boolean,false) then raise exception 'wallet transfer automation is forbidden' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'executionEnvironment','')<>environment then raise exception 'consent environment mismatch' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'confirmation','')<>'ENABLE OFFLINE CLOUD EXECUTION' then raise exception 'persistent automation confirmation missing' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mandate:'||p_connection_id::text,0));
  select coalesce(max(mandate_version),0)+1 into next_version from public.broker_automation_mandates where connection_id=p_connection_id;
  select coalesce(max(policy_version),0)+1 into next_risk_version from public.broker_risk_policy_versions where connection_id=p_connection_id;
  expected_version := (p_policy->>'mandateVersion')::integer;
  expected_risk_version := (p_policy->>'riskPolicyVersion')::integer;
  if expected_version is distinct from next_version then raise exception 'automation mandate version conflict' using errcode='40001'; end if;
  if expected_risk_version is distinct from next_risk_version then raise exception 'risk policy version conflict' using errcode='40001'; end if;
  update public.broker_automation_mandates set status='REVOKED',revoked_at=now(),updated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  insert into public.broker_automation_mandates(
    user_id,connection_id,broker,account_reference,subaccount_reference,
    allow_read,allow_trade,allow_cancel,allow_modify,allow_strategy_execution,
    allow_copy_trading,allow_investment_group_execution,allow_withdrawals,
    max_order_notional,max_position_notional,max_leverage,max_daily_loss,
    allowed_strategies,allowed_symbols,emergency_policy,status,mandate_version,
    policy_version,security_version,canonical_hash,service_signature,
    consent_evidence,accepted_at,expires_at,execution_environment,risk_policy_version
  ) values (
    p_user_id,p_connection_id,lower(p_policy->>'broker'),p_policy->>'accountReference',nullif(p_policy->>'subaccountReference',''),
    coalesce((p_policy->>'allowRead')::boolean,true),coalesce((p_policy->>'allowTrade')::boolean,false),
    coalesce((p_policy->>'allowCancel')::boolean,false),coalesce((p_policy->>'allowModify')::boolean,false),
    coalesce((p_policy->>'allowStrategyExecution')::boolean,false),coalesce((p_policy->>'allowCopyTrading')::boolean,false),
    coalesce((p_policy->>'allowInvestmentGroupExecution')::boolean,false),false,
    nullif(p_policy->>'maxOrderNotional','')::numeric,nullif(p_policy->>'maxPositionNotional','')::numeric,
    nullif(p_policy->>'maxLeverage','')::numeric,nullif(p_policy->>'maxDailyLoss','')::numeric,
    coalesce(p_policy->'allowedStrategies','[]'::jsonb),coalesce(p_policy->'allowedSymbols','[]'::jsonb),
    coalesce(p_policy->'emergencyPolicy','{"preserveProtectiveOrders":true}'::jsonb),'ACTIVE',next_version,
    p_policy->>'policyVersion',p_policy->>'securityVersion',p_canonical_hash,p_service_signature,
    coalesce(p_consent_evidence,'{}'::jsonb),(p_policy->>'acceptedAt')::timestamptz,nullif(p_policy->>'expiresAt','')::timestamptz,
    environment,next_risk_version
  ) returning * into result;
  insert into public.broker_automation_mandate_versions(mandate_id,user_id,version,policy_snapshot,canonical_hash,service_signature,consent_evidence)
  values(result.id,p_user_id,next_version,p_policy,p_canonical_hash,p_service_signature,coalesce(p_consent_evidence,'{}'::jsonb));
  insert into public.broker_risk_policy_versions(
    user_id,connection_id,mandate_id,execution_environment,policy_version,
    policy_snapshot,canonical_hash,service_signature,confirmation_evidence
  ) values (
    p_user_id,p_connection_id,result.id,environment,next_risk_version,
    p_risk_policy,p_risk_canonical_hash,p_risk_service_signature,coalesce(p_consent_evidence,'{}'::jsonb)
  );
  insert into public.connection_audit_events(user_id,connection_id,mandate_id,event_type,message,safe_metadata)
  values(
    p_user_id,p_connection_id,result.id,'AUTOMATION_MANDATE_AUTHORIZED',
    'The user explicitly authorized environment-bound browser-independent execution.',
    jsonb_build_object('version',next_version,'riskPolicyVersion',next_risk_version,'executionEnvironment',environment,'withdrawalPermission',false,'transferPermission',false,'expiresAt',result.expires_at)
  );
  return result;
end;
$$;

revoke all on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) to service_role;

commit;
