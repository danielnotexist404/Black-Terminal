begin;

alter table public.execution_orders
  add column if not exists average_fill_price numeric(24,8);

comment on column public.execution_orders.average_fill_price is
  'Authoritative venue-reported average fill price for the canonical execution order.';

commit;
