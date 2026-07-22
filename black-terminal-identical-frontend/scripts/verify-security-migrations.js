import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const requiredTables = [
  "market_depth_collector_status", "market_depth_memory", "market_depth_rollups", "market_depth_snapshots", "market_depth_deltas",
  "market_depth_statistics", "market_liquidity_events", "market_liquidity_walls", "broker_connection_capabilities",
  "broker_connection_health", "broker_secret_references", "broker_secret_vault", "execution_audit_events", "execution_commands",
  "execution_command_attempts", "execution_incidents", "follower_execution_plans", "group_execution_mandates",
  "group_trade_intents", "reconciliation_runs", "api_rate_limit_counters", "ai_daily_usage", "security_audit_events",
  "execution_audit_archive", "book_heatmap_depth_chunks", "book_heatmap_collector_coverage"
];

const allowMissing = process.argv.includes("--allow-missing");
const supabase = process.env.SUPABASE_BIN || "supabase";
let output;
try {
  output = execFileSync(supabase, ["inspect", "db", "table-stats", "--linked"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  console.error("Unable to inspect the linked Supabase database.");
  process.exit(1);
}
let inspection;
try {
  inspection = JSON.parse(output);
} catch {
  console.error("Supabase table inspection did not return valid JSON.");
  process.exit(1);
}
const liveTables = new Set((inspection.rows || []).map((row) => String(row.name || "").replace(/^public\./, "")).filter(Boolean));
const missing = requiredTables.filter((table) => !liveTables.has(table));

const migrationDirectory = path.join(process.cwd(), "supabase", "migrations");
const migrationSql = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql"))
  .map((name) => fs.readFileSync(path.join(migrationDirectory, name), "utf8")).join("\n");
const undefinedInMigrations = missing.filter((table) => !new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, "i").test(migrationSql));
if (undefinedInMigrations.length) {
  console.error(`Migration verification failed: no idempotent CREATE TABLE for ${undefinedInMigrations.join(", ")}`);
  process.exit(1);
}
console.log(`Live required tables: ${requiredTables.length - missing.length}/${requiredTables.length}`);
if (missing.length) console.log(`Expected pre-migration gaps: ${missing.join(", ")}`);
if (missing.length && !allowMissing) process.exit(1);
console.log("Migration verification passed: live state and idempotent migration coverage are consistent.");
