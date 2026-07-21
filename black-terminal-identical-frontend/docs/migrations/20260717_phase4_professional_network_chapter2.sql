-- BLACK TERMINAL - Project Obsidian
-- Phase IV Professional Network, Chapter II
-- Apply after the 2026-07-09 Professional Network Foundation migration.

begin;

create extension if not exists pgcrypto;

create or replace function public.bt_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Canonical professional identity. Existing profiles are extended in place.
alter table public.profiles_extended
  add column if not exists handle text,
  add column if not exists headline text not null default '',
  add column if not exists professional_role text,
  add column if not exists organization text,
  add column if not exists website_url text,
  add column if not exists location text,
  add column if not exists timezone text,
  add column if not exists market_specialties jsonb not null default '[]'::jsonb,
  add column if not exists asset_classes jsonb not null default '[]'::jsonb,
  add column if not exists trading_horizons jsonb not null default '[]'::jsonb,
  add column if not exists methodology_tags jsonb not null default '[]'::jsonb,
  add column if not exists avatar_storage_path text,
  add column if not exists banner_storage_path text,
  add column if not exists profile_visibility text not null default 'public',
  add column if not exists show_positions boolean not null default false,
  add column if not exists show_groups boolean not null default true,
  add column if not exists message_policy text not null default 'followers',
  add column if not exists verified_role boolean not null default false,
  add column if not exists verified_performance_source text,
  add column if not exists deleted_at timestamptz;

update public.profiles_extended p
set handle = lower(regexp_replace(
  coalesce(
    nullif(p.handle, ''),
    nullif((select u.raw_user_meta_data ->> 'username' from auth.users u where u.id = p.user_id), ''),
    'professional_' || left(replace(p.user_id::text, '-', ''), 12)
  ),
  '[^a-zA-Z0-9_]+', '_', 'g'
))
where p.handle is null or p.handle = '';

alter table public.profiles_extended
  alter column handle set not null;

alter table public.profiles_extended
  drop constraint if exists profiles_extended_handle_format,
  add constraint profiles_extended_handle_format
    check (handle ~ '^[a-z0-9_]{3,30}$'),
  drop constraint if exists profiles_extended_profile_visibility_check,
  add constraint profiles_extended_profile_visibility_check
    check (profile_visibility in ('public', 'followers', 'private')),
  drop constraint if exists profiles_extended_message_policy_check,
  add constraint profiles_extended_message_policy_check
    check (message_policy in ('everyone', 'followers', 'nobody')),
  drop constraint if exists profiles_extended_market_specialties_array,
  add constraint profiles_extended_market_specialties_array
    check (jsonb_typeof(market_specialties) = 'array'),
  drop constraint if exists profiles_extended_asset_classes_array,
  add constraint profiles_extended_asset_classes_array
    check (jsonb_typeof(asset_classes) = 'array');

create unique index if not exists idx_profiles_extended_handle_unique
  on public.profiles_extended(lower(handle)) where deleted_at is null;
create index if not exists idx_profiles_extended_discovery
  on public.profiles_extended(profile_visibility, updated_at desc) where deleted_at is null;

drop trigger if exists trg_profiles_extended_updated_at on public.profiles_extended;
create trigger trg_profiles_extended_updated_at
before update on public.profiles_extended
for each row execute function public.bt_set_updated_at();

create table if not exists public.profile_specialties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  specialty_type text not null check (specialty_type in ('market', 'asset_class', 'trading_style', 'methodology', 'horizon')),
  value text not null check (char_length(trim(value)) between 1 and 80),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, specialty_type, value)
);

create table if not exists public.profile_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 40),
  url text not null check (url ~ '^https://'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_visibility text not null default 'public' check (profile_visibility in ('public', 'followers', 'private')),
  message_policy text not null default 'followers' check (message_policy in ('everyone', 'followers', 'nobody')),
  show_followers boolean not null default true,
  show_following boolean not null default true,
  show_statistics boolean not null default false,
  show_positions boolean not null default false,
  show_investment_groups boolean not null default true,
  allow_post_mentions boolean not null default true,
  allow_comment_mentions boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Follow requests, blocks and mutes are separate from the existing accepted follow graph.
create table if not exists public.social_follow_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (requester_user_id, target_user_id),
  check (requester_user_id <> target_user_id)
);

create table if not exists public.user_blocks (
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

create table if not exists public.user_mutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  muted_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_user_id),
  check (user_id <> muted_user_id)
);

create or replace function public.social_users_blocked(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_user_id = first_user and b.blocked_user_id = second_user)
       or (b.blocker_user_id = second_user and b.blocked_user_id = first_user)
  );
$$;

revoke all on function public.social_users_blocked(uuid, uuid) from public;
grant execute on function public.social_users_blocked(uuid, uuid) to authenticated, service_role;

-- Extend the existing canonical post table. Do not create a duplicate post source.
alter table public.profile_posts
  add column if not exists title text,
  add column if not exists summary text,
  add column if not exists asset_class text,
  add column if not exists directional_bias text,
  add column if not exists risk_disclaimer text not null default '',
  add column if not exists investment_group_id uuid references public.investment_groups(id) on delete set null,
  add column if not exists parent_post_id uuid references public.profile_posts(id) on delete set null,
  add column if not exists quoted_post_id uuid references public.profile_posts(id) on delete set null,
  add column if not exists status text not null default 'published',
  add column if not exists comments_enabled boolean not null default true,
  add column if not exists idempotency_key text,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.profile_posts
  drop constraint if exists profile_posts_post_type_check,
  add constraint profile_posts_post_type_check check (post_type in (
    'status', 'market_research', 'macro_research', 'quantitative_research',
    'technical_analysis', 'orderflow_analysis', 'risk_commentary', 'trade_idea',
    'market_opinion', 'indicator_release', 'strategy_note', 'educational_note',
    'group_announcement', 'group_update', 'quote_post'
  )),
  drop constraint if exists profile_posts_visibility_check,
  add constraint profile_posts_visibility_check check (visibility in ('public', 'followers', 'private', 'group')),
  drop constraint if exists profile_posts_status_check,
  add constraint profile_posts_status_check check (status in ('draft', 'published', 'archived', 'deleted')),
  drop constraint if exists profile_posts_group_visibility,
  add constraint profile_posts_group_visibility check (
    (visibility <> 'group') or investment_group_id is not null
  );

create unique index if not exists idx_profile_posts_idempotency
  on public.profile_posts(user_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_profile_posts_feed_cursor
  on public.profile_posts(created_at desc, id desc) where deleted_at is null and status = 'published';
create index if not exists idx_profile_posts_group_time
  on public.profile_posts(investment_group_id, created_at desc) where deleted_at is null;

create table if not exists public.social_post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'chart_snapshot')),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  width integer check (width is null or width between 1 and 12000),
  height integer check (height is null or height between 1 and 12000),
  byte_size bigint not null check (byte_size between 1 and 15728640),
  alt_text text not null default '',
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (post_id, storage_path)
);

create table if not exists public.social_post_symbols (
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9._:/-]{2,30}$'),
  venue text,
  timeframe text,
  created_at timestamptz not null default now(),
  primary key (post_id, symbol)
);

create table if not exists public.social_mentions (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('post', 'comment')),
  source_id uuid not null,
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (source_type, source_id, mentioned_user_id),
  check (actor_user_id <> mentioned_user_id)
);

create index if not exists idx_social_mentions_recipient
  on public.social_mentions(mentioned_user_id, created_at desc);

create table if not exists public.social_post_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  attachment_type text not null check (attachment_type in ('indicator', 'strategy', 'chart_snapshot', 'trade_idea_update')),
  indicator_id uuid references public.published_indicators(id) on delete set null,
  strategy_id uuid references public.published_strategies(id) on delete set null,
  title text not null,
  public_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (attachment_type <> 'indicator' or indicator_id is not null)
    and (attachment_type <> 'strategy' or strategy_id is not null)
  )
);

create table if not exists public.social_post_edits (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  editor_user_id uuid not null references auth.users(id) on delete restrict,
  prior_title text,
  prior_body text not null,
  prior_metadata jsonb not null default '{}'::jsonb,
  edit_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.social_reactions (
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('insightful', 'bullish', 'bearish', 'useful', 'high_conviction', 'well_researched')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.social_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  parent_comment_id uuid references public.social_comments(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  client_comment_id text,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_comments
  add column if not exists client_comment_id text;

create unique index if not exists idx_social_comments_idempotency
  on public.social_comments(author_user_id, client_comment_id)
  where client_comment_id is not null;

create index if not exists idx_social_comments_post_time
  on public.social_comments(post_id, created_at) where deleted_at is null;

create table if not exists public.social_comment_reactions (
  comment_id uuid not null references public.social_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('insightful', 'useful', 'agree')),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.social_comment_edits (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.social_comments(id) on delete cascade,
  editor_user_id uuid not null references auth.users(id) on delete restrict,
  prior_body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.social_reposts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  commentary text,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create table if not exists public.social_saved_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create unique index if not exists idx_social_saved_collection_default
  on public.social_saved_collections(user_id) where is_default;

create table if not exists public.social_saved_posts (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  collection_id uuid references public.social_saved_collections(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.social_hidden_posts (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.profile_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- Professional direct messaging.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  conversation_type text not null default 'direct' check (conversation_type in ('direct', 'group')),
  direct_key text,
  title text,
  created_by uuid not null references auth.users(id) on delete cascade,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A canonical participant key makes one-to-one conversation creation race-safe.
-- NULL remains valid for future group conversations.
alter table public.conversations
  add column if not exists direct_key text;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'moderator', 'member')),
  archived_at timestamptz,
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (conversation_id, user_id)
);

create index if not exists idx_conversation_members_user
  on public.conversation_members(user_id, joined_at desc) where left_at is null;

with direct_pairs as (
  select
    c.id,
    c.created_at,
    min(cm.user_id::text) || ':' || max(cm.user_id::text) as canonical_key
  from public.conversations c
  join public.conversation_members cm
    on cm.conversation_id = c.id and cm.left_at is null
  where c.conversation_type = 'direct'
  group by c.id, c.created_at
  having count(*) = 2
), ranked_pairs as (
  select
    id,
    canonical_key,
    row_number() over (partition by canonical_key order by created_at, id) as pair_rank
  from direct_pairs
)
update public.conversations c
set direct_key = p.canonical_key
from ranked_pairs p
where c.id = p.id
  and p.pair_rank = 1
  and c.direct_key is null;

create unique index if not exists idx_conversations_direct_key
  on public.conversations(direct_key)
  where direct_key is not null;

create table if not exists public.message_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'blocked')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (sender_user_id <> recipient_user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 8000),
  message_type text not null default 'text' check (message_type in ('text', 'image', 'post', 'profile', 'indicator', 'strategy', 'group')),
  shared_object_type text,
  shared_object_id uuid,
  client_message_id text,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sender_user_id, client_message_id),
  check (body <> '' or shared_object_id is not null or message_type = 'image')
);

alter table public.messages
  drop constraint if exists messages_message_type_check,
  add constraint messages_message_type_check
    check (message_type in ('text', 'image', 'post', 'profile', 'indicator', 'strategy', 'group'));

create index if not exists idx_messages_conversation_cursor
  on public.messages(conversation_id, created_at desc, id desc) where deleted_at is null;

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  unique (message_id, storage_path)
);

create table if not exists public.message_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_message_id uuid references public.messages(id) on delete set null,
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create or replace function public.social_start_direct_conversation(
  actor_user uuid,
  target_user uuid,
  requires_request boolean
)
returns table (
  conversation_id uuid,
  created boolean,
  request_pending boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  canonical_key text;
  selected_id uuid;
  was_created boolean := false;
begin
  if actor_user is null or target_user is null or actor_user = target_user then
    raise exception 'invalid direct conversation participants' using errcode = '22023';
  end if;
  if auth.uid() is not null and auth.uid() <> actor_user then
    raise exception 'conversation identity mismatch' using errcode = '42501';
  end if;
  if public.social_users_blocked(actor_user, target_user) then
    raise exception 'conversation blocked' using errcode = '42501';
  end if;

  canonical_key := least(actor_user::text, target_user::text)
    || ':' || greatest(actor_user::text, target_user::text);

  select c.id into selected_id
  from public.conversations c
  where c.direct_key = canonical_key
  for update;

  if selected_id is null then
    insert into public.conversations(conversation_type, direct_key, created_by)
    values ('direct', canonical_key, actor_user)
    on conflict (direct_key) where direct_key is not null do nothing
    returning id into selected_id;

    if selected_id is not null then
      was_created := true;
    else
      select c.id into selected_id
      from public.conversations c
      where c.direct_key = canonical_key;
    end if;
  end if;

  insert into public.conversation_members(conversation_id, user_id, role, left_at)
  values
    (selected_id, actor_user, 'owner', null),
    (selected_id, target_user, 'member', null)
  on conflict (conversation_id, user_id) do update
    set left_at = null;

  if requires_request and was_created then
    insert into public.message_requests(
      conversation_id, sender_user_id, recipient_user_id, status
    ) values (
      selected_id, actor_user, target_user, 'pending'
    ) on conflict (conversation_id) do nothing;
  end if;

  return query select
    selected_id,
    was_created,
    exists (
      select 1 from public.message_requests mr
      where mr.conversation_id = selected_id
        and mr.status = 'pending'
    );
end;
$$;

revoke all on function public.social_start_direct_conversation(uuid, uuid, boolean) from public;
grant execute on function public.social_start_direct_conversation(uuid, uuid, boolean) to service_role;

-- Existing notification_events remains canonical.
alter table public.notification_events
  add column if not exists actor_user_id uuid references auth.users(id) on delete set null,
  add column if not exists post_id uuid references public.profile_posts(id) on delete cascade,
  add column if not exists comment_id uuid references public.social_comments(id) on delete cascade,
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade,
  add column if not exists group_id uuid references public.investment_groups(id) on delete cascade,
  add column if not exists deep_link text,
  add column if not exists grouping_key text,
  add column if not exists group_count integer not null default 1,
  add column if not exists last_event_at timestamptz not null default now();

create index if not exists idx_notification_events_unread
  on public.notification_events(user_id, created_at desc) where read_at is null;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  follows boolean not null default true,
  reactions boolean not null default true,
  comments boolean not null default true,
  reposts boolean not null default true,
  messages boolean not null default true,
  mentions boolean not null default true,
  group_activity boolean not null default true,
  indicator_updates boolean not null default true,
  email_digest text not null default 'off' check (email_digest in ('off', 'daily', 'weekly')),
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences
  add column if not exists mentions boolean not null default true;

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment', 'profile', 'message', 'group')),
  target_id uuid not null,
  reason text not null check (reason in ('spam', 'harassment', 'misleading_financial_claim', 'impersonation', 'copyright', 'private_information', 'other')),
  details text not null default '',
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'dismissed')),
  assigned_to uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.content_reports
  drop constraint if exists content_reports_reason_check,
  add constraint content_reports_reason_check check (reason in (
    'spam', 'harassment', 'impersonation', 'misleading_performance_claims',
    'scam', 'market_manipulation', 'copyright_violation',
    'sensitive_information', 'other',
    'misleading_financial_claim', 'copyright', 'private_information'
  ));

create index if not exists idx_content_reports_queue
  on public.content_reports(status, created_at);

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.content_reports(id) on delete set null,
  moderator_user_id uuid not null references auth.users(id) on delete restrict,
  target_type text not null,
  target_id uuid not null,
  action text not null check (action in ('none', 'hide', 'remove', 'warn', 'restrict', 'suspend')),
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.social_account_restrictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('restrict', 'suspend')),
  scope text not null default 'all' check (scope in ('all', 'posting', 'comments', 'engagement', 'messaging', 'media')),
  reason text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create index if not exists idx_social_account_restrictions_active
  on public.social_account_restrictions(user_id, starts_at desc)
  where lifted_at is null;

create table if not exists public.social_rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_social_rate_limit_window
  on public.social_rate_limit_events(user_id, action, created_at desc);

create or replace function public.social_consume_rate_limit(
  target_user uuid,
  target_action text,
  allowed_count integer,
  window_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  if auth.uid() is not null and auth.uid() <> target_user then
    raise exception 'rate limit identity mismatch' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_user::text || ':' || target_action, 0));
  select count(*)::integer into current_count
  from public.social_rate_limit_events
  where user_id = target_user
    and action = target_action
    and created_at >= now() - make_interval(secs => window_seconds);
  if current_count >= allowed_count then
    raise exception 'social rate limit exceeded' using errcode = 'P0001';
  end if;
  insert into public.social_rate_limit_events(user_id, action) values (target_user, target_action);
  return greatest(allowed_count - current_count - 1, 0);
end;
$$;

revoke all on function public.social_consume_rate_limit(uuid, text, integer, integer) from public;
grant execute on function public.social_consume_rate_limit(uuid, text, integer, integer) to authenticated, service_role;

create table if not exists public.professional_network_product_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  event_name text not null,
  duration_ms integer,
  success boolean,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Shared visibility helper used by RLS. It never exposes private message content.
create or replace function public.social_can_view_post(
  post_author uuid,
  post_visibility text,
  post_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() = post_author
    or (
      not public.social_users_blocked(auth.uid(), post_author)
      and (
        post_visibility = 'public'
        or (
          post_visibility = 'followers'
          and exists (
            select 1 from public.user_follows f
            where f.follower_user_id = auth.uid()
              and f.followed_user_id = post_author
          )
        )
        or (
          post_visibility = 'group'
          and exists (
            select 1 from public.investment_group_members gm
            where gm.group_id = post_group_id
              and gm.user_id = auth.uid()
              and gm.status = 'active'
          )
        )
      )
    );
$$;

revoke all on function public.social_can_view_post(uuid, text, uuid) from public;
grant execute on function public.social_can_view_post(uuid, text, uuid) to authenticated, service_role;

create or replace function public.social_is_conversation_member(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation
      and cm.user_id = auth.uid()
      and cm.left_at is null
  );
$$;

revoke all on function public.social_is_conversation_member(uuid) from public;
grant execute on function public.social_is_conversation_member(uuid) to authenticated, service_role;

-- Replace permissive foundation policies with block-, privacy-, and membership-aware policies.
alter table public.profile_specialties enable row level security;
alter table public.profile_links enable row level security;
alter table public.profile_privacy_settings enable row level security;
alter table public.social_follow_requests enable row level security;
alter table public.user_blocks enable row level security;
alter table public.user_mutes enable row level security;
alter table public.social_post_media enable row level security;
alter table public.social_post_symbols enable row level security;
alter table public.social_mentions enable row level security;
alter table public.social_post_attachments enable row level security;
alter table public.social_post_edits enable row level security;
alter table public.social_reactions enable row level security;
alter table public.social_comments enable row level security;
alter table public.social_comment_reactions enable row level security;
alter table public.social_comment_edits enable row level security;
alter table public.social_reposts enable row level security;
alter table public.social_saved_collections enable row level security;
alter table public.social_saved_posts enable row level security;
alter table public.social_hidden_posts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.message_requests enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.message_reads enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.content_reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.social_account_restrictions enable row level security;
alter table public.social_rate_limit_events enable row level security;
alter table public.professional_network_product_events enable row level security;

drop policy if exists profiles_extended_select_public on public.profiles_extended;
drop policy if exists profiles_extended_select_visible on public.profiles_extended;
create policy profiles_extended_select_visible on public.profiles_extended for select using (
  deleted_at is null and (
    auth.uid() = user_id
    or (
      not public.social_users_blocked(auth.uid(), user_id)
      and (
        profile_visibility = 'public'
        or (profile_visibility = 'followers' and exists (
          select 1 from public.user_follows f
          where f.follower_user_id = auth.uid() and f.followed_user_id = user_id
        ))
      )
    )
  )
);

drop policy if exists profile_posts_select_visible on public.profile_posts;
create policy profile_posts_select_visible on public.profile_posts for select using (
  deleted_at is null and status = 'published'
  and public.social_can_view_post(user_id, visibility, investment_group_id)
);

drop policy if exists profile_specialties_select_visible on public.profile_specialties;
create policy profile_specialties_select_visible on public.profile_specialties for select using (
  exists (select 1 from public.profiles_extended p where p.user_id = profile_specialties.user_id)
);
drop policy if exists profile_specialties_owner_all on public.profile_specialties;
create policy profile_specialties_owner_all on public.profile_specialties for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists profile_links_select_visible on public.profile_links;
create policy profile_links_select_visible on public.profile_links for select using (
  exists (select 1 from public.profiles_extended p where p.user_id = profile_links.user_id)
);
drop policy if exists profile_links_owner_all on public.profile_links;
create policy profile_links_owner_all on public.profile_links for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists profile_privacy_owner on public.profile_privacy_settings;
create policy profile_privacy_owner on public.profile_privacy_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists social_follow_requests_related on public.social_follow_requests;
create policy social_follow_requests_related on public.social_follow_requests for select
  using (auth.uid() in (requester_user_id, target_user_id));
drop policy if exists social_follow_requests_requester_insert on public.social_follow_requests;
create policy social_follow_requests_requester_insert on public.social_follow_requests for insert
  with check (auth.uid() = requester_user_id and not public.social_users_blocked(requester_user_id, target_user_id));
drop policy if exists social_follow_requests_related_update on public.social_follow_requests;
create policy social_follow_requests_related_update on public.social_follow_requests for update
  using (auth.uid() in (requester_user_id, target_user_id));

drop policy if exists user_blocks_owner on public.user_blocks;
create policy user_blocks_owner on public.user_blocks for all
  using (auth.uid() = blocker_user_id) with check (auth.uid() = blocker_user_id);
drop policy if exists user_mutes_owner on public.user_mutes;
create policy user_mutes_owner on public.user_mutes for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists user_follows_select_public on public.user_follows;
drop policy if exists user_follows_select_related on public.user_follows;
create policy user_follows_select_related on public.user_follows for select using (
  auth.uid() in (follower_user_id, followed_user_id)
  and not public.social_users_blocked(follower_user_id, followed_user_id)
);
drop policy if exists user_follows_insert_own on public.user_follows;
create policy user_follows_insert_own on public.user_follows for insert with check (
  auth.uid() = follower_user_id
  and not public.social_users_blocked(follower_user_id, followed_user_id)
);

drop policy if exists social_post_media_visible on public.social_post_media;
create policy social_post_media_visible on public.social_post_media for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_post_media_owner_all on public.social_post_media;
create policy social_post_media_owner_all on public.social_post_media for all
  using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);

drop policy if exists social_post_symbols_visible on public.social_post_symbols;
create policy social_post_symbols_visible on public.social_post_symbols for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_post_symbols_owner_write on public.social_post_symbols;
create policy social_post_symbols_owner_write on public.social_post_symbols for all using (
  exists (select 1 from public.profile_posts p where p.id = post_id and p.user_id = auth.uid())
) with check (
  exists (select 1 from public.profile_posts p where p.id = post_id and p.user_id = auth.uid())
);

drop policy if exists social_mentions_related_select on public.social_mentions;
create policy social_mentions_related_select on public.social_mentions for select using (
  auth.uid() in (actor_user_id, mentioned_user_id)
  and exists (select 1 from public.profile_posts p where p.id = post_id)
);

drop policy if exists social_post_attachments_visible on public.social_post_attachments;
create policy social_post_attachments_visible on public.social_post_attachments for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_post_attachments_owner_write on public.social_post_attachments;
create policy social_post_attachments_owner_write on public.social_post_attachments for all using (
  exists (select 1 from public.profile_posts p where p.id = post_id and p.user_id = auth.uid())
) with check (
  exists (select 1 from public.profile_posts p where p.id = post_id and p.user_id = auth.uid())
);

drop policy if exists social_post_edits_owner_select on public.social_post_edits;
create policy social_post_edits_owner_select on public.social_post_edits for select using (
  editor_user_id = auth.uid() or exists (
    select 1 from public.profile_posts p where p.id = post_id and p.user_id = auth.uid()
  )
);

drop policy if exists social_reactions_visible on public.social_reactions;
create policy social_reactions_visible on public.social_reactions for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_reactions_owner_all on public.social_reactions;
create policy social_reactions_owner_all on public.social_reactions for all
  using (auth.uid() = user_id) with check (
    auth.uid() = user_id and exists (select 1 from public.profile_posts p where p.id = post_id)
  );

drop policy if exists social_comments_visible on public.social_comments;
create policy social_comments_visible on public.social_comments for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_comments_owner_insert on public.social_comments;
create policy social_comments_owner_insert on public.social_comments for insert with check (
  auth.uid() = author_user_id and exists (
    select 1 from public.profile_posts p where p.id = post_id and p.comments_enabled
  )
);
drop policy if exists social_comments_owner_update on public.social_comments;
create policy social_comments_owner_update on public.social_comments for update
  using (auth.uid() = author_user_id) with check (auth.uid() = author_user_id);

drop policy if exists social_comment_reactions_visible on public.social_comment_reactions;
create policy social_comment_reactions_visible on public.social_comment_reactions for select using (
  exists (select 1 from public.social_comments c where c.id = comment_id)
);
drop policy if exists social_comment_reactions_owner_all on public.social_comment_reactions;
create policy social_comment_reactions_owner_all on public.social_comment_reactions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists social_comment_edits_owner_select on public.social_comment_edits;
create policy social_comment_edits_owner_select on public.social_comment_edits for select using (
  auth.uid() = editor_user_id
);

drop policy if exists social_reposts_visible on public.social_reposts;
create policy social_reposts_visible on public.social_reposts for select using (
  exists (select 1 from public.profile_posts p where p.id = post_id)
);
drop policy if exists social_reposts_owner_all on public.social_reposts;
create policy social_reposts_owner_all on public.social_reposts for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists social_saved_collections_owner on public.social_saved_collections;
create policy social_saved_collections_owner on public.social_saved_collections for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists social_saved_posts_owner on public.social_saved_posts;
create policy social_saved_posts_owner on public.social_saved_posts for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists social_hidden_posts_owner on public.social_hidden_posts;
create policy social_hidden_posts_owner on public.social_hidden_posts for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists conversations_members_select on public.conversations;
create policy conversations_members_select on public.conversations for select
  using (public.social_is_conversation_member(id));
drop policy if exists conversations_creator_insert on public.conversations;
create policy conversations_creator_insert on public.conversations for insert
  with check (auth.uid() = created_by);
drop policy if exists conversations_members_update on public.conversations;
create policy conversations_members_update on public.conversations for update
  using (public.social_is_conversation_member(id));

drop policy if exists conversation_members_related on public.conversation_members;
create policy conversation_members_related on public.conversation_members for select
  using (public.social_is_conversation_member(conversation_id));
drop policy if exists conversation_members_self_update on public.conversation_members;
create policy conversation_members_self_update on public.conversation_members for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists message_requests_related on public.message_requests;
create policy message_requests_related on public.message_requests for select
  using (auth.uid() in (sender_user_id, recipient_user_id));
drop policy if exists message_requests_sender_insert on public.message_requests;
create policy message_requests_sender_insert on public.message_requests for insert
  with check (auth.uid() = sender_user_id and not public.social_users_blocked(sender_user_id, recipient_user_id));
drop policy if exists message_requests_recipient_update on public.message_requests;
create policy message_requests_recipient_update on public.message_requests for update
  using (auth.uid() = recipient_user_id);

drop policy if exists messages_members_select on public.messages;
create policy messages_members_select on public.messages for select
  using (public.social_is_conversation_member(conversation_id));
drop policy if exists messages_sender_insert on public.messages;
create policy messages_sender_insert on public.messages for insert with check (
  auth.uid() = sender_user_id and public.social_is_conversation_member(conversation_id)
);
drop policy if exists messages_sender_update on public.messages;
create policy messages_sender_update on public.messages for update
  using (auth.uid() = sender_user_id) with check (auth.uid() = sender_user_id);

drop policy if exists message_attachments_members_select on public.message_attachments;
create policy message_attachments_members_select on public.message_attachments for select using (
  exists (select 1 from public.messages m where m.id = message_id and public.social_is_conversation_member(m.conversation_id))
);
drop policy if exists message_attachments_owner_all on public.message_attachments;
create policy message_attachments_owner_all on public.message_attachments for all
  using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);

drop policy if exists message_reads_owner on public.message_reads;
create policy message_reads_owner on public.message_reads for all
  using (auth.uid() = user_id) with check (
    auth.uid() = user_id and public.social_is_conversation_member(conversation_id)
  );

drop policy if exists notification_preferences_owner on public.notification_preferences;
create policy notification_preferences_owner on public.notification_preferences for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists content_reports_reporter_insert on public.content_reports;
create policy content_reports_reporter_insert on public.content_reports for insert
  with check (auth.uid() = reporter_user_id);
drop policy if exists content_reports_reporter_select on public.content_reports;
create policy content_reports_reporter_select on public.content_reports for select
  using (auth.uid() = reporter_user_id);

-- No direct client access to moderation, rate-limit, or observability records.
-- Service-role routes remain the authoritative writers/readers.

drop trigger if exists trg_profile_links_updated_at on public.profile_links;
create trigger trg_profile_links_updated_at before update on public.profile_links
for each row execute function public.bt_set_updated_at();
drop trigger if exists trg_profile_privacy_updated_at on public.profile_privacy_settings;
create trigger trg_profile_privacy_updated_at before update on public.profile_privacy_settings
for each row execute function public.bt_set_updated_at();
drop trigger if exists trg_social_reactions_updated_at on public.social_reactions;
create trigger trg_social_reactions_updated_at before update on public.social_reactions
for each row execute function public.bt_set_updated_at();
drop trigger if exists trg_social_comments_updated_at on public.social_comments;
create trigger trg_social_comments_updated_at before update on public.social_comments
for each row execute function public.bt_set_updated_at();
drop trigger if exists trg_conversations_updated_at on public.conversations;
create trigger trg_conversations_updated_at before update on public.conversations
for each row execute function public.bt_set_updated_at();
drop trigger if exists trg_messages_updated_at on public.messages;
create trigger trg_messages_updated_at before update on public.messages
for each row execute function public.bt_set_updated_at();

-- Private object storage. API routes issue short-lived signed upload/read URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'professional-media',
  'professional-media',
  false,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists professional_media_insert_owned on storage.objects;
create policy professional_media_insert_owned on storage.objects for insert to authenticated
with check (
  bucket_id = 'professional-media'
  and (
    ((storage.foldername(name))[1] in ('profiles', 'posts', 'groups') and (storage.foldername(name))[2] = auth.uid()::text)
    or (
      (storage.foldername(name))[1] = 'messages'
      and public.social_is_conversation_member(((storage.foldername(name))[2])::uuid)
    )
  )
);

drop policy if exists professional_media_select_authorized on storage.objects;
create policy professional_media_select_authorized on storage.objects for select to authenticated
using (
  bucket_id = 'professional-media'
  and (
    ((storage.foldername(name))[1] = 'profiles' and exists (
      select 1 from public.profiles_extended p where p.user_id::text = (storage.foldername(name))[2]
    ))
    or ((storage.foldername(name))[1] = 'posts' and exists (
      select 1 from public.social_post_media pm
      join public.profile_posts p on p.id = pm.post_id
      where pm.storage_path = name
    ))
    or ((storage.foldername(name))[1] = 'messages' and public.social_is_conversation_member(((storage.foldername(name))[2])::uuid))
    or ((storage.foldername(name))[1] = 'groups' and exists (
      select 1 from public.investment_groups g
      where g.owner_user_id::text = (storage.foldername(name))[2]
        and (g.visibility = 'public' or g.owner_user_id = auth.uid())
    ))
  )
);

drop policy if exists professional_media_update_owned on storage.objects;
create policy professional_media_update_owned on storage.objects for update to authenticated
using (bucket_id = 'professional-media' and owner_id = auth.uid()::text)
with check (bucket_id = 'professional-media' and owner_id = auth.uid()::text);

drop policy if exists professional_media_delete_owned on storage.objects;
create policy professional_media_delete_owned on storage.objects for delete to authenticated
using (bucket_id = 'professional-media' and owner_id = auth.uid()::text);

-- Realtime is scoped by table RLS and clients must subscribe only to active conversations/users.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.message_reads;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.notification_events;
exception when duplicate_object then null;
end $$;

commit;
