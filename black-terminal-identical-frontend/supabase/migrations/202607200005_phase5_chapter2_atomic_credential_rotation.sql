-- Phase V, Chapter II: atomic AES-GCM broker credential activation/rotation.
begin;

create or replace function public.black_cloud_store_encrypted_broker_secret(
  p_user_id uuid, p_connection_id uuid, p_provider text,
  p_encrypted_secret bytea, p_encryption_iv bytea, p_authentication_tag bytea,
  p_credential_fingerprint text, p_authorization_type text,
  p_permission_scope jsonb, p_withdrawal_enabled boolean default false
)
returns public.broker_secret_references
language plpgsql security definer set search_path = public
as $$
declare
  next_version integer;
  vault_id uuid := gen_random_uuid();
  reference_id uuid := gen_random_uuid();
  result public.broker_secret_references;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  if p_withdrawal_enabled then raise exception 'withdrawal-enabled credentials are forbidden' using errcode='42501'; end if;
  if octet_length(p_encryption_iv) <> 12 or octet_length(p_authentication_tag) <> 16 then raise exception 'invalid AES-GCM envelope' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text, 0));
  select coalesce(max(credential_version),0)+1 into next_version from public.broker_secret_references where connection_id=p_connection_id;

  update public.broker_secret_references set status='ROTATED',rotated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  update public.broker_secret_vault set rotation_status='ROTATED',rotated_at=now() where connection_id=p_connection_id and rotation_status='ACTIVE';

  insert into public.broker_secret_vault(id,secret_reference_id,user_id,connection_id,provider,encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status)
  values(vault_id,reference_id,p_user_id,p_connection_id,lower(p_provider),p_encrypted_secret,p_encryption_iv,p_authentication_tag,1,'ACTIVE');
  insert into public.broker_secret_references(id,user_id,connection_id,provider,vault_secret_id,credential_version,credential_fingerprint,authorization_type,permission_scope,withdrawal_enabled,status,activated_at)
  values(reference_id,p_user_id,p_connection_id,lower(p_provider),vault_id,next_version,p_credential_fingerprint,p_authorization_type,coalesce(p_permission_scope,'{}'::jsonb),false,'ACTIVE',now()) returning * into result;

  update public.connectivity_connections set credential_version=next_version,authorization_type=p_authorization_type,updated_at=now() where id=p_connection_id and user_id=p_user_id;
  insert into public.execution_audit_events(user_id,connection_id,event_type,severity,operation_purpose,user_visible,message,safe_metadata)
  values(p_user_id,p_connection_id,case when next_version=1 then 'CREDENTIAL_STORED' else 'CREDENTIAL_ROTATED' end,'INFO','credential_activation',true,'An encrypted trade-only broker credential was activated.',jsonb_build_object('provider',lower(p_provider),'credentialVersion',next_version));
  return result;
end;
$$;

revoke all on function public.black_cloud_store_encrypted_broker_secret(uuid,uuid,text,bytea,bytea,bytea,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.black_cloud_store_encrypted_broker_secret(uuid,uuid,text,bytea,bytea,bytea,text,text,jsonb,boolean) to service_role;

commit;
