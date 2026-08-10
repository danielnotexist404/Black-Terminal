begin;

-- Google OAuth users arrive with provider metadata instead of the legacy
-- username/display_name fields. Keep auth.users as the identity authority and
-- provision the smallest viable Black Terminal profile automatically.
create or replace function public.black_terminal_create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text;
  resolved_display_name text;
  resolved_first_name text;
  resolved_last_name text;
begin
  resolved_display_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    split_part(new.email, '@', 1),
    'Black Terminal User'
  );
  resolved_first_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'given_name', ''),
    nullif(split_part(resolved_display_name, ' ', 1), '')
  );
  resolved_last_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'family_name', ''),
    nullif(trim(substr(resolved_display_name, length(split_part(resolved_display_name, ' ', 1)) + 1)), '')
  );

  -- Auth updates must enrich the existing profile, never create a second row.
  update public.bt_users
  set email = coalesce(new.email, bt_users.email),
      display_name = coalesce(nullif(bt_users.display_name, ''), resolved_display_name),
      first_name = coalesce(nullif(bt_users.first_name, ''), resolved_first_name),
      last_name = coalesce(nullif(bt_users.last_name, ''), resolved_last_name),
      email_verified = new.email_confirmed_at is not null
  where auth_user_id = new.id;
  if found then return new; end if;

  desired_username := lower(regexp_replace(
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
      split_part(new.email, '@', 1),
      'user'
    ),
    '[^a-zA-Z0-9_-]', '', 'g'
  ));
  if length(desired_username) < 3 then
    desired_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  if exists (select 1 from public.bt_users where username = desired_username) then
    desired_username := left(desired_username, 48) || '_' || substr(new.id::text, 1, 8);
  end if;

  insert into public.bt_users (
    username, email, role, status, auth_user_id, display_name,
    first_name, last_name, email_verified, product_tier, permissions
  ) values (
    desired_username, new.email, 'user', 'offline', new.id, resolved_display_name,
    resolved_first_name, resolved_last_name, new.email_confirmed_at is not null,
    'retail', '[]'::jsonb
  )
  on conflict (username) do update
  set email = excluded.email,
      display_name = coalesce(nullif(public.bt_users.display_name, ''), excluded.display_name),
      first_name = coalesce(nullif(public.bt_users.first_name, ''), excluded.first_name),
      last_name = coalesce(nullif(public.bt_users.last_name, ''), excluded.last_name),
      email_verified = excluded.email_verified
  where public.bt_users.auth_user_id = excluded.auth_user_id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_black_terminal on auth.users;
create trigger on_auth_user_created_black_terminal
after insert or update of email_confirmed_at, raw_user_meta_data on auth.users
for each row execute function public.black_terminal_create_profile();

commit;
