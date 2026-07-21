begin;

-- The 90-day-to-one-year audit tier is cold, server-only storage. Explicit
-- PostgreSQL compression keeps long text and JSON evidence compact while the
-- bounded retention function continues to remove data after one year.
alter table public.execution_audit_archive alter column message set storage extended;
alter table public.execution_audit_archive alter column message set compression pglz;
alter table public.execution_audit_archive alter column metadata set storage extended;
alter table public.execution_audit_archive alter column metadata set compression pglz;

comment on table public.execution_audit_archive is
  'Compressed server-only execution audit archive: hot after 90 days, retained until one year.';

do $$
declare
  compression_count integer;
begin
  select count(*) into compression_count
  from pg_attribute
  where attrelid = 'public.execution_audit_archive'::regclass
    and attname in ('message', 'metadata')
    and attcompression = 'p';

  if compression_count <> 2 then
    raise exception 'Phase V verification failed: execution audit archive compression is incomplete';
  end if;

  if has_table_privilege('anon', 'public.execution_audit_archive', 'select')
    or has_table_privilege('authenticated', 'public.execution_audit_archive', 'select') then
    raise exception 'Phase V verification failed: a client role can read the compressed audit archive';
  end if;
end
$$;

commit;
