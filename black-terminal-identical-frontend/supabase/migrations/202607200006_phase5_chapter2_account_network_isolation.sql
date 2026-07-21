-- Phase V, Chapter II: bind every broker credential/account to one venue network.
begin;
alter table public.exchange_accounts add column if not exists network text not null default 'mainnet';
alter table public.exchange_accounts drop constraint if exists exchange_accounts_network_check;
alter table public.exchange_accounts add constraint exchange_accounts_network_check check (network in ('mainnet','testnet'));
create index if not exists idx_exchange_accounts_user_venue_network on public.exchange_accounts(user_id,exchange,network);
commit;
