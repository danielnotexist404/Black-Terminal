begin;

-- With standard_conforming_strings enabled, a regex literal uses one
-- backslash to escape a dot. The original checks used two and therefore
-- looked for a literal backslash before the file extension.
alter table public.bclif_canonical_event_chunks
  drop constraint if exists bclif_canonical_event_chunks_path_check;
alter table public.bclif_canonical_event_chunks
  add constraint bclif_canonical_event_chunks_path_check check (
    object_path ~ '^events/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(TRADE|LIQUIDATION|OPEN_INTEREST|BOOK_FRAME|FUNDING|MARK_INDEX|POSITION_RATIO|RISK_TIER|INSTRUMENT_INFO)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.events\.gz$'
  );

alter table public.bclif_cohort_checkpoints
  drop constraint if exists bclif_cohort_checkpoints_path_check;
alter table public.bclif_cohort_checkpoints
  add constraint bclif_cohort_checkpoints_path_check check (
    object_path ~ '^checkpoints/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.checkpoint\.gz$'
  );

alter table public.bclif_field_chunks
  drop constraint if exists bclif_field_chunks_path_check;
alter table public.bclif_field_chunks
  add constraint bclif_field_chunks_path_check check (
    object_path ~ '^v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.bclif$'
  );

create or replace function public.bclif_storage_object_path_valid(candidate text)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select candidate ~ '^(v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(6H|12H|1D|3D|1W|3W|1M|CUSTOM)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.bclif|events/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/(TRADE|LIQUIDATION|OPEN_INTEREST|BOOK_FRAME|FUNDING|MARK_INDEX|POSITION_RATIO|RISK_TIER|INSTRUMENT_INFO)/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.events\.gz|checkpoints/v[1-9][0-9]*/BYBIT/linear_perpetual/[A-Z0-9_-]{2,40}/[0-9]{10,16}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.checkpoint\.gz)$';
$$;
revoke all on function public.bclif_storage_object_path_valid(text) from public, anon, authenticated;
grant execute on function public.bclif_storage_object_path_valid(text) to service_role;

commit;
