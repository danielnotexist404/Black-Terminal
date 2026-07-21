-- BLACK TERMINAL - Investment Group public sections and moderation
-- Apply after the Phase IV Professional Network Foundation migration.

begin;

alter table public.investment_groups
  add column if not exists public_sections jsonb not null default '[]'::jsonb;

alter table public.investment_groups
  drop constraint if exists investment_groups_public_sections_array;

alter table public.investment_groups
  add constraint investment_groups_public_sections_array
  check (jsonb_typeof(public_sections) = 'array');

create table if not exists public.investment_group_moderation_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  action text not null check (action in ('message_deleted','member_removed','role_changed')),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid references auth.users(id) on delete set null,
  message_id uuid,
  reason text not null check (char_length(trim(reason)) between 5 and 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_investment_group_moderation_group_time
  on public.investment_group_moderation_events(group_id, created_at desc);

alter table public.investment_group_moderation_events enable row level security;

drop policy if exists "investment_group_moderation_select_authorized" on public.investment_group_moderation_events;
create policy "investment_group_moderation_select_authorized"
  on public.investment_group_moderation_events for select
  using (
    auth.uid() = target_user_id
    or exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_moderation_events.group_id
        and g.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.investment_group_members m
      where m.group_id = investment_group_moderation_events.group_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and m.role = 'manager'
    )
  );

drop policy if exists "investment_group_messages_delete_moderators" on public.investment_group_messages;
create policy "investment_group_messages_delete_moderators"
  on public.investment_group_messages for delete
  using (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_messages.group_id
        and g.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.investment_group_members m
      where m.group_id = investment_group_messages.group_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and m.role = 'manager'
    )
  );

drop policy if exists "investment_group_messages_select_members" on public.investment_group_messages;
create policy "investment_group_messages_select_members"
  on public.investment_group_messages for select
  using (
    exists (
      select 1 from public.investment_group_members m
      where m.group_id = investment_group_messages.group_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
    or exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_messages.group_id
        and g.visibility = 'public'
        and g.public_sections ? 'trading_room'
    )
  );

commit;
