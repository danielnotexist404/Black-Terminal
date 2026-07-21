


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."bt_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."bt_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_hyperliquid_nonce"("p_user_id" "uuid", "p_credential_id" "uuid", "p_agent_wallet_address" "text", "p_network" "text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_next bigint;
begin
  if p_network not in ('mainnet','testnet') then
    raise exception 'invalid hyperliquid network';
  end if;

  insert into public.hyperliquid_nonce_state (
    user_id,
    credential_id,
    agent_wallet_address,
    network,
    last_nonce,
    updated_at
  )
  values (
    p_user_id,
    p_credential_id,
    lower(p_agent_wallet_address),
    p_network,
    v_now,
    now()
  )
  on conflict (agent_wallet_address, network)
  do update set
    user_id = excluded.user_id,
    credential_id = excluded.credential_id,
    last_nonce = greatest(public.hyperliquid_nonce_state.last_nonce + 1, floor(extract(epoch from clock_timestamp()) * 1000)::bigint),
    updated_at = now()
  returning last_nonce into v_next;

  return v_next;
end;
$$;


ALTER FUNCTION "public"."next_hyperliquid_nonce"("p_user_id" "uuid", "p_credential_id" "uuid", "p_agent_wallet_address" "text", "p_network" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = target_conversation
      and cm.user_id = auth.uid()
      and cm.left_at is null
  );
$$;


ALTER FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) RETURNS TABLE("conversation_id" "uuid", "created" boolean, "request_pending" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_user_id = first_user and b.blocked_user_id = second_user)
       or (b.blocker_user_id = second_user and b.blocked_user_id = first_user)
  );
$$;


ALTER FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."account_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "asset" character varying(20) NOT NULL,
    "free" numeric(24,8) DEFAULT 0.00000000,
    "locked" numeric(24,8) DEFAULT 0.00000000,
    "total" numeric(24,8) DEFAULT 0.00000000,
    "usd_value" numeric(18,2),
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."account_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account_id" "uuid" NOT NULL,
    "exchange" character varying(50) NOT NULL,
    "symbol" character varying(50) NOT NULL,
    "direction" character varying(10) NOT NULL,
    "quantity" numeric(24,8) DEFAULT 0.00000000,
    "average_price" numeric(24,8),
    "current_price" numeric(24,8),
    "unrealized_pnl" numeric(18,4) DEFAULT 0.0000,
    "realized_pnl" numeric(18,4) DEFAULT 0.0000,
    "margin" numeric(18,4) DEFAULT 0.0000,
    "leverage" numeric(10,2) DEFAULT 1.00,
    "liquidation_price" numeric(24,8),
    "stop_loss" numeric(24,8),
    "take_profit" numeric(24,8),
    "opened_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."account_positions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_risk_controls" (
    "account_id" "uuid" NOT NULL,
    "max_leverage" numeric DEFAULT 5 NOT NULL,
    "max_position_usd" numeric DEFAULT 25000 NOT NULL,
    "max_daily_loss_usd" numeric DEFAULT 2500 NOT NULL,
    "max_portfolio_exposure_usd" numeric DEFAULT 100000 NOT NULL,
    "allowed_symbols" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "read_only_mode" boolean DEFAULT true NOT NULL,
    "trading_enabled" boolean DEFAULT false NOT NULL,
    "emergency_stop" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."account_risk_controls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."adapter_certifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "category" "text" NOT NULL,
    "execution_mode" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "readiness" "text" NOT NULL,
    "implementation_status" "text" NOT NULL,
    "market_data_ready" boolean DEFAULT false NOT NULL,
    "auth_ready" boolean DEFAULT false NOT NULL,
    "account_read_ready" boolean DEFAULT false NOT NULL,
    "balances_ready" boolean DEFAULT false NOT NULL,
    "positions_ready" boolean DEFAULT false NOT NULL,
    "open_orders_ready" boolean DEFAULT false NOT NULL,
    "fills_ready" boolean DEFAULT false NOT NULL,
    "private_streams_ready" boolean DEFAULT false NOT NULL,
    "market_order_certified" boolean DEFAULT false NOT NULL,
    "limit_order_certified" boolean DEFAULT false NOT NULL,
    "cancel_certified" boolean DEFAULT false NOT NULL,
    "modify_certified" boolean DEFAULT false NOT NULL,
    "tpsl_certified" boolean DEFAULT false NOT NULL,
    "reconnect_certified" boolean DEFAULT false NOT NULL,
    "mainnet_validated" boolean DEFAULT false NOT NULL,
    "supported_products" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "supported_order_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "capabilities" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "limitations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_validated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "adapter_certifications_category_check" CHECK (("category" = ANY (ARRAY['centralized-exchange'::"text", 'protocol'::"text", 'wallet'::"text", 'market-data'::"text", 'institutional'::"text"]))),
    CONSTRAINT "adapter_certifications_execution_mode_check" CHECK (("execution_mode" = ANY (ARRAY['full-live'::"text", 'read-only'::"text", 'market-data-only'::"text", 'signer-only'::"text", 'unavailable'::"text"]))),
    CONSTRAINT "adapter_certifications_implementation_status_check" CHECK (("implementation_status" = ANY (ARRAY['implemented'::"text", 'partial'::"text", 'market-data-only'::"text", 'signer-only'::"text", 'blocked'::"text", 'deferred'::"text"]))),
    CONSTRAINT "adapter_certifications_network_check" CHECK (("network" = ANY (ARRAY['mainnet'::"text", 'sandbox'::"text", 'testnet'::"text", 'unsupported'::"text"]))),
    CONSTRAINT "adapter_certifications_readiness_check" CHECK (("readiness" = ANY (ARRAY['disconnected'::"text", 'authenticating'::"text", 'connected'::"text", 'synchronizing'::"text", 'connected-read-only'::"text", 'execution-blocked'::"text", 'execution-ready'::"text", 'degraded'::"text", 'reconnecting'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."adapter_certifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bt_audit_logs" (
    "id" bigint NOT NULL,
    "timestamp" "text" NOT NULL,
    "tag" "text" NOT NULL,
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."bt_audit_logs" OWNER TO "postgres";


ALTER TABLE "public"."bt_audit_logs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."bt_audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bt_users" (
    "username" "text" NOT NULL,
    "email" "text" NOT NULL,
    "password" "text" NOT NULL,
    "role" "text" NOT NULL,
    "status" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "last_login" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "allowed_indicators" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "active_indicators" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "workspaces" "jsonb" DEFAULT '["Quant Desk", "Scalp Layout", "Strategy Lab"]'::"jsonb",
    "workspace_snapshots" "jsonb" DEFAULT '{}'::"jsonb",
    "active_workspace" "text" DEFAULT 'Quant Desk'::"text",
    "alerts" "jsonb" DEFAULT '[]'::"jsonb",
    "scripts" "jsonb" DEFAULT '[]'::"jsonb",
    "alert_event_logs" "jsonb" DEFAULT '[]'::"jsonb",
    "ip" "text",
    "country_code" "text",
    "country_name" "text",
    "first_name" "text",
    "last_name" "text",
    "organization" "text",
    "billing_address" "text",
    "purpose_of_use" "text" DEFAULT 'personal'::"text",
    "phone" "text",
    "newsletter_opt_in" boolean DEFAULT false,
    "referred_by" "text",
    "email_verified" boolean DEFAULT false,
    "ai_messages_count" integer DEFAULT 0,
    "ai_last_message_timestamp" "text" DEFAULT ''::"text",
    "display_name" "text",
    CONSTRAINT "bt_users_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'user'::"text"]))),
    CONSTRAINT "bt_users_status_check" CHECK (("status" = ANY (ARRAY['online'::"text", 'offline'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."bt_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connection_health_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "account_id" "uuid",
    "venue_id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "category" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "readiness" "text" NOT NULL,
    "execution_mode" "text" NOT NULL,
    "public_stream" "text",
    "private_stream" "text",
    "authentication" "text",
    "synchronization" "text",
    "latency_ms" integer DEFAULT 0 NOT NULL,
    "reconnect_count" integer DEFAULT 0 NOT NULL,
    "clock_skew_ms" integer,
    "metadata_freshness_ms" integer,
    "rate_limit_usage" "text",
    "last_error" "text",
    "health" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."connection_health_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connectivity_audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "connection_key" "text",
    "account_id" "uuid",
    "event_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "connectivity_audit_events_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."connectivity_audit_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connectivity_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connection_key" "text" NOT NULL,
    "category" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "label" "text" NOT NULL,
    "status" "text" DEFAULT 'connected'::"text" NOT NULL,
    "account_id" "uuid",
    "wallet_address" "text",
    "capabilities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "health" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "permissions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_heartbeat_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "connectivity_connections_category_check" CHECK (("category" = ANY (ARRAY['centralized-exchange'::"text", 'wallet'::"text", 'protocol'::"text", 'market-data'::"text", 'institutional'::"text"])))
);


ALTER TABLE "public"."connectivity_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."content_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_user_id" "uuid" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "details" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "assigned_to" "uuid",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "content_reports_reason_check" CHECK (("reason" = ANY (ARRAY['spam'::"text", 'harassment'::"text", 'impersonation'::"text", 'misleading_performance_claims'::"text", 'scam'::"text", 'market_manipulation'::"text", 'copyright_violation'::"text", 'sensitive_information'::"text", 'other'::"text", 'misleading_financial_claim'::"text", 'copyright'::"text", 'private_information'::"text"]))),
    CONSTRAINT "content_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewing'::"text", 'resolved'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "content_reports_target_type_check" CHECK (("target_type" = ANY (ARRAY['post'::"text", 'comment'::"text", 'profile'::"text", 'message'::"text", 'group'::"text"])))
);


ALTER TABLE "public"."content_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_members" (
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "archived_at" timestamp with time zone,
    "muted_until" timestamp with time zone,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone,
    CONSTRAINT "conversation_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'moderator'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."conversation_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_type" "text" DEFAULT 'direct'::"text" NOT NULL,
    "direct_key" "text",
    "title" "text",
    "created_by" "uuid" NOT NULL,
    "last_message_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversations_conversation_type_check" CHECK (("conversation_type" = ANY (ARRAY['direct'::"text", 'group'::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dex_wallet_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "wallet_provider" "text" NOT NULL,
    "wallet_address" "text" NOT NULL,
    "chain" "text" NOT NULL,
    "dex_venue" "text" NOT NULL,
    "status" "text" DEFAULT 'connected'::"text" NOT NULL,
    "label" "text",
    "last_seen_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dex_wallet_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exchange_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "exchange" "text" NOT NULL,
    "account_name" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "api_health" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "latency_ms" integer DEFAULT 0,
    "permissions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "is_read_only" boolean DEFAULT true NOT NULL,
    "trading_enabled" boolean DEFAULT false NOT NULL,
    "credential_ref" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone,
    "last_sync_error" "text",
    "execution_mode" "text" DEFAULT 'read_only'::"text" NOT NULL,
    CONSTRAINT "exchange_accounts_execution_mode_check" CHECK (("execution_mode" = ANY (ARRAY['read_only'::"text", 'paper'::"text", 'testnet'::"text", 'live'::"text"])))
);


ALTER TABLE "public"."exchange_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exchange_credentials" (
    "account_id" "uuid" NOT NULL,
    "encrypted_payload" "text" NOT NULL,
    "key_version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."exchange_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."execution_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "order_id" "uuid",
    "event_type" character varying(100) NOT NULL,
    "severity" character varying(20) DEFAULT 'info'::character varying,
    "message" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."execution_audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."execution_fills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "exchange" "text" NOT NULL,
    "exchange_order_id" "text",
    "exchange_fill_id" "text",
    "symbol" "text" NOT NULL,
    "side" "text" NOT NULL,
    "price" numeric NOT NULL,
    "quantity" numeric NOT NULL,
    "fee" numeric DEFAULT 0 NOT NULL,
    "fee_asset" "text",
    "liquidity" "text",
    "filled_at" timestamp with time zone NOT NULL,
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."execution_fills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."execution_order_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "exchange" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "previous_status" "text",
    "next_status" "text",
    "message" "text",
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."execution_order_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."execution_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "exchange" character varying(50) NOT NULL,
    "symbol" character varying(50) NOT NULL,
    "side" character varying(10) NOT NULL,
    "order_type" character varying(20) NOT NULL,
    "quantity" numeric(24,8) NOT NULL,
    "quantity_mode" character varying(20) DEFAULT 'quantity'::character varying,
    "limit_price" numeric(24,8),
    "stop_price" numeric(24,8),
    "take_profit" numeric(24,8),
    "stop_loss" numeric(24,8),
    "post_only" boolean DEFAULT false,
    "reduce_only" boolean DEFAULT false,
    "time_in_force" character varying(10) DEFAULT 'gtc'::character varying,
    "status" character varying(20) NOT NULL,
    "filled_quantity" numeric(24,8) DEFAULT 0.00000000,
    "rejection_reason" "text",
    "estimated_fees" numeric(18,4) DEFAULT 0.0000,
    "estimated_margin" numeric(18,4) DEFAULT 0.0000,
    "estimated_slippage" numeric(18,4) DEFAULT 0.0000,
    "risk_check_status" character varying(20) DEFAULT 'approved'::character varying,
    "risk_check_reasons" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."execution_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hyperliquid_account_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "credential_id" "uuid",
    "network" "text" NOT NULL,
    "master_wallet_address" "text" NOT NULL,
    "margin_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "cross_margin_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "positions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "open_orders" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "fills" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hyperliquid_account_snapshots_network_check" CHECK (("network" = ANY (ARRAY['mainnet'::"text", 'testnet'::"text"])))
);


ALTER TABLE "public"."hyperliquid_account_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hyperliquid_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "master_wallet_address" "text" NOT NULL,
    "agent_wallet_address" "text" NOT NULL,
    "encrypted_agent_private_key" "text" NOT NULL,
    "network" "text" NOT NULL,
    "status" "text" DEFAULT 'pending_authorization'::"text" NOT NULL,
    "readiness_reason" "text",
    "vault_address" "text",
    "key_version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    CONSTRAINT "hyperliquid_credentials_network_check" CHECK (("network" = ANY (ARRAY['mainnet'::"text", 'testnet'::"text"]))),
    CONSTRAINT "hyperliquid_credentials_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'pending_authorization'::"text", 'rotated'::"text", 'revoked'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."hyperliquid_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hyperliquid_nonce_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "credential_id" "uuid" NOT NULL,
    "agent_wallet_address" "text" NOT NULL,
    "network" "text" NOT NULL,
    "last_nonce" bigint DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hyperliquid_nonce_state_network_check" CHECK (("network" = ANY (ARRAY['mainnet'::"text", 'testnet'::"text"])))
);


ALTER TABLE "public"."hyperliquid_nonce_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hyperliquid_order_relay_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "connection_id" "uuid",
    "credential_id" "uuid",
    "event_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "symbol" "text",
    "order_id" "text",
    "client_order_id" "text",
    "exchange_order_id" "text",
    "latency_ms" integer,
    "message" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hyperliquid_order_relay_events_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."hyperliquid_order_relay_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imm_integrity_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue" "text" NOT NULL,
    "market_kind" "text" NOT NULL,
    "symbol" "text" NOT NULL,
    "severity" "text" DEFAULT 'error'::"text" NOT NULL,
    "reason" "text" NOT NULL,
    "sequence" "text",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "imm_integrity_events_severity_check" CHECK (("severity" = ANY (ARRAY['warning'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."imm_integrity_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imm_worker_heartbeats" (
    "id" "text" NOT NULL,
    "worker_instance_id" "text" NOT NULL,
    "hostname" "text",
    "process_id" integer,
    "version" integer DEFAULT 1 NOT NULL,
    "venue" "text" NOT NULL,
    "market_kind" "text" NOT NULL,
    "symbol" "text" NOT NULL,
    "status" "text" DEFAULT 'unavailable'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "heartbeat_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_at" timestamp with time zone,
    "last_persist_at" timestamp with time zone,
    "reconnect_count" integer DEFAULT 0 NOT NULL,
    "sequence_gap_count" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "imm_worker_heartbeats_reconnect_count_check" CHECK (("reconnect_count" >= 0)),
    CONSTRAINT "imm_worker_heartbeats_sequence_gap_count_check" CHECK (("sequence_gap_count" >= 0)),
    CONSTRAINT "imm_worker_heartbeats_status_check" CHECK (("status" = ANY (ARRAY['healthy'::"text", 'degraded'::"text", 'reconnecting'::"text", 'stale'::"text", 'unavailable'::"text", 'misconfigured'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."imm_worker_heartbeats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_group_join_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "message" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "investment_group_join_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."investment_group_join_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_group_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "joined_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "investment_group_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'member'::"text"]))),
    CONSTRAINT "investment_group_members_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'pending'::"text", 'removed'::"text"])))
);


ALTER TABLE "public"."investment_group_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_group_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "investment_group_messages_channel_check" CHECK (("channel" = ANY (ARRAY['announcements'::"text", 'general'::"text", 'research'::"text", 'trades'::"text"])))
);


ALTER TABLE "public"."investment_group_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_group_moderation_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "target_user_id" "uuid",
    "message_id" "uuid",
    "reason" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "investment_group_moderation_events_action_check" CHECK (("action" = ANY (ARRAY['message_deleted'::"text", 'member_removed'::"text", 'role_changed'::"text"]))),
    CONSTRAINT "investment_group_moderation_events_reason_check" CHECK ((("char_length"(TRIM(BOTH FROM "reason")) >= 5) AND ("char_length"(TRIM(BOTH FROM "reason")) <= 500)))
);


ALTER TABLE "public"."investment_group_moderation_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_group_stats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "follower_count" integer DEFAULT 0 NOT NULL,
    "connected_equity" numeric DEFAULT 0 NOT NULL,
    "monthly_return" numeric,
    "yearly_return" numeric,
    "total_return" numeric,
    "max_drawdown" numeric,
    "current_drawdown" numeric,
    "risk_score" numeric,
    "win_rate" numeric,
    "profit_factor" numeric,
    "average_trade_duration" "text",
    "verified" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."investment_group_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "firm_name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "bio" "text" DEFAULT ''::"text" NOT NULL,
    "logo_url" "text",
    "banner_url" "text",
    "visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "access_mode" "text" DEFAULT 'approval_required'::"text" NOT NULL,
    "password_hash" "text",
    "trading_style_tags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "accepted_exchanges" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "accepted_wallets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "minimum_equity" numeric,
    "max_followers" integer,
    "approval_required" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "investment_groups_access_mode_check" CHECK (("access_mode" = ANY (ARRAY['open'::"text", 'approval_required'::"text", 'invite_only'::"text", 'password_protected'::"text"]))),
    CONSTRAINT "investment_groups_public_sections_array" CHECK (("jsonb_typeof"("public_sections") = 'array'::"text")),
    CONSTRAINT "investment_groups_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'suspended'::"text", 'archived'::"text"]))),
    CONSTRAINT "investment_groups_visibility_check" CHECK (("visibility" = ANY (ARRAY['public'::"text", 'private'::"text", 'invite_only'::"text", 'password_protected'::"text"])))
);


ALTER TABLE "public"."investment_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mainnet_validation_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "account_id" "uuid",
    "venue_id" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "symbol" "text" NOT NULL,
    "max_notional_usd" numeric,
    "requested_notional_usd" numeric,
    "validation_stage" "text" NOT NULL,
    "status" "text" NOT NULL,
    "live_confirmation" "text" DEFAULT 'required'::"text" NOT NULL,
    "order_id" "uuid",
    "exchange_order_id" "text",
    "risk_check_status" "text",
    "failure_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "mainnet_validation_records_status_check" CHECK (("status" = ANY (ARRAY['started'::"text", 'passed'::"text", 'failed'::"text", 'blocked'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."mainnet_validation_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "byte_size" bigint NOT NULL,
    "width" integer,
    "height" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "message_attachments_byte_size_check" CHECK ((("byte_size" >= 1) AND ("byte_size" <= 10485760))),
    CONSTRAINT "message_attachments_mime_type_check" CHECK (("mime_type" = ANY (ARRAY['image/jpeg'::"text", 'image/png'::"text", 'image/webp'::"text"])))
);


ALTER TABLE "public"."message_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reads" (
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "last_read_message_id" "uuid",
    "read_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "recipient_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "message_requests_check" CHECK (("sender_user_id" <> "recipient_user_id")),
    CONSTRAINT "message_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."message_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "message_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "shared_object_type" "text",
    "shared_object_id" "uuid",
    "client_message_id" "text",
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "messages_body_check" CHECK (("char_length"("body") <= 8000)),
    CONSTRAINT "messages_check" CHECK ((("body" <> ''::"text") OR ("shared_object_id" IS NOT NULL) OR ("message_type" = 'image'::"text"))),
    CONSTRAINT "messages_message_type_check" CHECK (("message_type" = ANY (ARRAY['text'::"text", 'image'::"text", 'post'::"text", 'profile'::"text", 'indicator'::"text", 'strategy'::"text", 'group'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moderation_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid",
    "moderator_user_id" "uuid" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "moderation_actions_action_check" CHECK (("action" = ANY (ARRAY['none'::"text", 'hide'::"text", 'remove'::"text", 'warn'::"text", 'restrict'::"text", 'suspend'::"text"])))
);


ALTER TABLE "public"."moderation_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_user_id" "uuid",
    "post_id" "uuid",
    "comment_id" "uuid",
    "conversation_id" "uuid",
    "group_id" "uuid",
    "deep_link" "text",
    "grouping_key" "text",
    "group_count" integer DEFAULT 1 NOT NULL,
    "last_event_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "user_id" "uuid" NOT NULL,
    "follows" boolean DEFAULT true NOT NULL,
    "reactions" boolean DEFAULT true NOT NULL,
    "comments" boolean DEFAULT true NOT NULL,
    "reposts" boolean DEFAULT true NOT NULL,
    "messages" boolean DEFAULT true NOT NULL,
    "mentions" boolean DEFAULT true NOT NULL,
    "group_activity" boolean DEFAULT true NOT NULL,
    "indicator_updates" boolean DEFAULT true NOT NULL,
    "email_digest" "text" DEFAULT 'off'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notification_preferences_email_digest_check" CHECK (("email_digest" = ANY (ARRAY['off'::"text", 'daily'::"text", 'weekly'::"text"])))
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_diagnostics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "source" "text" NOT NULL,
    "metric_name" "text" NOT NULL,
    "metric_value" numeric NOT NULL,
    "metric_unit" "text" DEFAULT 'count'::"text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "tags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_diagnostics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."position_lifecycle_positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid",
    "connection_id" "uuid",
    "exchange" "text" NOT NULL,
    "symbol" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "lifecycle_state" "text" DEFAULT 'open'::"text" NOT NULL,
    "quantity" numeric DEFAULT 0 NOT NULL,
    "average_price" numeric DEFAULT 0 NOT NULL,
    "current_price" numeric DEFAULT 0 NOT NULL,
    "realized_pnl" numeric DEFAULT 0 NOT NULL,
    "unrealized_pnl" numeric DEFAULT 0 NOT NULL,
    "margin" numeric DEFAULT 0 NOT NULL,
    "leverage" numeric DEFAULT 1 NOT NULL,
    "liquidation_price" numeric,
    "health" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "notes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source_order_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "position_lifecycle_positions_direction_check" CHECK (("direction" = ANY (ARRAY['long'::"text", 'short'::"text"]))),
    CONSTRAINT "position_lifecycle_positions_lifecycle_state_check" CHECK (("lifecycle_state" = ANY (ARRAY['opening'::"text", 'open'::"text", 'protected'::"text", 'scaling'::"text", 'closing'::"text", 'closed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."position_lifecycle_positions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."position_protection_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "position_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "price" numeric,
    "trail_by" numeric,
    "trail_mode" "text",
    "activation" "text",
    "activation_price" numeric,
    "exchange_order_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "position_protection_orders_activation_check" CHECK (("activation" = ANY (ARRAY['immediate'::"text", 'custom-price'::"text", 'offset'::"text"]))),
    CONSTRAINT "position_protection_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'modifying'::"text", 'cancelled'::"text", 'triggered'::"text", 'failed'::"text"]))),
    CONSTRAINT "position_protection_orders_trail_mode_check" CHECK (("trail_mode" = ANY (ARRAY['percentage'::"text", 'usd'::"text", 'ticks'::"text", 'atr'::"text"]))),
    CONSTRAINT "position_protection_orders_type_check" CHECK (("type" = ANY (ARRAY['take-profit'::"text", 'stop-loss'::"text", 'trailing-stop'::"text", 'break-even'::"text", 'oco'::"text"])))
);


ALTER TABLE "public"."position_protection_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."position_timeline_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "position_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "message" "text" NOT NULL,
    "price" numeric,
    "quantity" numeric,
    "order_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."position_timeline_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."professional_network_product_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "event_name" "text" NOT NULL,
    "duration_ms" integer,
    "success" boolean,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."professional_network_product_events" OWNER TO "postgres";


ALTER TABLE "public"."professional_network_product_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."professional_network_product_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profile_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_links_label_check" CHECK ((("char_length"(TRIM(BOTH FROM "label")) >= 1) AND ("char_length"(TRIM(BOTH FROM "label")) <= 40))),
    CONSTRAINT "profile_links_url_check" CHECK (("url" ~ '^https://'::"text"))
);


ALTER TABLE "public"."profile_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "post_type" "text" NOT NULL,
    "body" "text" NOT NULL,
    "symbol" "text",
    "timeframe" "text",
    "visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "summary" "text",
    "asset_class" "text",
    "directional_bias" "text",
    "risk_disclaimer" "text" DEFAULT ''::"text" NOT NULL,
    "investment_group_id" "uuid",
    "parent_post_id" "uuid",
    "quoted_post_id" "uuid",
    "status" "text" DEFAULT 'published'::"text" NOT NULL,
    "comments_enabled" boolean DEFAULT true NOT NULL,
    "idempotency_key" "text",
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "profile_posts_group_visibility" CHECK ((("visibility" <> 'group'::"text") OR ("investment_group_id" IS NOT NULL))),
    CONSTRAINT "profile_posts_post_type_check" CHECK (("post_type" = ANY (ARRAY['status'::"text", 'market_research'::"text", 'macro_research'::"text", 'quantitative_research'::"text", 'technical_analysis'::"text", 'orderflow_analysis'::"text", 'risk_commentary'::"text", 'trade_idea'::"text", 'market_opinion'::"text", 'indicator_release'::"text", 'strategy_note'::"text", 'educational_note'::"text", 'group_announcement'::"text", 'group_update'::"text", 'quote_post'::"text"]))),
    CONSTRAINT "profile_posts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'archived'::"text", 'deleted'::"text"]))),
    CONSTRAINT "profile_posts_visibility_check" CHECK (("visibility" = ANY (ARRAY['public'::"text", 'followers'::"text", 'private'::"text", 'group'::"text"])))
);


ALTER TABLE "public"."profile_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_privacy_settings" (
    "user_id" "uuid" NOT NULL,
    "profile_visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "message_policy" "text" DEFAULT 'followers'::"text" NOT NULL,
    "show_followers" boolean DEFAULT true NOT NULL,
    "show_following" boolean DEFAULT true NOT NULL,
    "show_statistics" boolean DEFAULT false NOT NULL,
    "show_positions" boolean DEFAULT false NOT NULL,
    "show_investment_groups" boolean DEFAULT true NOT NULL,
    "allow_post_mentions" boolean DEFAULT true NOT NULL,
    "allow_comment_mentions" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_privacy_settings_message_policy_check" CHECK (("message_policy" = ANY (ARRAY['everyone'::"text", 'followers'::"text", 'nobody'::"text"]))),
    CONSTRAINT "profile_privacy_settings_profile_visibility_check" CHECK (("profile_visibility" = ANY (ARRAY['public'::"text", 'followers'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."profile_privacy_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_specialties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "specialty_type" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_specialties_specialty_type_check" CHECK (("specialty_type" = ANY (ARRAY['market'::"text", 'asset_class'::"text", 'trading_style'::"text", 'methodology'::"text", 'horizon'::"text"]))),
    CONSTRAINT "profile_specialties_value_check" CHECK ((("char_length"(TRIM(BOTH FROM "value")) >= 1) AND ("char_length"(TRIM(BOTH FROM "value")) <= 80)))
);


ALTER TABLE "public"."profile_specialties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles_extended" (
    "user_id" "uuid" NOT NULL,
    "display_name" "text",
    "bio" "text" DEFAULT ''::"text" NOT NULL,
    "avatar_url" "text",
    "banner_url" "text",
    "country" "text",
    "trading_style_tags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "show_public_stats" boolean DEFAULT false NOT NULL,
    "show_public_pnl" boolean DEFAULT false NOT NULL,
    "show_public_drawdown" boolean DEFAULT false NOT NULL,
    "show_public_equity_curve" boolean DEFAULT false NOT NULL,
    "show_verified_exchange_performance" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "handle" "text" NOT NULL,
    "headline" "text" DEFAULT ''::"text" NOT NULL,
    "professional_role" "text",
    "organization" "text",
    "website_url" "text",
    "location" "text",
    "timezone" "text",
    "market_specialties" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "asset_classes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "trading_horizons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "methodology_tags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "avatar_storage_path" "text",
    "banner_storage_path" "text",
    "profile_visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "show_positions" boolean DEFAULT false NOT NULL,
    "show_groups" boolean DEFAULT true NOT NULL,
    "message_policy" "text" DEFAULT 'followers'::"text" NOT NULL,
    "verified_role" boolean DEFAULT false NOT NULL,
    "verified_performance_source" "text",
    "deleted_at" timestamp with time zone,
    CONSTRAINT "profiles_extended_asset_classes_array" CHECK (("jsonb_typeof"("asset_classes") = 'array'::"text")),
    CONSTRAINT "profiles_extended_handle_format" CHECK (("handle" ~ '^[a-z0-9_]{3,30}$'::"text")),
    CONSTRAINT "profiles_extended_market_specialties_array" CHECK (("jsonb_typeof"("market_specialties") = 'array'::"text")),
    CONSTRAINT "profiles_extended_message_policy_check" CHECK (("message_policy" = ANY (ARRAY['everyone'::"text", 'followers'::"text", 'nobody'::"text"]))),
    CONSTRAINT "profiles_extended_profile_visibility_check" CHECK (("profile_visibility" = ANY (ARRAY['public'::"text", 'followers'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."profiles_extended" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."published_indicators" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "version" "text" DEFAULT '1.0.0'::"text" NOT NULL,
    "visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "published_indicators_visibility_check" CHECK (("visibility" = ANY (ARRAY['public'::"text", 'followers'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."published_indicators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."published_strategies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "market" "text",
    "timeframe" "text",
    "risk_profile" "text" DEFAULT 'balanced'::"text" NOT NULL,
    "visibility" "text" DEFAULT 'public'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "published_strategies_risk_profile_check" CHECK (("risk_profile" = ANY (ARRAY['conservative'::"text", 'balanced'::"text", 'aggressive'::"text", 'custom'::"text"]))),
    CONSTRAINT "published_strategies_visibility_check" CHECK (("visibility" = ANY (ARRAY['public'::"text", 'followers'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."published_strategies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_account_restrictions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "scope" "text" DEFAULT 'all'::"text" NOT NULL,
    "reason" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "starts_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "lifted_at" timestamp with time zone,
    "lifted_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_account_restrictions_action_check" CHECK (("action" = ANY (ARRAY['restrict'::"text", 'suspend'::"text"]))),
    CONSTRAINT "social_account_restrictions_check" CHECK ((("expires_at" IS NULL) OR ("expires_at" > "starts_at"))),
    CONSTRAINT "social_account_restrictions_scope_check" CHECK (("scope" = ANY (ARRAY['all'::"text", 'posting'::"text", 'comments'::"text", 'engagement'::"text", 'messaging'::"text", 'media'::"text"])))
);


ALTER TABLE "public"."social_account_restrictions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_comment_edits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "comment_id" "uuid" NOT NULL,
    "editor_user_id" "uuid" NOT NULL,
    "prior_body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_comment_edits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_comment_reactions" (
    "comment_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "reaction_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_comment_reactions_reaction_type_check" CHECK (("reaction_type" = ANY (ARRAY['insightful'::"text", 'useful'::"text", 'agree'::"text"])))
);


ALTER TABLE "public"."social_comment_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "parent_comment_id" "uuid",
    "author_user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "client_comment_id" "text",
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_comments_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 4000)))
);


ALTER TABLE "public"."social_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_follow_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "requester_user_id" "uuid" NOT NULL,
    "target_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "social_follow_requests_check" CHECK (("requester_user_id" <> "target_user_id")),
    CONSTRAINT "social_follow_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'declined'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."social_follow_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_hidden_posts" (
    "user_id" "uuid" NOT NULL,
    "post_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_hidden_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_mentions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "post_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "mentioned_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_mentions_check" CHECK (("actor_user_id" <> "mentioned_user_id")),
    CONSTRAINT "social_mentions_source_type_check" CHECK (("source_type" = ANY (ARRAY['post'::"text", 'comment'::"text"])))
);


ALTER TABLE "public"."social_mentions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_post_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "attachment_type" "text" NOT NULL,
    "indicator_id" "uuid",
    "strategy_id" "uuid",
    "title" "text" NOT NULL,
    "public_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_post_attachments_attachment_type_check" CHECK (("attachment_type" = ANY (ARRAY['indicator'::"text", 'strategy'::"text", 'chart_snapshot'::"text", 'trade_idea_update'::"text"]))),
    CONSTRAINT "social_post_attachments_check" CHECK (((("attachment_type" <> 'indicator'::"text") OR ("indicator_id" IS NOT NULL)) AND (("attachment_type" <> 'strategy'::"text") OR ("strategy_id" IS NOT NULL))))
);


ALTER TABLE "public"."social_post_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_post_edits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "editor_user_id" "uuid" NOT NULL,
    "prior_title" "text",
    "prior_body" "text" NOT NULL,
    "prior_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "edit_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_post_edits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_post_media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "media_type" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "width" integer,
    "height" integer,
    "byte_size" bigint NOT NULL,
    "alt_text" "text" DEFAULT ''::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_post_media_byte_size_check" CHECK ((("byte_size" >= 1) AND ("byte_size" <= 15728640))),
    CONSTRAINT "social_post_media_height_check" CHECK ((("height" IS NULL) OR (("height" >= 1) AND ("height" <= 12000)))),
    CONSTRAINT "social_post_media_media_type_check" CHECK (("media_type" = ANY (ARRAY['image'::"text", 'chart_snapshot'::"text"]))),
    CONSTRAINT "social_post_media_mime_type_check" CHECK (("mime_type" = ANY (ARRAY['image/jpeg'::"text", 'image/png'::"text", 'image/webp'::"text"]))),
    CONSTRAINT "social_post_media_width_check" CHECK ((("width" IS NULL) OR (("width" >= 1) AND ("width" <= 12000))))
);


ALTER TABLE "public"."social_post_media" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_post_symbols" (
    "post_id" "uuid" NOT NULL,
    "symbol" "text" NOT NULL,
    "venue" "text",
    "timeframe" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_post_symbols_symbol_check" CHECK (("symbol" ~ '^[A-Z0-9._:/-]{2,30}$'::"text"))
);


ALTER TABLE "public"."social_post_symbols" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_rate_limit_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_rate_limit_events" OWNER TO "postgres";


ALTER TABLE "public"."social_rate_limit_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."social_rate_limit_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."social_reactions" (
    "post_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "reaction_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_reactions_reaction_type_check" CHECK (("reaction_type" = ANY (ARRAY['insightful'::"text", 'bullish'::"text", 'bearish'::"text", 'useful'::"text", 'high_conviction'::"text", 'well_researched'::"text"])))
);


ALTER TABLE "public"."social_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_reposts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "commentary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_reposts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_saved_collections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "social_saved_collections_name_check" CHECK ((("char_length"(TRIM(BOTH FROM "name")) >= 1) AND ("char_length"(TRIM(BOTH FROM "name")) <= 80)))
);


ALTER TABLE "public"."social_saved_collections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."social_saved_posts" (
    "user_id" "uuid" NOT NULL,
    "post_id" "uuid" NOT NULL,
    "collection_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."social_saved_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "blocker_user_id" "uuid" NOT NULL,
    "blocked_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_blocks_check" CHECK (("blocker_user_id" <> "blocked_user_id"))
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_follows" (
    "follower_user_id" "uuid" NOT NULL,
    "followed_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_follows_check" CHECK (("follower_user_id" <> "followed_user_id"))
);


ALTER TABLE "public"."user_follows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_mutes" (
    "user_id" "uuid" NOT NULL,
    "muted_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_mutes_check" CHECK (("user_id" <> "muted_user_id"))
);


ALTER TABLE "public"."user_mutes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_metadata_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "native_symbol" "text" NOT NULL,
    "canonical_base" "text" NOT NULL,
    "canonical_quote" "text" NOT NULL,
    "settlement_asset" "text",
    "market_type" "text" NOT NULL,
    "contract_type" "text",
    "expiry" timestamp with time zone,
    "contract_multiplier" numeric,
    "tick_size" numeric,
    "quantity_step" numeric,
    "min_quantity" numeric,
    "min_notional" numeric,
    "max_quantity" numeric,
    "price_precision" integer,
    "quantity_precision" integer,
    "leverage_limits" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "supported_margin_modes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "supported_time_in_force" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "supported_trigger_behavior" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "trading_status" "text",
    "raw_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "loaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone
);


ALTER TABLE "public"."venue_metadata_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_rate_limit_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "connection_id" "uuid",
    "account_id" "uuid",
    "rest_remaining" integer,
    "rest_limit" integer,
    "websocket_subscriptions" integer,
    "retry_after_ms" integer,
    "priority_lane" "text",
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "venue_rate_limit_snapshots_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'throttled'::"text", 'limited'::"text", 'blocked'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."venue_rate_limit_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_time_sync_status" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "text" NOT NULL,
    "network" "text" DEFAULT 'mainnet'::"text" NOT NULL,
    "server_time" timestamp with time zone,
    "local_time" timestamp with time zone DEFAULT "now"() NOT NULL,
    "clock_skew_ms" integer DEFAULT 0 NOT NULL,
    "request_window_ms" integer,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "last_successful_sync_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "venue_time_sync_status_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'resync-required'::"text", 'failed'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."venue_time_sync_status" OWNER TO "postgres";


ALTER TABLE ONLY "public"."account_balances"
    ADD CONSTRAINT "account_balances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_positions"
    ADD CONSTRAINT "account_positions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_risk_controls"
    ADD CONSTRAINT "account_risk_controls_pkey" PRIMARY KEY ("account_id");



ALTER TABLE ONLY "public"."adapter_certifications"
    ADD CONSTRAINT "adapter_certifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."adapter_certifications"
    ADD CONSTRAINT "adapter_certifications_venue_id_network_key" UNIQUE ("venue_id", "network");



ALTER TABLE ONLY "public"."bt_audit_logs"
    ADD CONSTRAINT "bt_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bt_users"
    ADD CONSTRAINT "bt_users_pkey" PRIMARY KEY ("username");



ALTER TABLE ONLY "public"."connection_health_snapshots"
    ADD CONSTRAINT "connection_health_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connectivity_audit_events"
    ADD CONSTRAINT "connectivity_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connectivity_connections"
    ADD CONSTRAINT "connectivity_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connectivity_connections"
    ADD CONSTRAINT "connectivity_connections_user_id_connection_key_key" UNIQUE ("user_id", "connection_key");



ALTER TABLE ONLY "public"."content_reports"
    ADD CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_members"
    ADD CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id", "user_id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dex_wallet_connections"
    ADD CONSTRAINT "dex_wallet_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dex_wallet_connections"
    ADD CONSTRAINT "dex_wallet_connections_user_id_wallet_provider_wallet_addre_key" UNIQUE ("user_id", "wallet_provider", "wallet_address", "chain", "dex_venue");



ALTER TABLE ONLY "public"."exchange_accounts"
    ADD CONSTRAINT "exchange_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exchange_credentials"
    ADD CONSTRAINT "exchange_credentials_pkey" PRIMARY KEY ("account_id");



ALTER TABLE ONLY "public"."execution_audit_logs"
    ADD CONSTRAINT "execution_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."execution_fills"
    ADD CONSTRAINT "execution_fills_exchange_exchange_fill_id_key" UNIQUE ("exchange", "exchange_fill_id");



ALTER TABLE ONLY "public"."execution_fills"
    ADD CONSTRAINT "execution_fills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."execution_order_events"
    ADD CONSTRAINT "execution_order_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."execution_orders"
    ADD CONSTRAINT "execution_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hyperliquid_account_snapshots"
    ADD CONSTRAINT "hyperliquid_account_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hyperliquid_credentials"
    ADD CONSTRAINT "hyperliquid_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hyperliquid_nonce_state"
    ADD CONSTRAINT "hyperliquid_nonce_state_agent_wallet_address_network_key" UNIQUE ("agent_wallet_address", "network");



ALTER TABLE ONLY "public"."hyperliquid_nonce_state"
    ADD CONSTRAINT "hyperliquid_nonce_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hyperliquid_order_relay_events"
    ADD CONSTRAINT "hyperliquid_order_relay_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imm_integrity_events"
    ADD CONSTRAINT "imm_integrity_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imm_worker_heartbeats"
    ADD CONSTRAINT "imm_worker_heartbeats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_group_join_requests"
    ADD CONSTRAINT "investment_group_join_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_group_members"
    ADD CONSTRAINT "investment_group_members_group_id_user_id_key" UNIQUE ("group_id", "user_id");



ALTER TABLE ONLY "public"."investment_group_members"
    ADD CONSTRAINT "investment_group_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_group_messages"
    ADD CONSTRAINT "investment_group_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_group_moderation_events"
    ADD CONSTRAINT "investment_group_moderation_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_group_stats"
    ADD CONSTRAINT "investment_group_stats_group_id_key" UNIQUE ("group_id");



ALTER TABLE ONLY "public"."investment_group_stats"
    ADD CONSTRAINT "investment_group_stats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_groups"
    ADD CONSTRAINT "investment_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_groups"
    ADD CONSTRAINT "investment_groups_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."mainnet_validation_records"
    ADD CONSTRAINT "mainnet_validation_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_message_id_storage_path_key" UNIQUE ("message_id", "storage_path");



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_pkey" PRIMARY KEY ("conversation_id", "user_id");



ALTER TABLE ONLY "public"."message_requests"
    ADD CONSTRAINT "message_requests_conversation_id_key" UNIQUE ("conversation_id");



ALTER TABLE ONLY "public"."message_requests"
    ADD CONSTRAINT "message_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_user_id_client_message_id_key" UNIQUE ("sender_user_id", "client_message_id");



ALTER TABLE ONLY "public"."moderation_actions"
    ADD CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."platform_diagnostics"
    ADD CONSTRAINT "platform_diagnostics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."position_lifecycle_positions"
    ADD CONSTRAINT "position_lifecycle_positions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."position_protection_orders"
    ADD CONSTRAINT "position_protection_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."position_timeline_events"
    ADD CONSTRAINT "position_timeline_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."professional_network_product_events"
    ADD CONSTRAINT "professional_network_product_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_links"
    ADD CONSTRAINT "profile_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_privacy_settings"
    ADD CONSTRAINT "profile_privacy_settings_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."profile_specialties"
    ADD CONSTRAINT "profile_specialties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile_specialties"
    ADD CONSTRAINT "profile_specialties_user_id_specialty_type_value_key" UNIQUE ("user_id", "specialty_type", "value");



ALTER TABLE ONLY "public"."profiles_extended"
    ADD CONSTRAINT "profiles_extended_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."published_indicators"
    ADD CONSTRAINT "published_indicators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."published_strategies"
    ADD CONSTRAINT "published_strategies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_account_restrictions"
    ADD CONSTRAINT "social_account_restrictions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_comment_edits"
    ADD CONSTRAINT "social_comment_edits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_comment_reactions"
    ADD CONSTRAINT "social_comment_reactions_pkey" PRIMARY KEY ("comment_id", "user_id");



ALTER TABLE ONLY "public"."social_comments"
    ADD CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_follow_requests"
    ADD CONSTRAINT "social_follow_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_follow_requests"
    ADD CONSTRAINT "social_follow_requests_requester_user_id_target_user_id_key" UNIQUE ("requester_user_id", "target_user_id");



ALTER TABLE ONLY "public"."social_hidden_posts"
    ADD CONSTRAINT "social_hidden_posts_pkey" PRIMARY KEY ("user_id", "post_id");



ALTER TABLE ONLY "public"."social_mentions"
    ADD CONSTRAINT "social_mentions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_mentions"
    ADD CONSTRAINT "social_mentions_source_type_source_id_mentioned_user_id_key" UNIQUE ("source_type", "source_id", "mentioned_user_id");



ALTER TABLE ONLY "public"."social_post_attachments"
    ADD CONSTRAINT "social_post_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_post_edits"
    ADD CONSTRAINT "social_post_edits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_post_media"
    ADD CONSTRAINT "social_post_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_post_media"
    ADD CONSTRAINT "social_post_media_post_id_storage_path_key" UNIQUE ("post_id", "storage_path");



ALTER TABLE ONLY "public"."social_post_symbols"
    ADD CONSTRAINT "social_post_symbols_pkey" PRIMARY KEY ("post_id", "symbol");



ALTER TABLE ONLY "public"."social_rate_limit_events"
    ADD CONSTRAINT "social_rate_limit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_reactions"
    ADD CONSTRAINT "social_reactions_pkey" PRIMARY KEY ("post_id", "user_id");



ALTER TABLE ONLY "public"."social_reposts"
    ADD CONSTRAINT "social_reposts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_reposts"
    ADD CONSTRAINT "social_reposts_post_id_user_id_key" UNIQUE ("post_id", "user_id");



ALTER TABLE ONLY "public"."social_saved_collections"
    ADD CONSTRAINT "social_saved_collections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."social_saved_collections"
    ADD CONSTRAINT "social_saved_collections_user_id_name_key" UNIQUE ("user_id", "name");



ALTER TABLE ONLY "public"."social_saved_posts"
    ADD CONSTRAINT "social_saved_posts_pkey" PRIMARY KEY ("user_id", "post_id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_user_id", "blocked_user_id");



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_pkey" PRIMARY KEY ("follower_user_id", "followed_user_id");



ALTER TABLE ONLY "public"."user_mutes"
    ADD CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("user_id", "muted_user_id");



ALTER TABLE ONLY "public"."venue_metadata_cache"
    ADD CONSTRAINT "venue_metadata_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."venue_metadata_cache"
    ADD CONSTRAINT "venue_metadata_cache_venue_id_network_native_symbol_market__key" UNIQUE ("venue_id", "network", "native_symbol", "market_type");



ALTER TABLE ONLY "public"."venue_rate_limit_snapshots"
    ADD CONSTRAINT "venue_rate_limit_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."venue_time_sync_status"
    ADD CONSTRAINT "venue_time_sync_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."venue_time_sync_status"
    ADD CONSTRAINT "venue_time_sync_status_venue_id_network_key" UNIQUE ("venue_id", "network");



CREATE INDEX "dex_wallet_connections_dex_venue_idx" ON "public"."dex_wallet_connections" USING "btree" ("dex_venue");



CREATE INDEX "dex_wallet_connections_user_id_idx" ON "public"."dex_wallet_connections" USING "btree" ("user_id");



CREATE INDEX "dex_wallet_connections_wallet_address_idx" ON "public"."dex_wallet_connections" USING "btree" ("wallet_address");



CREATE INDEX "exchange_accounts_exchange_idx" ON "public"."exchange_accounts" USING "btree" ("exchange");



CREATE INDEX "exchange_accounts_execution_mode_idx" ON "public"."exchange_accounts" USING "btree" ("execution_mode");



CREATE INDEX "exchange_accounts_last_synced_at_idx" ON "public"."exchange_accounts" USING "btree" ("last_synced_at");



CREATE INDEX "exchange_accounts_user_id_idx" ON "public"."exchange_accounts" USING "btree" ("user_id");



CREATE INDEX "execution_fills_account_id_idx" ON "public"."execution_fills" USING "btree" ("account_id");



CREATE INDEX "execution_fills_order_id_idx" ON "public"."execution_fills" USING "btree" ("order_id");



CREATE INDEX "execution_fills_user_id_idx" ON "public"."execution_fills" USING "btree" ("user_id");



CREATE INDEX "execution_order_events_order_id_idx" ON "public"."execution_order_events" USING "btree" ("order_id");



CREATE INDEX "execution_order_events_user_id_idx" ON "public"."execution_order_events" USING "btree" ("user_id");



CREATE INDEX "idx_account_balances_account" ON "public"."account_balances" USING "btree" ("account_id");



CREATE INDEX "idx_account_positions_account" ON "public"."account_positions" USING "btree" ("account_id");



CREATE INDEX "idx_adapter_certifications_mode" ON "public"."adapter_certifications" USING "btree" ("execution_mode", "implementation_status");



CREATE INDEX "idx_connection_health_snapshots_user_time" ON "public"."connection_health_snapshots" USING "btree" ("user_id", "captured_at" DESC);



CREATE INDEX "idx_connection_health_snapshots_venue_time" ON "public"."connection_health_snapshots" USING "btree" ("venue_id", "captured_at" DESC);



CREATE INDEX "idx_connectivity_audit_connection_time" ON "public"."connectivity_audit_events" USING "btree" ("connection_id", "created_at" DESC);



CREATE INDEX "idx_connectivity_audit_user_time" ON "public"."connectivity_audit_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_connectivity_connections_account" ON "public"."connectivity_connections" USING "btree" ("account_id");



CREATE INDEX "idx_connectivity_connections_user_status" ON "public"."connectivity_connections" USING "btree" ("user_id", "status");



CREATE INDEX "idx_content_reports_queue" ON "public"."content_reports" USING "btree" ("status", "created_at");



CREATE INDEX "idx_conversation_members_user" ON "public"."conversation_members" USING "btree" ("user_id", "joined_at" DESC) WHERE ("left_at" IS NULL);



CREATE UNIQUE INDEX "idx_conversations_direct_key" ON "public"."conversations" USING "btree" ("direct_key") WHERE ("direct_key" IS NOT NULL);



CREATE INDEX "idx_exchange_accounts_user" ON "public"."exchange_accounts" USING "btree" ("user_id");



CREATE INDEX "idx_execution_audit_logs_user" ON "public"."execution_audit_logs" USING "btree" ("user_id");



CREATE INDEX "idx_execution_orders_account" ON "public"."execution_orders" USING "btree" ("account_id");



CREATE INDEX "idx_execution_orders_user" ON "public"."execution_orders" USING "btree" ("user_id");



CREATE INDEX "idx_hyperliquid_credentials_account" ON "public"."hyperliquid_credentials" USING "btree" ("account_id");



CREATE INDEX "idx_hyperliquid_credentials_agent" ON "public"."hyperliquid_credentials" USING "btree" ("agent_wallet_address", "network");



CREATE INDEX "idx_hyperliquid_credentials_connection" ON "public"."hyperliquid_credentials" USING "btree" ("connection_id");



CREATE INDEX "idx_hyperliquid_credentials_user_status" ON "public"."hyperliquid_credentials" USING "btree" ("user_id", "status");



CREATE INDEX "idx_hyperliquid_nonce_credential" ON "public"."hyperliquid_nonce_state" USING "btree" ("credential_id");



CREATE INDEX "idx_hyperliquid_nonce_user" ON "public"."hyperliquid_nonce_state" USING "btree" ("user_id");



CREATE INDEX "idx_hyperliquid_relay_events_account_time" ON "public"."hyperliquid_order_relay_events" USING "btree" ("account_id", "created_at" DESC);



CREATE INDEX "idx_hyperliquid_relay_events_order" ON "public"."hyperliquid_order_relay_events" USING "btree" ("order_id", "client_order_id", "exchange_order_id");



CREATE INDEX "idx_hyperliquid_relay_events_user_time" ON "public"."hyperliquid_order_relay_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_hyperliquid_snapshots_account_time" ON "public"."hyperliquid_account_snapshots" USING "btree" ("account_id", "created_at" DESC);



CREATE INDEX "idx_hyperliquid_snapshots_user_time" ON "public"."hyperliquid_account_snapshots" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_imm_integrity_events_severity_time" ON "public"."imm_integrity_events" USING "btree" ("severity", "occurred_at" DESC);



CREATE INDEX "idx_imm_integrity_events_symbol_time" ON "public"."imm_integrity_events" USING "btree" ("venue", "market_kind", "symbol", "occurred_at" DESC);



CREATE INDEX "idx_imm_worker_heartbeats_status" ON "public"."imm_worker_heartbeats" USING "btree" ("status", "heartbeat_at" DESC);



CREATE INDEX "idx_imm_worker_heartbeats_symbol" ON "public"."imm_worker_heartbeats" USING "btree" ("venue", "market_kind", "symbol", "heartbeat_at" DESC);



CREATE INDEX "idx_investment_group_members_user" ON "public"."investment_group_members" USING "btree" ("user_id", "status");



CREATE INDEX "idx_investment_group_messages_group_channel" ON "public"."investment_group_messages" USING "btree" ("group_id", "channel", "created_at" DESC);



CREATE INDEX "idx_investment_group_moderation_group_time" ON "public"."investment_group_moderation_events" USING "btree" ("group_id", "created_at" DESC);



CREATE INDEX "idx_investment_group_requests_group_status" ON "public"."investment_group_join_requests" USING "btree" ("group_id", "status", "created_at" DESC);



CREATE INDEX "idx_investment_groups_owner_status" ON "public"."investment_groups" USING "btree" ("owner_user_id", "status");



CREATE INDEX "idx_investment_groups_visibility_status" ON "public"."investment_groups" USING "btree" ("visibility", "status", "created_at" DESC);



CREATE INDEX "idx_mainnet_validation_records_user_time" ON "public"."mainnet_validation_records" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_mainnet_validation_records_venue_status" ON "public"."mainnet_validation_records" USING "btree" ("venue_id", "status", "created_at" DESC);



CREATE INDEX "idx_messages_conversation_cursor" ON "public"."messages" USING "btree" ("conversation_id", "created_at" DESC, "id" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_notification_events_unread" ON "public"."notification_events" USING "btree" ("user_id", "created_at" DESC) WHERE ("read_at" IS NULL);



CREATE INDEX "idx_notification_events_user_time" ON "public"."notification_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_position_lifecycle_account_symbol" ON "public"."position_lifecycle_positions" USING "btree" ("account_id", "symbol");



CREATE INDEX "idx_position_lifecycle_user_state" ON "public"."position_lifecycle_positions" USING "btree" ("user_id", "lifecycle_state");



CREATE INDEX "idx_position_protection_position" ON "public"."position_protection_orders" USING "btree" ("position_id", "status");



CREATE INDEX "idx_position_timeline_position_time" ON "public"."position_timeline_events" USING "btree" ("position_id", "created_at" DESC);



CREATE INDEX "idx_profile_posts_feed_cursor" ON "public"."profile_posts" USING "btree" ("created_at" DESC, "id" DESC) WHERE (("deleted_at" IS NULL) AND ("status" = 'published'::"text"));



CREATE INDEX "idx_profile_posts_group_time" ON "public"."profile_posts" USING "btree" ("investment_group_id", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE UNIQUE INDEX "idx_profile_posts_idempotency" ON "public"."profile_posts" USING "btree" ("user_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_profile_posts_user_time" ON "public"."profile_posts" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_profile_posts_visibility_time" ON "public"."profile_posts" USING "btree" ("visibility", "created_at" DESC);



CREATE INDEX "idx_profiles_extended_discovery" ON "public"."profiles_extended" USING "btree" ("profile_visibility", "updated_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE UNIQUE INDEX "idx_profiles_extended_handle_unique" ON "public"."profiles_extended" USING "btree" ("lower"("handle")) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_published_indicators_user_time" ON "public"."published_indicators" USING "btree" ("user_id", "updated_at" DESC);



CREATE INDEX "idx_published_strategies_user_time" ON "public"."published_strategies" USING "btree" ("user_id", "updated_at" DESC);



CREATE INDEX "idx_social_account_restrictions_active" ON "public"."social_account_restrictions" USING "btree" ("user_id", "starts_at" DESC) WHERE ("lifted_at" IS NULL);



CREATE UNIQUE INDEX "idx_social_comments_idempotency" ON "public"."social_comments" USING "btree" ("author_user_id", "client_comment_id") WHERE ("client_comment_id" IS NOT NULL);



CREATE INDEX "idx_social_comments_post_time" ON "public"."social_comments" USING "btree" ("post_id", "created_at") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_social_mentions_recipient" ON "public"."social_mentions" USING "btree" ("mentioned_user_id", "created_at" DESC);



CREATE INDEX "idx_social_rate_limit_window" ON "public"."social_rate_limit_events" USING "btree" ("user_id", "action", "created_at" DESC);



CREATE UNIQUE INDEX "idx_social_saved_collection_default" ON "public"."social_saved_collections" USING "btree" ("user_id") WHERE "is_default";



CREATE INDEX "idx_user_follows_followed" ON "public"."user_follows" USING "btree" ("followed_user_id", "created_at" DESC);



CREATE INDEX "idx_venue_metadata_cache_symbol" ON "public"."venue_metadata_cache" USING "btree" ("venue_id", "network", "native_symbol");



CREATE INDEX "idx_venue_rate_limit_snapshots_venue_time" ON "public"."venue_rate_limit_snapshots" USING "btree" ("venue_id", "captured_at" DESC);



CREATE INDEX "platform_diagnostics_created_at_idx" ON "public"."platform_diagnostics" USING "btree" ("created_at" DESC);



CREATE INDEX "platform_diagnostics_metric_name_idx" ON "public"."platform_diagnostics" USING "btree" ("metric_name");



CREATE INDEX "platform_diagnostics_source_idx" ON "public"."platform_diagnostics" USING "btree" ("source");



CREATE INDEX "platform_diagnostics_user_id_idx" ON "public"."platform_diagnostics" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "set_account_risk_controls_updated_at" BEFORE UPDATE ON "public"."account_risk_controls" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_dex_wallet_connections_updated_at" BEFORE UPDATE ON "public"."dex_wallet_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_exchange_accounts_updated_at" BEFORE UPDATE ON "public"."exchange_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_exchange_credentials_updated_at" BEFORE UPDATE ON "public"."exchange_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_conversations_updated_at" BEFORE UPDATE ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_messages_updated_at" BEFORE UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profile_links_updated_at" BEFORE UPDATE ON "public"."profile_links" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profile_privacy_updated_at" BEFORE UPDATE ON "public"."profile_privacy_settings" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_extended_updated_at" BEFORE UPDATE ON "public"."profiles_extended" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_social_comments_updated_at" BEFORE UPDATE ON "public"."social_comments" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_social_reactions_updated_at" BEFORE UPDATE ON "public"."social_reactions" FOR EACH ROW EXECUTE FUNCTION "public"."bt_set_updated_at"();



ALTER TABLE ONLY "public"."account_balances"
    ADD CONSTRAINT "account_balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."account_positions"
    ADD CONSTRAINT "account_positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."account_risk_controls"
    ADD CONSTRAINT "account_risk_controls_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connectivity_audit_events"
    ADD CONSTRAINT "connectivity_audit_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."connectivity_audit_events"
    ADD CONSTRAINT "connectivity_audit_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connectivity_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."connectivity_audit_events"
    ADD CONSTRAINT "connectivity_audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connectivity_connections"
    ADD CONSTRAINT "connectivity_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."connectivity_connections"
    ADD CONSTRAINT "connectivity_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."content_reports"
    ADD CONSTRAINT "content_reports_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."content_reports"
    ADD CONSTRAINT "content_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_members"
    ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_members"
    ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dex_wallet_connections"
    ADD CONSTRAINT "dex_wallet_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."exchange_accounts"
    ADD CONSTRAINT "exchange_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."exchange_credentials"
    ADD CONSTRAINT "exchange_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_audit_logs"
    ADD CONSTRAINT "execution_audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."execution_audit_logs"
    ADD CONSTRAINT "execution_audit_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."execution_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."execution_audit_logs"
    ADD CONSTRAINT "execution_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_fills"
    ADD CONSTRAINT "execution_fills_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_fills"
    ADD CONSTRAINT "execution_fills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."execution_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_fills"
    ADD CONSTRAINT "execution_fills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_order_events"
    ADD CONSTRAINT "execution_order_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_order_events"
    ADD CONSTRAINT "execution_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."execution_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_order_events"
    ADD CONSTRAINT "execution_order_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_orders"
    ADD CONSTRAINT "execution_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."execution_orders"
    ADD CONSTRAINT "execution_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_account_snapshots"
    ADD CONSTRAINT "hyperliquid_account_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_account_snapshots"
    ADD CONSTRAINT "hyperliquid_account_snapshots_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."hyperliquid_credentials"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hyperliquid_account_snapshots"
    ADD CONSTRAINT "hyperliquid_account_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_credentials"
    ADD CONSTRAINT "hyperliquid_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_credentials"
    ADD CONSTRAINT "hyperliquid_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connectivity_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hyperliquid_credentials"
    ADD CONSTRAINT "hyperliquid_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_nonce_state"
    ADD CONSTRAINT "hyperliquid_nonce_state_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."hyperliquid_credentials"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_nonce_state"
    ADD CONSTRAINT "hyperliquid_nonce_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hyperliquid_order_relay_events"
    ADD CONSTRAINT "hyperliquid_order_relay_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hyperliquid_order_relay_events"
    ADD CONSTRAINT "hyperliquid_order_relay_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connectivity_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hyperliquid_order_relay_events"
    ADD CONSTRAINT "hyperliquid_order_relay_events_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."hyperliquid_credentials"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hyperliquid_order_relay_events"
    ADD CONSTRAINT "hyperliquid_order_relay_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_join_requests"
    ADD CONSTRAINT "investment_group_join_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_join_requests"
    ADD CONSTRAINT "investment_group_join_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."investment_group_join_requests"
    ADD CONSTRAINT "investment_group_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_members"
    ADD CONSTRAINT "investment_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_members"
    ADD CONSTRAINT "investment_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_messages"
    ADD CONSTRAINT "investment_group_messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_messages"
    ADD CONSTRAINT "investment_group_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_moderation_events"
    ADD CONSTRAINT "investment_group_moderation_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."investment_group_moderation_events"
    ADD CONSTRAINT "investment_group_moderation_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_group_moderation_events"
    ADD CONSTRAINT "investment_group_moderation_events_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."investment_group_stats"
    ADD CONSTRAINT "investment_group_stats_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_groups"
    ADD CONSTRAINT "investment_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_last_read_message_id_fkey" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_requests"
    ADD CONSTRAINT "message_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_requests"
    ADD CONSTRAINT "message_requests_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_requests"
    ADD CONSTRAINT "message_requests_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moderation_actions"
    ADD CONSTRAINT "moderation_actions_moderator_user_id_fkey" FOREIGN KEY ("moderator_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."moderation_actions"
    ADD CONSTRAINT "moderation_actions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."content_reports"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."social_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."investment_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_diagnostics"
    ADD CONSTRAINT "platform_diagnostics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_lifecycle_positions"
    ADD CONSTRAINT "position_lifecycle_positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_lifecycle_positions"
    ADD CONSTRAINT "position_lifecycle_positions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connectivity_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."position_lifecycle_positions"
    ADD CONSTRAINT "position_lifecycle_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."position_protection_orders"
    ADD CONSTRAINT "position_protection_orders_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."position_lifecycle_positions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."position_protection_orders"
    ADD CONSTRAINT "position_protection_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."position_timeline_events"
    ADD CONSTRAINT "position_timeline_events_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "public"."position_lifecycle_positions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."position_timeline_events"
    ADD CONSTRAINT "position_timeline_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."professional_network_product_events"
    ADD CONSTRAINT "professional_network_product_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profile_links"
    ADD CONSTRAINT "profile_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_investment_group_id_fkey" FOREIGN KEY ("investment_group_id") REFERENCES "public"."investment_groups"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_parent_post_id_fkey" FOREIGN KEY ("parent_post_id") REFERENCES "public"."profile_posts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_quoted_post_id_fkey" FOREIGN KEY ("quoted_post_id") REFERENCES "public"."profile_posts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_privacy_settings"
    ADD CONSTRAINT "profile_privacy_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_specialties"
    ADD CONSTRAINT "profile_specialties_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles_extended"
    ADD CONSTRAINT "profiles_extended_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."published_indicators"
    ADD CONSTRAINT "published_indicators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."published_strategies"
    ADD CONSTRAINT "published_strategies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_account_restrictions"
    ADD CONSTRAINT "social_account_restrictions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."social_account_restrictions"
    ADD CONSTRAINT "social_account_restrictions_lifted_by_fkey" FOREIGN KEY ("lifted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."social_account_restrictions"
    ADD CONSTRAINT "social_account_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comment_edits"
    ADD CONSTRAINT "social_comment_edits_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."social_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comment_edits"
    ADD CONSTRAINT "social_comment_edits_editor_user_id_fkey" FOREIGN KEY ("editor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."social_comment_reactions"
    ADD CONSTRAINT "social_comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."social_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comment_reactions"
    ADD CONSTRAINT "social_comment_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comments"
    ADD CONSTRAINT "social_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comments"
    ADD CONSTRAINT "social_comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."social_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_comments"
    ADD CONSTRAINT "social_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_follow_requests"
    ADD CONSTRAINT "social_follow_requests_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_follow_requests"
    ADD CONSTRAINT "social_follow_requests_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_hidden_posts"
    ADD CONSTRAINT "social_hidden_posts_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_hidden_posts"
    ADD CONSTRAINT "social_hidden_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_mentions"
    ADD CONSTRAINT "social_mentions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_mentions"
    ADD CONSTRAINT "social_mentions_mentioned_user_id_fkey" FOREIGN KEY ("mentioned_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_mentions"
    ADD CONSTRAINT "social_mentions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_post_attachments"
    ADD CONSTRAINT "social_post_attachments_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "public"."published_indicators"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."social_post_attachments"
    ADD CONSTRAINT "social_post_attachments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_post_attachments"
    ADD CONSTRAINT "social_post_attachments_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "public"."published_strategies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."social_post_edits"
    ADD CONSTRAINT "social_post_edits_editor_user_id_fkey" FOREIGN KEY ("editor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."social_post_edits"
    ADD CONSTRAINT "social_post_edits_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_post_media"
    ADD CONSTRAINT "social_post_media_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_post_media"
    ADD CONSTRAINT "social_post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_post_symbols"
    ADD CONSTRAINT "social_post_symbols_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_rate_limit_events"
    ADD CONSTRAINT "social_rate_limit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_reactions"
    ADD CONSTRAINT "social_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_reactions"
    ADD CONSTRAINT "social_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_reposts"
    ADD CONSTRAINT "social_reposts_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_reposts"
    ADD CONSTRAINT "social_reposts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_saved_collections"
    ADD CONSTRAINT "social_saved_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_saved_posts"
    ADD CONSTRAINT "social_saved_posts_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."social_saved_collections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."social_saved_posts"
    ADD CONSTRAINT "social_saved_posts_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."social_saved_posts"
    ADD CONSTRAINT "social_saved_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_followed_user_id_fkey" FOREIGN KEY ("followed_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_follower_user_id_fkey" FOREIGN KEY ("follower_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_mutes"
    ADD CONSTRAINT "user_mutes_muted_user_id_fkey" FOREIGN KEY ("muted_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_mutes"
    ADD CONSTRAINT "user_mutes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."account_balances" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_positions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."account_risk_controls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."adapter_certifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."connection_health_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."connectivity_audit_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connectivity_audit_insert_own" ON "public"."connectivity_audit_events" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "connectivity_audit_select_own" ON "public"."connectivity_audit_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."connectivity_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connectivity_connections_delete_own" ON "public"."connectivity_connections" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "connectivity_connections_insert_own" ON "public"."connectivity_connections" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "connectivity_connections_select_own" ON "public"."connectivity_connections" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "connectivity_connections_update_own" ON "public"."connectivity_connections" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."content_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "content_reports_reporter_insert" ON "public"."content_reports" FOR INSERT WITH CHECK (("auth"."uid"() = "reporter_user_id"));



CREATE POLICY "content_reports_reporter_select" ON "public"."content_reports" FOR SELECT USING (("auth"."uid"() = "reporter_user_id"));



ALTER TABLE "public"."conversation_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversation_members_related" ON "public"."conversation_members" FOR SELECT USING ("public"."social_is_conversation_member"("conversation_id"));



CREATE POLICY "conversation_members_self_update" ON "public"."conversation_members" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_creator_insert" ON "public"."conversations" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "conversations_members_select" ON "public"."conversations" FOR SELECT USING ("public"."social_is_conversation_member"("id"));



CREATE POLICY "conversations_members_update" ON "public"."conversations" FOR UPDATE USING ("public"."social_is_conversation_member"("id"));



ALTER TABLE "public"."dex_wallet_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exchange_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exchange_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."execution_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."execution_fills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."execution_order_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."execution_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hyperliquid_account_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hyperliquid_credentials" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hyperliquid_credentials_delete_own" ON "public"."hyperliquid_credentials" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_credentials_insert_own" ON "public"."hyperliquid_credentials" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_credentials_select_own" ON "public"."hyperliquid_credentials" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_credentials_update_own" ON "public"."hyperliquid_credentials" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_nonce_insert_own" ON "public"."hyperliquid_nonce_state" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_nonce_select_own" ON "public"."hyperliquid_nonce_state" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."hyperliquid_nonce_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hyperliquid_nonce_update_own" ON "public"."hyperliquid_nonce_state" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."hyperliquid_order_relay_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hyperliquid_relay_events_insert_own" ON "public"."hyperliquid_order_relay_events" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_relay_events_select_own" ON "public"."hyperliquid_order_relay_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_snapshots_insert_own" ON "public"."hyperliquid_account_snapshots" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "hyperliquid_snapshots_select_own" ON "public"."hyperliquid_account_snapshots" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."imm_integrity_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."imm_worker_heartbeats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investment_group_join_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investment_group_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "investment_group_members_owner_write" ON "public"."investment_group_members" USING ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_members"."group_id") AND ("g"."owner_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_members"."group_id") AND ("g"."owner_user_id" = "auth"."uid"())))));



CREATE POLICY "investment_group_members_select_related" ON "public"."investment_group_members" FOR SELECT USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_members"."group_id") AND ("g"."owner_user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."investment_group_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "investment_group_messages_delete_moderators" ON "public"."investment_group_messages" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_messages"."group_id") AND ("g"."owner_user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."investment_group_members" "m"
  WHERE (("m"."group_id" = "investment_group_messages"."group_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."status" = 'active'::"text") AND ("m"."role" = 'manager'::"text"))))));



CREATE POLICY "investment_group_messages_insert_members" ON "public"."investment_group_messages" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."investment_group_members" "m"
  WHERE (("m"."group_id" = "investment_group_messages"."group_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."status" = 'active'::"text"))))));



CREATE POLICY "investment_group_messages_select_members" ON "public"."investment_group_messages" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."investment_group_members" "m"
  WHERE (("m"."group_id" = "investment_group_messages"."group_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."status" = 'active'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_messages"."group_id") AND ("g"."visibility" = 'public'::"text") AND ("g"."public_sections" ? 'trading_room'::"text"))))));



ALTER TABLE "public"."investment_group_moderation_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "investment_group_moderation_select_authorized" ON "public"."investment_group_moderation_events" FOR SELECT USING ((("auth"."uid"() = "target_user_id") OR (EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_moderation_events"."group_id") AND ("g"."owner_user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."investment_group_members" "m"
  WHERE (("m"."group_id" = "investment_group_moderation_events"."group_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."status" = 'active'::"text") AND ("m"."role" = 'manager'::"text"))))));



CREATE POLICY "investment_group_requests_insert_own" ON "public"."investment_group_join_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "investment_group_requests_owner_update" ON "public"."investment_group_join_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_join_requests"."group_id") AND ("g"."owner_user_id" = "auth"."uid"())))));



CREATE POLICY "investment_group_requests_select_related" ON "public"."investment_group_join_requests" FOR SELECT USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_join_requests"."group_id") AND ("g"."owner_user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."investment_group_stats" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "investment_group_stats_owner_write" ON "public"."investment_group_stats" USING ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_stats"."group_id") AND ("g"."owner_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_stats"."group_id") AND ("g"."owner_user_id" = "auth"."uid"())))));



CREATE POLICY "investment_group_stats_select_visible" ON "public"."investment_group_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."investment_groups" "g"
  WHERE (("g"."id" = "investment_group_stats"."group_id") AND (("g"."visibility" = 'public'::"text") OR ("g"."owner_user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."investment_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "investment_groups_insert_own" ON "public"."investment_groups" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_user_id"));



CREATE POLICY "investment_groups_select_visible" ON "public"."investment_groups" FOR SELECT USING ((("visibility" = 'public'::"text") OR ("auth"."uid"() = "owner_user_id")));



CREATE POLICY "investment_groups_update_owner" ON "public"."investment_groups" FOR UPDATE USING (("auth"."uid"() = "owner_user_id")) WITH CHECK (("auth"."uid"() = "owner_user_id"));



ALTER TABLE "public"."mainnet_validation_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_attachments_members_select" ON "public"."message_attachments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE (("m"."id" = "message_attachments"."message_id") AND "public"."social_is_conversation_member"("m"."conversation_id")))));



CREATE POLICY "message_attachments_owner_all" ON "public"."message_attachments" USING (("auth"."uid"() = "owner_user_id")) WITH CHECK (("auth"."uid"() = "owner_user_id"));



ALTER TABLE "public"."message_reads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_reads_owner" ON "public"."message_reads" USING (("auth"."uid"() = "user_id")) WITH CHECK ((("auth"."uid"() = "user_id") AND "public"."social_is_conversation_member"("conversation_id")));



ALTER TABLE "public"."message_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_requests_recipient_update" ON "public"."message_requests" FOR UPDATE USING (("auth"."uid"() = "recipient_user_id"));



CREATE POLICY "message_requests_related" ON "public"."message_requests" FOR SELECT USING ((("auth"."uid"() = "sender_user_id") OR ("auth"."uid"() = "recipient_user_id")));



CREATE POLICY "message_requests_sender_insert" ON "public"."message_requests" FOR INSERT WITH CHECK ((("auth"."uid"() = "sender_user_id") AND (NOT "public"."social_users_blocked"("sender_user_id", "recipient_user_id"))));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_members_select" ON "public"."messages" FOR SELECT USING ("public"."social_is_conversation_member"("conversation_id"));



CREATE POLICY "messages_sender_insert" ON "public"."messages" FOR INSERT WITH CHECK ((("auth"."uid"() = "sender_user_id") AND "public"."social_is_conversation_member"("conversation_id")));



CREATE POLICY "messages_sender_update" ON "public"."messages" FOR UPDATE USING (("auth"."uid"() = "sender_user_id")) WITH CHECK (("auth"."uid"() = "sender_user_id"));



ALTER TABLE "public"."moderation_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_events_select_own" ON "public"."notification_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "notification_events_update_own" ON "public"."notification_events" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_preferences_owner" ON "public"."notification_preferences" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."platform_diagnostics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."position_lifecycle_positions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "position_lifecycle_positions_delete_own" ON "public"."position_lifecycle_positions" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "position_lifecycle_positions_insert_own" ON "public"."position_lifecycle_positions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "position_lifecycle_positions_select_own" ON "public"."position_lifecycle_positions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "position_lifecycle_positions_update_own" ON "public"."position_lifecycle_positions" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "position_protection_delete_own" ON "public"."position_protection_orders" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "position_protection_insert_own" ON "public"."position_protection_orders" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."position_protection_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "position_protection_select_own" ON "public"."position_protection_orders" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "position_protection_update_own" ON "public"."position_protection_orders" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."position_timeline_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "position_timeline_insert_own" ON "public"."position_timeline_events" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "position_timeline_select_own" ON "public"."position_timeline_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."professional_network_product_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_links_owner_all" ON "public"."profile_links" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_links_select_visible" ON "public"."profile_links" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles_extended" "p"
  WHERE ("p"."user_id" = "profile_links"."user_id"))));



ALTER TABLE "public"."profile_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_posts_delete_own" ON "public"."profile_posts" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_posts_insert_own" ON "public"."profile_posts" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_posts_select_visible" ON "public"."profile_posts" FOR SELECT USING ((("deleted_at" IS NULL) AND ("status" = 'published'::"text") AND "public"."social_can_view_post"("user_id", "visibility", "investment_group_id")));



CREATE POLICY "profile_posts_update_own" ON "public"."profile_posts" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_privacy_owner" ON "public"."profile_privacy_settings" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profile_privacy_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_specialties" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_specialties_owner_all" ON "public"."profile_specialties" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_specialties_select_visible" ON "public"."profile_specialties" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles_extended" "p"
  WHERE ("p"."user_id" = "profile_specialties"."user_id"))));



ALTER TABLE "public"."profiles_extended" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_extended_insert_own" ON "public"."profiles_extended" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profiles_extended_select_visible" ON "public"."profiles_extended" FOR SELECT USING ((("deleted_at" IS NULL) AND (("auth"."uid"() = "user_id") OR ((NOT "public"."social_users_blocked"("auth"."uid"(), "user_id")) AND (("profile_visibility" = 'public'::"text") OR (("profile_visibility" = 'followers'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."user_follows" "f"
  WHERE (("f"."follower_user_id" = "auth"."uid"()) AND ("f"."followed_user_id" = "profiles_extended"."user_id"))))))))));



CREATE POLICY "profiles_extended_update_own" ON "public"."profiles_extended" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."published_indicators" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "published_indicators_insert_own" ON "public"."published_indicators" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "published_indicators_select_visible" ON "public"."published_indicators" FOR SELECT USING ((("visibility" = 'public'::"text") OR ("auth"."uid"() = "user_id")));



CREATE POLICY "published_indicators_update_own" ON "public"."published_indicators" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."published_strategies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "published_strategies_insert_own" ON "public"."published_strategies" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "published_strategies_select_visible" ON "public"."published_strategies" FOR SELECT USING ((("visibility" = 'public'::"text") OR ("auth"."uid"() = "user_id")));



CREATE POLICY "published_strategies_update_own" ON "public"."published_strategies" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."social_account_restrictions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."social_comment_edits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_comment_edits_owner_select" ON "public"."social_comment_edits" FOR SELECT USING (("auth"."uid"() = "editor_user_id"));



ALTER TABLE "public"."social_comment_reactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_comment_reactions_owner_all" ON "public"."social_comment_reactions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "social_comment_reactions_visible" ON "public"."social_comment_reactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."social_comments" "c"
  WHERE ("c"."id" = "social_comment_reactions"."comment_id"))));



ALTER TABLE "public"."social_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_comments_owner_insert" ON "public"."social_comments" FOR INSERT WITH CHECK ((("auth"."uid"() = "author_user_id") AND (EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_comments"."post_id") AND "p"."comments_enabled")))));



CREATE POLICY "social_comments_owner_update" ON "public"."social_comments" FOR UPDATE USING (("auth"."uid"() = "author_user_id")) WITH CHECK (("auth"."uid"() = "author_user_id"));



CREATE POLICY "social_comments_visible" ON "public"."social_comments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_comments"."post_id"))));



ALTER TABLE "public"."social_follow_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_follow_requests_related" ON "public"."social_follow_requests" FOR SELECT USING ((("auth"."uid"() = "requester_user_id") OR ("auth"."uid"() = "target_user_id")));



CREATE POLICY "social_follow_requests_related_update" ON "public"."social_follow_requests" FOR UPDATE USING ((("auth"."uid"() = "requester_user_id") OR ("auth"."uid"() = "target_user_id")));



CREATE POLICY "social_follow_requests_requester_insert" ON "public"."social_follow_requests" FOR INSERT WITH CHECK ((("auth"."uid"() = "requester_user_id") AND (NOT "public"."social_users_blocked"("requester_user_id", "target_user_id"))));



ALTER TABLE "public"."social_hidden_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_hidden_posts_owner" ON "public"."social_hidden_posts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."social_mentions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_mentions_related_select" ON "public"."social_mentions" FOR SELECT USING (((("auth"."uid"() = "actor_user_id") OR ("auth"."uid"() = "mentioned_user_id")) AND (EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_mentions"."post_id")))));



ALTER TABLE "public"."social_post_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_post_attachments_owner_write" ON "public"."social_post_attachments" USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_post_attachments"."post_id") AND ("p"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_post_attachments"."post_id") AND ("p"."user_id" = "auth"."uid"())))));



CREATE POLICY "social_post_attachments_visible" ON "public"."social_post_attachments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_post_attachments"."post_id"))));



ALTER TABLE "public"."social_post_edits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_post_edits_owner_select" ON "public"."social_post_edits" FOR SELECT USING ((("editor_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_post_edits"."post_id") AND ("p"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."social_post_media" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_post_media_owner_all" ON "public"."social_post_media" USING (("auth"."uid"() = "owner_user_id")) WITH CHECK (("auth"."uid"() = "owner_user_id"));



CREATE POLICY "social_post_media_visible" ON "public"."social_post_media" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_post_media"."post_id"))));



ALTER TABLE "public"."social_post_symbols" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_post_symbols_owner_write" ON "public"."social_post_symbols" USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_post_symbols"."post_id") AND ("p"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE (("p"."id" = "social_post_symbols"."post_id") AND ("p"."user_id" = "auth"."uid"())))));



CREATE POLICY "social_post_symbols_visible" ON "public"."social_post_symbols" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_post_symbols"."post_id"))));



ALTER TABLE "public"."social_rate_limit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."social_reactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_reactions_owner_all" ON "public"."social_reactions" USING (("auth"."uid"() = "user_id")) WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_reactions"."post_id")))));



CREATE POLICY "social_reactions_visible" ON "public"."social_reactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_reactions"."post_id"))));



ALTER TABLE "public"."social_reposts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_reposts_owner_all" ON "public"."social_reposts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "social_reposts_visible" ON "public"."social_reposts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profile_posts" "p"
  WHERE ("p"."id" = "social_reposts"."post_id"))));



ALTER TABLE "public"."social_saved_collections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_saved_collections_owner" ON "public"."social_saved_collections" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."social_saved_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "social_saved_posts_owner" ON "public"."social_saved_posts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_blocks_owner" ON "public"."user_blocks" USING (("auth"."uid"() = "blocker_user_id")) WITH CHECK (("auth"."uid"() = "blocker_user_id"));



ALTER TABLE "public"."user_follows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_follows_delete_own" ON "public"."user_follows" FOR DELETE USING (("auth"."uid"() = "follower_user_id"));



CREATE POLICY "user_follows_insert_own" ON "public"."user_follows" FOR INSERT WITH CHECK ((("auth"."uid"() = "follower_user_id") AND (NOT "public"."social_users_blocked"("follower_user_id", "followed_user_id"))));



CREATE POLICY "user_follows_select_related" ON "public"."user_follows" FOR SELECT USING (((("auth"."uid"() = "follower_user_id") OR ("auth"."uid"() = "followed_user_id")) AND (NOT "public"."social_users_blocked"("follower_user_id", "followed_user_id"))));



ALTER TABLE "public"."user_mutes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_mutes_owner" ON "public"."user_mutes" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users manage own dex wallet connections" ON "public"."dex_wallet_connections" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users manage own exchange accounts" ON "public"."exchange_accounts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "users manage own risk controls" ON "public"."account_risk_controls" USING ((EXISTS ( SELECT 1
   FROM "public"."exchange_accounts"
  WHERE (("exchange_accounts"."id" = "account_risk_controls"."account_id") AND ("exchange_accounts"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."exchange_accounts"
  WHERE (("exchange_accounts"."id" = "account_risk_controls"."account_id") AND ("exchange_accounts"."user_id" = "auth"."uid"())))));



CREATE POLICY "users read own execution fills" ON "public"."execution_fills" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users read own execution order events" ON "public"."execution_order_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users read own platform diagnostics" ON "public"."platform_diagnostics" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."venue_metadata_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_rate_limit_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_time_sync_status" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."bt_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."bt_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bt_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."next_hyperliquid_nonce"("p_user_id" "uuid", "p_credential_id" "uuid", "p_agent_wallet_address" "text", "p_network" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."next_hyperliquid_nonce"("p_user_id" "uuid", "p_credential_id" "uuid", "p_agent_wallet_address" "text", "p_network" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_hyperliquid_nonce"("p_user_id" "uuid", "p_credential_id" "uuid", "p_agent_wallet_address" "text", "p_network" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."social_can_view_post"("post_author" "uuid", "post_visibility" "text", "post_group_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."social_consume_rate_limit"("target_user" "uuid", "target_action" "text", "allowed_count" integer, "window_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."social_is_conversation_member"("target_conversation" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."social_start_direct_conversation"("actor_user" "uuid", "target_user" "uuid", "requires_request" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."social_users_blocked"("first_user" "uuid", "second_user" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."account_balances" TO "anon";
GRANT ALL ON TABLE "public"."account_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."account_balances" TO "service_role";



GRANT ALL ON TABLE "public"."account_positions" TO "anon";
GRANT ALL ON TABLE "public"."account_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."account_positions" TO "service_role";



GRANT ALL ON TABLE "public"."account_risk_controls" TO "anon";
GRANT ALL ON TABLE "public"."account_risk_controls" TO "authenticated";
GRANT ALL ON TABLE "public"."account_risk_controls" TO "service_role";



GRANT ALL ON TABLE "public"."adapter_certifications" TO "anon";
GRANT ALL ON TABLE "public"."adapter_certifications" TO "authenticated";
GRANT ALL ON TABLE "public"."adapter_certifications" TO "service_role";



GRANT ALL ON TABLE "public"."bt_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."bt_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."bt_audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bt_audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bt_audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bt_audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bt_users" TO "anon";
GRANT ALL ON TABLE "public"."bt_users" TO "authenticated";
GRANT ALL ON TABLE "public"."bt_users" TO "service_role";



GRANT ALL ON TABLE "public"."connection_health_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."connection_health_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."connection_health_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."connectivity_audit_events" TO "anon";
GRANT ALL ON TABLE "public"."connectivity_audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."connectivity_audit_events" TO "service_role";



GRANT ALL ON TABLE "public"."connectivity_connections" TO "anon";
GRANT ALL ON TABLE "public"."connectivity_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."connectivity_connections" TO "service_role";



GRANT ALL ON TABLE "public"."content_reports" TO "anon";
GRANT ALL ON TABLE "public"."content_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."content_reports" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_members" TO "anon";
GRANT ALL ON TABLE "public"."conversation_members" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_members" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."dex_wallet_connections" TO "anon";
GRANT ALL ON TABLE "public"."dex_wallet_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."dex_wallet_connections" TO "service_role";



GRANT ALL ON TABLE "public"."exchange_accounts" TO "anon";
GRANT ALL ON TABLE "public"."exchange_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."exchange_credentials" TO "anon";
GRANT ALL ON TABLE "public"."exchange_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."execution_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."execution_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."execution_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."execution_fills" TO "anon";
GRANT ALL ON TABLE "public"."execution_fills" TO "authenticated";
GRANT ALL ON TABLE "public"."execution_fills" TO "service_role";



GRANT ALL ON TABLE "public"."execution_order_events" TO "anon";
GRANT ALL ON TABLE "public"."execution_order_events" TO "authenticated";
GRANT ALL ON TABLE "public"."execution_order_events" TO "service_role";



GRANT ALL ON TABLE "public"."execution_orders" TO "anon";
GRANT ALL ON TABLE "public"."execution_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."execution_orders" TO "service_role";



GRANT ALL ON TABLE "public"."hyperliquid_account_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."hyperliquid_account_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."hyperliquid_account_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."hyperliquid_credentials" TO "anon";
GRANT ALL ON TABLE "public"."hyperliquid_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."hyperliquid_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."hyperliquid_nonce_state" TO "anon";
GRANT ALL ON TABLE "public"."hyperliquid_nonce_state" TO "authenticated";
GRANT ALL ON TABLE "public"."hyperliquid_nonce_state" TO "service_role";



GRANT ALL ON TABLE "public"."hyperliquid_order_relay_events" TO "anon";
GRANT ALL ON TABLE "public"."hyperliquid_order_relay_events" TO "authenticated";
GRANT ALL ON TABLE "public"."hyperliquid_order_relay_events" TO "service_role";



GRANT ALL ON TABLE "public"."imm_integrity_events" TO "anon";
GRANT ALL ON TABLE "public"."imm_integrity_events" TO "authenticated";
GRANT ALL ON TABLE "public"."imm_integrity_events" TO "service_role";



GRANT ALL ON TABLE "public"."imm_worker_heartbeats" TO "anon";
GRANT ALL ON TABLE "public"."imm_worker_heartbeats" TO "authenticated";
GRANT ALL ON TABLE "public"."imm_worker_heartbeats" TO "service_role";



GRANT ALL ON TABLE "public"."investment_group_join_requests" TO "anon";
GRANT ALL ON TABLE "public"."investment_group_join_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_group_join_requests" TO "service_role";



GRANT ALL ON TABLE "public"."investment_group_members" TO "anon";
GRANT ALL ON TABLE "public"."investment_group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_group_members" TO "service_role";



GRANT ALL ON TABLE "public"."investment_group_messages" TO "anon";
GRANT ALL ON TABLE "public"."investment_group_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_group_messages" TO "service_role";



GRANT ALL ON TABLE "public"."investment_group_moderation_events" TO "anon";
GRANT ALL ON TABLE "public"."investment_group_moderation_events" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_group_moderation_events" TO "service_role";



GRANT ALL ON TABLE "public"."investment_group_stats" TO "anon";
GRANT ALL ON TABLE "public"."investment_group_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_group_stats" TO "service_role";



GRANT ALL ON TABLE "public"."investment_groups" TO "anon";
GRANT ALL ON TABLE "public"."investment_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_groups" TO "service_role";



GRANT ALL ON TABLE "public"."mainnet_validation_records" TO "anon";
GRANT ALL ON TABLE "public"."mainnet_validation_records" TO "authenticated";
GRANT ALL ON TABLE "public"."mainnet_validation_records" TO "service_role";



GRANT ALL ON TABLE "public"."message_attachments" TO "anon";
GRANT ALL ON TABLE "public"."message_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."message_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."message_reads" TO "anon";
GRANT ALL ON TABLE "public"."message_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reads" TO "service_role";



GRANT ALL ON TABLE "public"."message_requests" TO "anon";
GRANT ALL ON TABLE "public"."message_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."message_requests" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."moderation_actions" TO "anon";
GRANT ALL ON TABLE "public"."moderation_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."moderation_actions" TO "service_role";



GRANT ALL ON TABLE "public"."notification_events" TO "anon";
GRANT ALL ON TABLE "public"."notification_events" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_events" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."platform_diagnostics" TO "anon";
GRANT ALL ON TABLE "public"."platform_diagnostics" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_diagnostics" TO "service_role";



GRANT ALL ON TABLE "public"."position_lifecycle_positions" TO "anon";
GRANT ALL ON TABLE "public"."position_lifecycle_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."position_lifecycle_positions" TO "service_role";



GRANT ALL ON TABLE "public"."position_protection_orders" TO "anon";
GRANT ALL ON TABLE "public"."position_protection_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."position_protection_orders" TO "service_role";



GRANT ALL ON TABLE "public"."position_timeline_events" TO "anon";
GRANT ALL ON TABLE "public"."position_timeline_events" TO "authenticated";
GRANT ALL ON TABLE "public"."position_timeline_events" TO "service_role";



GRANT ALL ON TABLE "public"."professional_network_product_events" TO "anon";
GRANT ALL ON TABLE "public"."professional_network_product_events" TO "authenticated";
GRANT ALL ON TABLE "public"."professional_network_product_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."professional_network_product_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."professional_network_product_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."professional_network_product_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profile_links" TO "anon";
GRANT ALL ON TABLE "public"."profile_links" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_links" TO "service_role";



GRANT ALL ON TABLE "public"."profile_posts" TO "anon";
GRANT ALL ON TABLE "public"."profile_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_posts" TO "service_role";



GRANT ALL ON TABLE "public"."profile_privacy_settings" TO "anon";
GRANT ALL ON TABLE "public"."profile_privacy_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_privacy_settings" TO "service_role";



GRANT ALL ON TABLE "public"."profile_specialties" TO "anon";
GRANT ALL ON TABLE "public"."profile_specialties" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_specialties" TO "service_role";



GRANT ALL ON TABLE "public"."profiles_extended" TO "anon";
GRANT ALL ON TABLE "public"."profiles_extended" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles_extended" TO "service_role";



GRANT ALL ON TABLE "public"."published_indicators" TO "anon";
GRANT ALL ON TABLE "public"."published_indicators" TO "authenticated";
GRANT ALL ON TABLE "public"."published_indicators" TO "service_role";



GRANT ALL ON TABLE "public"."published_strategies" TO "anon";
GRANT ALL ON TABLE "public"."published_strategies" TO "authenticated";
GRANT ALL ON TABLE "public"."published_strategies" TO "service_role";



GRANT ALL ON TABLE "public"."social_account_restrictions" TO "anon";
GRANT ALL ON TABLE "public"."social_account_restrictions" TO "authenticated";
GRANT ALL ON TABLE "public"."social_account_restrictions" TO "service_role";



GRANT ALL ON TABLE "public"."social_comment_edits" TO "anon";
GRANT ALL ON TABLE "public"."social_comment_edits" TO "authenticated";
GRANT ALL ON TABLE "public"."social_comment_edits" TO "service_role";



GRANT ALL ON TABLE "public"."social_comment_reactions" TO "anon";
GRANT ALL ON TABLE "public"."social_comment_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."social_comment_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."social_comments" TO "anon";
GRANT ALL ON TABLE "public"."social_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."social_comments" TO "service_role";



GRANT ALL ON TABLE "public"."social_follow_requests" TO "anon";
GRANT ALL ON TABLE "public"."social_follow_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."social_follow_requests" TO "service_role";



GRANT ALL ON TABLE "public"."social_hidden_posts" TO "anon";
GRANT ALL ON TABLE "public"."social_hidden_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."social_hidden_posts" TO "service_role";



GRANT ALL ON TABLE "public"."social_mentions" TO "anon";
GRANT ALL ON TABLE "public"."social_mentions" TO "authenticated";
GRANT ALL ON TABLE "public"."social_mentions" TO "service_role";



GRANT ALL ON TABLE "public"."social_post_attachments" TO "anon";
GRANT ALL ON TABLE "public"."social_post_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."social_post_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."social_post_edits" TO "anon";
GRANT ALL ON TABLE "public"."social_post_edits" TO "authenticated";
GRANT ALL ON TABLE "public"."social_post_edits" TO "service_role";



GRANT ALL ON TABLE "public"."social_post_media" TO "anon";
GRANT ALL ON TABLE "public"."social_post_media" TO "authenticated";
GRANT ALL ON TABLE "public"."social_post_media" TO "service_role";



GRANT ALL ON TABLE "public"."social_post_symbols" TO "anon";
GRANT ALL ON TABLE "public"."social_post_symbols" TO "authenticated";
GRANT ALL ON TABLE "public"."social_post_symbols" TO "service_role";



GRANT ALL ON TABLE "public"."social_rate_limit_events" TO "anon";
GRANT ALL ON TABLE "public"."social_rate_limit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."social_rate_limit_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."social_rate_limit_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."social_rate_limit_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."social_rate_limit_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."social_reactions" TO "anon";
GRANT ALL ON TABLE "public"."social_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."social_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."social_reposts" TO "anon";
GRANT ALL ON TABLE "public"."social_reposts" TO "authenticated";
GRANT ALL ON TABLE "public"."social_reposts" TO "service_role";



GRANT ALL ON TABLE "public"."social_saved_collections" TO "anon";
GRANT ALL ON TABLE "public"."social_saved_collections" TO "authenticated";
GRANT ALL ON TABLE "public"."social_saved_collections" TO "service_role";



GRANT ALL ON TABLE "public"."social_saved_posts" TO "anon";
GRANT ALL ON TABLE "public"."social_saved_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."social_saved_posts" TO "service_role";



GRANT ALL ON TABLE "public"."user_blocks" TO "anon";
GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";



GRANT ALL ON TABLE "public"."user_follows" TO "anon";
GRANT ALL ON TABLE "public"."user_follows" TO "authenticated";
GRANT ALL ON TABLE "public"."user_follows" TO "service_role";



GRANT ALL ON TABLE "public"."user_mutes" TO "anon";
GRANT ALL ON TABLE "public"."user_mutes" TO "authenticated";
GRANT ALL ON TABLE "public"."user_mutes" TO "service_role";



GRANT ALL ON TABLE "public"."venue_metadata_cache" TO "anon";
GRANT ALL ON TABLE "public"."venue_metadata_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_metadata_cache" TO "service_role";



GRANT ALL ON TABLE "public"."venue_rate_limit_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."venue_rate_limit_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_rate_limit_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."venue_time_sync_status" TO "anon";
GRANT ALL ON TABLE "public"."venue_time_sync_status" TO "authenticated";
GRANT ALL ON TABLE "public"."venue_time_sync_status" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







