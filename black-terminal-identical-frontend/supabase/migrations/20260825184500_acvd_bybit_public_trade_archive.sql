begin;

-- Completed Bybit public trade days are committed atomically with their 1-minute
-- aggregates.  The browser never receives raw trades and cannot write either
-- table.  A day becomes queryable only after all 1,440 UTC minute rows pass the
-- transaction-level validation below.
create table if not exists public.acvd_bybit_public_trade_days (
  venue text not null default 'BYBIT' check (venue = 'BYBIT'),
  symbol text not null check (symbol ~ '^[A-Z0-9_-]{2,40}$'),
  market_kind text not null default 'linear_perpetual' check (market_kind = 'linear_perpetual'),
  archive_date date not null,
  source_url text not null check (source_url ~ '^https://public\.bybit\.com/trading/[A-Z0-9_-]{2,40}/[A-Z0-9_-]{2,40}[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv\.gz$'),
  source_etag text,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  compressed_bytes bigint not null check (compressed_bytes > 0),
  uncompressed_bytes bigint not null check (uncompressed_bytes > 0),
  minute_count integer not null check (minute_count = 1440),
  exact_trade_count bigint not null check (exact_trade_count > 0),
  first_trade_at timestamptz not null,
  last_trade_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  primary key (venue, symbol, market_kind, archive_date),
  check (first_trade_at >= archive_date::timestamp at time zone 'UTC'),
  check (last_trade_at < (archive_date::timestamp at time zone 'UTC') + interval '1 day'),
  check (last_trade_at >= first_trade_at)
);

create table if not exists public.acvd_bybit_public_trade_minutes (
  venue text not null default 'BYBIT' check (venue = 'BYBIT'),
  symbol text not null check (symbol ~ '^[A-Z0-9_-]{2,40}$'),
  market_kind text not null default 'linear_perpetual' check (market_kind = 'linear_perpetual'),
  archive_date date not null,
  interval_start timestamptz not null,
  buy_volume numeric not null default 0 check (buy_volume >= 0),
  sell_volume numeric not null default 0 check (sell_volume >= 0),
  buy_notional numeric not null default 0 check (buy_notional >= 0),
  sell_notional numeric not null default 0 check (sell_notional >= 0),
  exact_trade_count bigint not null default 0 check (exact_trade_count >= 0),
  total_trade_count bigint not null default 0 check (total_trade_count >= 0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (venue, symbol, market_kind, interval_start),
  foreign key (venue, symbol, market_kind, archive_date)
    references public.acvd_bybit_public_trade_days(venue, symbol, market_kind, archive_date)
    on delete restrict,
  check (date_trunc('minute', interval_start) = interval_start),
  check (interval_start >= archive_date::timestamp at time zone 'UTC'),
  check (interval_start < (archive_date::timestamp at time zone 'UTC') + interval '1 day'),
  check (exact_trade_count = total_trade_count)
);

create index if not exists idx_acvd_bybit_public_trade_minutes_symbol_time
  on public.acvd_bybit_public_trade_minutes(symbol, interval_start);

drop trigger if exists trg_acvd_bybit_public_trade_days_immutable on public.acvd_bybit_public_trade_days;
create trigger trg_acvd_bybit_public_trade_days_immutable
before update or delete on public.acvd_bybit_public_trade_days
for each row execute function public.bclif_reject_immutable_change();

drop trigger if exists trg_acvd_bybit_public_trade_minutes_immutable on public.acvd_bybit_public_trade_minutes;
create trigger trg_acvd_bybit_public_trade_minutes_immutable
before update or delete on public.acvd_bybit_public_trade_minutes
for each row execute function public.bclif_reject_immutable_change();

alter table public.acvd_bybit_public_trade_days enable row level security;
alter table public.acvd_bybit_public_trade_minutes enable row level security;
revoke all on public.acvd_bybit_public_trade_days from public, anon, authenticated;
revoke all on public.acvd_bybit_public_trade_minutes from public, anon, authenticated;
grant select, insert on public.acvd_bybit_public_trade_days to service_role;
grant select, insert on public.acvd_bybit_public_trade_minutes to service_role;

create or replace function public.acvd_commit_bybit_public_trade_day(
  p_manifest jsonb,
  p_minutes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_symbol text := upper(trim(coalesce(p_manifest->>'symbol', '')));
  v_archive_date date := (p_manifest->>'archiveDate')::date;
  v_source_url text := p_manifest->>'sourceUrl';
  v_source_etag text := nullif(p_manifest->>'sourceEtag', '');
  v_source_sha256 text := lower(coalesce(p_manifest->>'sourceSha256', ''));
  v_compressed_bytes bigint := (p_manifest->>'compressedBytes')::bigint;
  v_uncompressed_bytes bigint := (p_manifest->>'uncompressedBytes')::bigint;
  v_exact_trade_count bigint := (p_manifest->>'exactTradeCount')::bigint;
  v_first_trade_at timestamptz := (p_manifest->>'firstTradeAt')::timestamptz;
  v_last_trade_at timestamptz := (p_manifest->>'lastTradeAt')::timestamptz;
  v_day_start timestamptz := v_archive_date::timestamp at time zone 'UTC';
  v_existing_sha text;
  v_inserted integer;
begin
  if v_symbol !~ '^[A-Z0-9_-]{2,40}$'
     or v_source_sha256 !~ '^[a-f0-9]{64}$'
     or v_source_url <> format('https://public.bybit.com/trading/%s/%s%s.csv.gz', v_symbol, v_symbol, to_char(v_archive_date, 'YYYY-MM-DD'))
     or jsonb_typeof(p_minutes) <> 'array'
     or jsonb_array_length(p_minutes) <> 1440 then
    raise exception 'Invalid Bybit public trade archive payload';
  end if;

  select source_sha256 into v_existing_sha
  from public.acvd_bybit_public_trade_days
  where venue = 'BYBIT' and symbol = v_symbol and market_kind = 'linear_perpetual' and archive_date = v_archive_date;

  if v_existing_sha is not null then
    if v_existing_sha <> v_source_sha256 then
      raise exception 'Bybit public trade archive checksum changed for committed day';
    end if;
    return jsonb_build_object('status', 'existing', 'symbol', v_symbol, 'archiveDate', v_archive_date, 'minutes', 1440);
  end if;

  if (select count(*) from (
        select (entry->>'interval_start')::timestamptz as interval_start
        from jsonb_array_elements(p_minutes) entry
      ) parsed
      where interval_start >= v_day_start
        and interval_start < v_day_start + interval '1 day'
        and date_trunc('minute', interval_start) = interval_start) <> 1440
     or (select count(distinct (entry->>'interval_start')::timestamptz) from jsonb_array_elements(p_minutes) entry) <> 1440
     or (select min((entry->>'interval_start')::timestamptz) from jsonb_array_elements(p_minutes) entry) <> v_day_start
     or (select max((entry->>'interval_start')::timestamptz) from jsonb_array_elements(p_minutes) entry) <> v_day_start + interval '1439 minutes' then
    raise exception 'Bybit public trade archive must contain every UTC minute exactly once';
  end if;

  if (select coalesce(sum((entry->>'exact_trade_count')::bigint), 0) from jsonb_array_elements(p_minutes) entry) <> v_exact_trade_count
     or (select bool_and((entry->>'exact_trade_count')::bigint = (entry->>'total_trade_count')::bigint) from jsonb_array_elements(p_minutes) entry) is not true then
    raise exception 'Bybit public trade archive trade counts do not reconcile';
  end if;

  insert into public.acvd_bybit_public_trade_days (
    venue, symbol, market_kind, archive_date, source_url, source_etag, source_sha256,
    compressed_bytes, uncompressed_bytes, minute_count, exact_trade_count, first_trade_at, last_trade_at
  ) values (
    'BYBIT', v_symbol, 'linear_perpetual', v_archive_date, v_source_url, v_source_etag, v_source_sha256,
    v_compressed_bytes, v_uncompressed_bytes, 1440, v_exact_trade_count, v_first_trade_at, v_last_trade_at
  );

  insert into public.acvd_bybit_public_trade_minutes (
    venue, symbol, market_kind, archive_date, interval_start,
    buy_volume, sell_volume, buy_notional, sell_notional,
    exact_trade_count, total_trade_count, source_sha256
  )
  select
    'BYBIT', v_symbol, 'linear_perpetual', v_archive_date, parsed.interval_start,
    parsed.buy_volume, parsed.sell_volume, parsed.buy_notional, parsed.sell_notional,
    parsed.exact_trade_count, parsed.total_trade_count, v_source_sha256
  from jsonb_to_recordset(p_minutes) as parsed(
    interval_start timestamptz,
    buy_volume numeric,
    sell_volume numeric,
    buy_notional numeric,
    sell_notional numeric,
    exact_trade_count bigint,
    total_trade_count bigint
  );
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1440 then raise exception 'Bybit public trade minute commit was incomplete'; end if;

  return jsonb_build_object('status', 'inserted', 'symbol', v_symbol, 'archiveDate', v_archive_date, 'minutes', v_inserted);
end;
$$;

create or replace function public.acvd_read_bybit_public_trade_bars(
  p_symbol text,
  p_timeframe_seconds integer,
  p_start_epoch bigint,
  p_end_epoch bigint
)
returns table (
  "time" bigint,
  buy_volume numeric,
  sell_volume numeric,
  buy_notional numeric,
  sell_notional numeric,
  exact_trade_count bigint,
  total_trade_count bigint,
  minute_count bigint,
  delivery_complete boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  p_symbol := upper(trim(coalesce(p_symbol, '')));
  if p_symbol !~ '^[A-Z0-9_-]{2,40}$'
     or p_timeframe_seconds < 60
     or p_timeframe_seconds > 2592000
     or p_timeframe_seconds % 60 <> 0
     or p_start_epoch <= 0
     or p_end_epoch <= p_start_epoch
     or (p_end_epoch - p_start_epoch) / p_timeframe_seconds > 20000 then
    raise exception 'Invalid Bybit public trade bar query';
  end if;

  return query
  with scoped as (
    select
      floor(extract(epoch from m.interval_start) / p_timeframe_seconds)::bigint * p_timeframe_seconds as bucket_epoch,
      m.*
    from public.acvd_bybit_public_trade_minutes m
    where m.venue = 'BYBIT'
      and m.market_kind = 'linear_perpetual'
      and m.symbol = p_symbol
      and m.interval_start >= to_timestamp(p_start_epoch)
      and m.interval_start < to_timestamp(p_end_epoch)
  )
  select
    s.bucket_epoch,
    sum(s.buy_volume),
    sum(s.sell_volume),
    sum(s.buy_notional),
    sum(s.sell_notional),
    sum(s.exact_trade_count)::bigint,
    sum(s.total_trade_count)::bigint,
    count(*)::bigint,
    count(*) = p_timeframe_seconds / 60
  from scoped s
  group by s.bucket_epoch
  order by s.bucket_epoch;
end;
$$;

revoke all on function public.acvd_commit_bybit_public_trade_day(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.acvd_read_bybit_public_trade_bars(text, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.acvd_commit_bybit_public_trade_day(jsonb, jsonb) to service_role;
grant execute on function public.acvd_read_bybit_public_trade_bars(text, integer, bigint, bigint) to service_role;

comment on table public.acvd_bybit_public_trade_days is
  'Immutable completed-day manifests for official Bybit public aggressor-trade CSV archives.';
comment on table public.acvd_bybit_public_trade_minutes is
  'Immutable exact one-minute aggressor-flow aggregates from completed official Bybit public trade archives.';

commit;
