begin;

create or replace function public.bt_sanitize_audit_text(p_value text)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  sanitized text := p_value;
begin
  sanitized := regexp_replace(sanitized, '(sk-ant-|re_)[A-Za-z0-9_-]{16,}', '[REDACTED_PROVIDER_KEY]', 'gi');
  sanitized := regexp_replace(sanitized, 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_TOKEN]', 'g');
  sanitized := regexp_replace(
    sanitized,
    '(password|secret|token|api.?key|private.?key|authorization|signature|seed|mnemonic)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+',
    '\1=[REDACTED]',
    'gi'
  );
  return left(sanitized, 1000);
end
$$;

create or replace function public.bt_sanitize_audit_jsonb(p_value jsonb, p_depth integer default 0)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if p_value is null then return '{}'::jsonb; end if;
  if p_depth > 8 then return '"[REDACTED_DEPTH]"'::jsonb; end if;

  case jsonb_typeof(p_value)
    when 'object' then
      select coalesce(jsonb_object_agg(entry.key,
        case
          when entry.key ~* '(password|secret|token|api.?key|private.?key|credential|prompt|messages?|html|authorization|signature|seed|mnemonic|encrypted|cipher|nonce|raw|payload)'
            then '"[REDACTED]"'::jsonb
          else public.bt_sanitize_audit_jsonb(entry.value, p_depth + 1)
        end
      ), '{}'::jsonb) into result
      from (
        select key, value from jsonb_each(p_value) order by key limit 100
      ) entry;
      return result;
    when 'array' then
      select coalesce(jsonb_agg(public.bt_sanitize_audit_jsonb(entry.value, p_depth + 1)), '[]'::jsonb)
      into result
      from (
        select value from jsonb_array_elements(p_value) with ordinality ordered(value, position)
        order by position limit 100
      ) entry;
      return result;
    when 'string' then
      return to_jsonb(public.bt_sanitize_audit_text(p_value #>> '{}'));
    else
      return p_value;
  end case;
end
$$;

create or replace function public.bt_enforce_audit_redaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if tg_table_name = 'execution_audit_logs' then
    new.message := public.bt_sanitize_audit_text(new.message);
    new.metadata := public.bt_sanitize_audit_jsonb(new.metadata);
  elsif tg_table_name = 'execution_audit_events' then
    new.message := public.bt_sanitize_audit_text(new.message);
    new.safe_metadata := public.bt_sanitize_audit_jsonb(new.safe_metadata);
  elsif tg_table_name = 'security_audit_events' then
    new.safe_metadata := public.bt_sanitize_audit_jsonb(new.safe_metadata);
  elsif tg_table_name = 'bt_audit_logs' then
    new.message := public.bt_sanitize_audit_text(new.message);
  end if;
  return new;
end
$$;

drop trigger if exists trg_execution_audit_logs_redaction on public.execution_audit_logs;
create trigger trg_execution_audit_logs_redaction
before insert or update of message, metadata on public.execution_audit_logs
for each row execute function public.bt_enforce_audit_redaction();

drop trigger if exists trg_execution_audit_events_redaction on public.execution_audit_events;
create trigger trg_execution_audit_events_redaction
before insert or update of message, safe_metadata on public.execution_audit_events
for each row execute function public.bt_enforce_audit_redaction();

drop trigger if exists trg_security_audit_events_redaction on public.security_audit_events;
create trigger trg_security_audit_events_redaction
before insert or update of safe_metadata on public.security_audit_events
for each row execute function public.bt_enforce_audit_redaction();

drop trigger if exists trg_bt_audit_logs_redaction on public.bt_audit_logs;
create trigger trg_bt_audit_logs_redaction
before insert or update of message on public.bt_audit_logs
for each row execute function public.bt_enforce_audit_redaction();

revoke all on function public.bt_sanitize_audit_text(text) from public, anon, authenticated;
revoke all on function public.bt_sanitize_audit_jsonb(jsonb, integer) from public, anon, authenticated;
revoke all on function public.bt_enforce_audit_redaction() from public, anon, authenticated;

do $$
declare
  redacted jsonb;
begin
  redacted := public.bt_sanitize_audit_jsonb('{"action":"connect","nested":{"apiKey":"never-store","result":"blocked"},"prompt":"never-store"}'::jsonb);
  if redacted #>> '{nested,apiKey}' <> '[REDACTED]'
    or redacted ->> 'prompt' <> '[REDACTED]'
    or redacted #>> '{nested,result}' <> 'blocked' then
    raise exception 'Phase V verification failed: audit metadata redaction is incomplete';
  end if;
  if public.bt_sanitize_audit_text('token=never-store') like '%never-store%' then
    raise exception 'Phase V verification failed: audit text redaction is incomplete';
  end if;
end
$$;

commit;
