import process from "node:process";
import { getSupabaseAdmin } from "../server/portfolio-api.js";
import { statusLine } from "../server/exchanges/bybit-certification.js";

const REQUIRED_TABLES = [
  "adapter_certifications",
  "connection_health_snapshots",
  "venue_metadata_cache",
  "venue_time_sync_status",
  "venue_rate_limit_snapshots",
  "mainnet_validation_records",
  "execution_audit_logs",
  "exchange_accounts",
  "exchange_credentials",
  "account_risk_controls",
  "account_balances",
  "account_positions",
  "execution_orders"
];

const OPTIONAL_RPC_FUNCTIONS = [
  {
    name: "next_hyperliquid_nonce",
    required: false,
    reason: "Hyperliquid relay nonce allocation. Not required for Bybit, but required for the full Chapter V relay."
  }
];

const MIGRATION_HINTS = {
  adapter_certifications: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  connection_health_snapshots: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  venue_metadata_cache: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  venue_time_sync_status: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  venue_rate_limit_snapshots: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  mainnet_validation_records: "2026-07-11 - Phase III Chapter XI Universal Connectivity Certification",
  execution_audit_logs: "Portfolio Manager / execution baseline tables",
  exchange_accounts: "Portfolio Manager / execution baseline tables",
  exchange_credentials: "Portfolio Manager / execution baseline tables",
  account_risk_controls: "Portfolio Manager / execution baseline tables",
  account_balances: "Portfolio Manager / execution baseline tables",
  account_positions: "Portfolio Manager / execution baseline tables",
  execution_orders: "Portfolio Manager / execution baseline tables"
};

const results = [];

try {
  const supabase = getSupabaseAdmin();
  await verifyTables(supabase);
  await verifyRpcFunctions(supabase);
  printResults();

  const criticalFailures = results.filter((item) => item.status === "FAIL");
  if (criticalFailures.length > 0) {
    console.error("\nBybit infrastructure verification failed. Apply the migration sections named above, then rerun npm run verify:bybit-infrastructure.");
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(statusLine("FAIL", "supabase-admin", message));
  process.exitCode = 1;
}

async function verifyTables(supabase) {
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true }).limit(0);
    if (error) {
      results.push({
        status: "FAIL",
        label: `table:${table}`,
        message: `${error.message}. Required migration: ${MIGRATION_HINTS[table] || "see docs/SUPABASE_MIGRATIONS.md"}.`
      });
    } else {
      results.push({ status: "PASS", label: `table:${table}`, message: "available" });
    }
  }
}

async function verifyRpcFunctions(supabase) {
  for (const rpc of OPTIONAL_RPC_FUNCTIONS) {
    const { error } = await supabase.rpc(rpc.name, {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_credential_id: "00000000-0000-0000-0000-000000000000",
      p_agent_wallet_address: "0x0000000000000000000000000000000000000000",
      p_network: "testnet"
    });
    if (!error) {
      results.push({ status: "PASS", label: `rpc:${rpc.name}`, message: "available" });
      continue;
    }

    const missing = /could not find|function .* does not exist|schema cache/i.test(error.message);
    results.push({
      status: rpc.required || missing ? "WARNING" : "WARNING",
      label: `rpc:${rpc.name}`,
      message: missing ? `${rpc.reason} Apply the Chapter V nonce migration before Hyperliquid relay validation.` : `present but rejected test call as expected: ${error.message}`
    });
  }
}

function printResults() {
  console.log("Black Terminal Bybit infrastructure verification\n");
  for (const result of results) {
    console.log(statusLine(result.status, result.label, result.message));
  }
}
