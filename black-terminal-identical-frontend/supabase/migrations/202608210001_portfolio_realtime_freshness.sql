-- Read-only, user-scoped realtime invalidation for the Positions workspace.
-- Broker values continue to be fetched and reconciled by the authenticated API.

-- Canonical identity V2 explicitly includes both category and market kind.
update public.account_positions
set canonical_key =
  lower(exchange) || ':' || lower(network) || ':' || lower(category) || ':' ||
  lower(market_kind) || ':' || upper(symbol) || ':' || position_idx::text || ':' || lower(direction);

drop policy if exists "users read own account positions" on public.account_positions;
create policy "users read own account positions"
  on public.account_positions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.exchange_accounts account
      where account.id = account_positions.account_id
        and account.user_id = auth.uid()
    )
  );

drop policy if exists "users read own account balances" on public.account_balances;
create policy "users read own account balances"
  on public.account_balances
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.exchange_accounts account
      where account.id = account_balances.account_id
        and account.user_id = auth.uid()
    )
  );

drop policy if exists "users read own execution orders" on public.execution_orders;
create policy "users read own execution orders"
  on public.execution_orders
  for select
  to authenticated
  using (user_id = auth.uid());

alter table public.account_positions replica identity full;
alter table public.account_balances replica identity full;
alter table public.execution_orders replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_positions'
  ) then
    alter publication supabase_realtime add table public.account_positions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_balances'
  ) then
    alter publication supabase_realtime add table public.account_balances;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'execution_orders'
  ) then
    alter publication supabase_realtime add table public.execution_orders;
  end if;
end
$$;
