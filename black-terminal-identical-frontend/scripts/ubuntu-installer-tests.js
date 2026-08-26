import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const installerPath = "infra/black-cloud/install-ubuntu-server.sh";
const migrationRunnerPath = "infra/black-cloud/scripts/apply-repository-migrations.sh";
const readinessPath = "infra/black-cloud/scripts/require-database-ready.sh";
const installer = fs.readFileSync(installerPath, "utf8");
const migrationRunner = fs.readFileSync(migrationRunnerPath, "utf8");
const readiness = fs.readFileSync(readinessPath, "utf8");
const compose = fs.readFileSync("infra/black-cloud/docker-compose.yml", "utf8");
const ledger = fs.readFileSync("infra/black-cloud/supabase/applied-migration-ledger.txt", "utf8").trim().split("\n");
const migrations = fs.readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();

for (const shellFile of [installerPath, migrationRunnerPath, readinessPath]) {
  const syntax = spawnSync("bash", ["-n", shellFile], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${shellFile} must pass bash -n: ${syntax.stderr}`);
}

const dryRun = spawnSync(installerPath, ["--dry-run"], { encoding: "utf8" });
assert.equal(dryRun.status, 0, `dry run failed: ${dryRun.stderr}`);
assert.match(dryRun.stdout, /mode:\s+staging/);
assert.match(dryRun.stdout, /analytics\/IMM\/BCLIF:\s+true/);
assert.match(dryRun.stdout, /real-funds worker:\s+false/);
assert.match(dryRun.stdout, /DNS changes:\s+never/);
assert.match(dryRun.stdout, /firewall changes:\s+never/);

const unacknowledgedLive = spawnSync(installerPath, [
  "--mode", "production",
  "--domain", "terminal.example.com",
  "--tls-email", "ops@example.com",
  "--enable-live-execution",
  "--dry-run"
], { encoding: "utf8" });
assert.notEqual(unacknowledgedLive.status, 0, "live execution must require a second explicit acknowledgement");
assert.match(unacknowledgedLive.stderr, /acknowledge-real-funds/);

assert.match(installer, /download\.docker\.com\/linux\/ubuntu/, "Docker must come from its official Ubuntu apt repository");
assert.match(installer, /docker-ce docker-ce-cli containerd\.io docker-buildx-plugin docker-compose-plugin/);
assert.match(installer, /Docker Compose >=2\.24\.4/, "installer must support Compose's destructive-list override tag before starting Supabase");
assert.match(installer, /22\.04\|24\.04\|26\.04/);
assert.match(installer, /\[ -e "\$INSTALL_ROOT\/current" \] \|\| \[ -L "\$INSTALL_ROOT\/current" \]/, "fresh installer must refuse existing or dangling installation links");
assert.match(installer, /state_already_present[\s\S]*RESUME_MARKER/, "pre-existing persistent state must require an exact resume marker");
assert.match(installer, /git[^\n]+archive[^\n]+"\$SOURCE_COMMIT"/, "release must be exported from an immutable commit");
assert.match(installer, /BLACK_CLOUD_SUPABASE_STATE_ROOT[^\n]+"\$STATE_ROOT\/supabase"/);
assert.match(installer, /SUPABASE_SELF_HOSTED_COMMIT=549db119c44c25167461812041ba198bde2b31a4/);
assert.match(installer, /BLACK_CLOUD_IMAGE_DIGEST[^\n]+"\$BCLIF_IMAGE_DIGEST"/, "execution workers must receive the built immutable image digest");
assert.match(installer, /BLACK_CLOUD_WORKER_REGION[^\n]+"\$REGION"/);
assert.match(installer, /a rclone: Restic repository requires --rclone-config/);
assert.match(installer, /execution_rows[^\n]+public\.execution_orders/);
assert.match(installer, /black_cloud_backup_complete/, "installer must observe a completed first encrypted backup");
assert.match(installer, /wait_container_running black-cloud-observability/, "requested observability services must be verified running");
assert.match(installer, /No DNS or firewall rules were changed; no real order was submitted/);
assert.doesNotMatch(installer, /^\s*(?:source|\.)\s+.*PRIVATE_ENV/m, "private environment files must never be sourced as shell code");
assert.doesNotMatch(installer, /docker compose[^\n]+config(?! --quiet)/, "resolved Compose secrets must never be printed");
assert.doesNotMatch(installer, /\bufw\b|\biptables\b|\bnft\b|cloudflare|route53/i, "installer must not mutate firewall or DNS control planes");
assert.doesNotMatch(installer, /docker\s+(?:compose\s+)?down|docker\s+volume\s+rm|rm\s+-rf/, "installer must not delete containers, volumes, or broad paths");

assert.match(migrationRunner, /sha256sum/);
assert.match(migrationRunner, /checksum_sha256/);
assert.match(migrationRunner, /status in \('applying', 'applied', 'failed'\)/);
assert.match(migrationRunner, /--single-transaction/);
assert.match(migrationRunner, /--set ON_ERROR_STOP=1/);
assert.match(migrationRunner, /to_regclass\('public\.bt_users'\)/, "untracked existing application databases must fail closed");
assert.ok(migrationRunner.indexOf("to_regclass('public.bt_users')") < migrationRunner.indexOf("create schema if not exists black_terminal_ops"), "untracked schema guard must run before creating the checksum ledger");
assert.match(migrationRunner, /supabase_migrations\.schema_migrations/);
assert.match(migrationRunner, /Another repository migration process/, "concurrent migration runs must be locked out");

const ledgerFiles = ledger.map((entry) => `${entry.replace("|", "_")}.sql`).sort();
assert.deepEqual(ledgerFiles, migrations, "static restore ledger must match every repository migration exactly");
assert.ok(migrations.length >= 39, "the installer must retain the complete 39-migration baseline or newer");

assert.match(readiness, /RESTORE_VERIFIED/);
assert.match(readiness, /FRESH_INSTALL_VERIFIED/);
assert.match(compose, /STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED: \$\{STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED:-false\}/);
assert.match(compose, /STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED: \$\{STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED:-false\}/);
assert.match(compose, /BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH: \$\{BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH:-true\}/);
assert.match(compose, /profiles: \["live-execution"\]/, "real-funds worker must remain isolated in its own profile");

for (const component of [
  "event-alpha-worker",
  "market-depth-worker",
  "bclif-collector",
  "qalc-worker",
  "strategy-automation-worker",
  "black-cloud-demo-execution-worker",
  "black-cloud-execution-worker"
]) {
  assert.match(installer, new RegExp(component), `installer must account for ${component}`);
}

console.log(`Ubuntu installer contracts PASS — immutable release, all ${migrations.length} migrations, complete Docker topology, secret isolation, and fail-closed execution defaults verified.`);
