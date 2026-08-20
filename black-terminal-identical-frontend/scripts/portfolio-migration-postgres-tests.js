import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create role authenticated;
  create table public.exchange_accounts(id uuid primary key, user_id uuid);
  create table public.account_positions(
    id uuid primary key, account_id uuid, exchange text, network text, category text,
    market_kind text, symbol text, position_idx integer, direction text, canonical_key text
  );
  create unique index idx_account_positions_canonical_identity on public.account_positions(account_id, canonical_key);
  alter table public.account_positions enable row level security;
  create table public.account_balances(id uuid primary key, account_id uuid);
  alter table public.account_balances enable row level security;
  create table public.execution_orders(id uuid primary key, account_id uuid, user_id uuid);
  alter table public.execution_orders enable row level security;
  create publication supabase_realtime;
`);

const migration = readFileSync(new URL("../supabase/migrations/202608210001_portfolio_realtime_freshness.sql", import.meta.url), "utf8");
await db.exec(migration);

const policies = await db.query(`
  select tablename, policyname, roles, cmd
  from pg_policies
  where schemaname = 'public'
  order by tablename, policyname
`);
assert.deepEqual(policies.rows.map((row) => [row.tablename, row.cmd]), [
  ["account_balances", "SELECT"],
  ["account_positions", "SELECT"],
  ["execution_orders", "SELECT"]
]);

const publication = await db.query(`
  select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
  order by tablename
`);
assert.deepEqual(publication.rows.map((row) => row.tablename), ["account_balances", "account_positions", "execution_orders"]);

console.log("Portfolio realtime migration PostgreSQL transaction, RLS, and publication tests: PASS");
