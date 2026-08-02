import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
assert.ok(url && anonKey, "SUPABASE_URL/VITE_SUPABASE_URL and the anon key are required.");

const supabase = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

for (const table of [
  "broker_secret_vault",
  "broker_secret_references",
  "connectivity_connections",
  "broker_automation_mandates",
  "broker_risk_policy_versions",
  "connection_audit_events"
]) {
  const { data, error } = await supabase.from(table).select("id").limit(1);
  assert.ok(error || (data || []).length === 0, `Anonymous access exposed a row from ${table}.`);
  console.log(`PASS anonymous ${table}: ${error ? "permission/RLS rejected" : "zero rows"}`);
}

const dummy = "00000000-0000-0000-0000-000000000000";
const { error: rpcError } = await supabase.rpc("black_cloud_store_encrypted_broker_secret_v3", {
  p_user_id: dummy,
  p_connection_id: dummy,
  p_provider: "bybit",
  p_execution_environment: "DEMO",
  p_expected_credential_version: 1,
  p_encrypted_secret: "\\x00",
  p_encryption_iv: "\\x000000000000000000000000",
  p_authentication_tag: "\\x00000000000000000000000000000000",
  p_wrapped_data_key: `\\x${"00".repeat(32)}`,
  p_wrapping_iv: "\\x000000000000000000000000",
  p_wrapping_authentication_tag: "\\x00000000000000000000000000000000",
  p_associated_data_hash: "0".repeat(64),
  p_master_key_version: 1,
  p_credential_fingerprint: "anonymous-boundary-probe",
  p_authorization_type: "trade_only_api_credential",
  p_permission_scope: {},
  p_permission_snapshot: {},
  p_withdrawal_enabled: false
});
assert.ok(rpcError, "Anonymous caller unexpectedly executed the credential-vault RPC.");
console.log("PASS anonymous credential-vault RPC: execute rejected");
