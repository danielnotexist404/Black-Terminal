#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="${1:-$(cd "$script_dir/.." && pwd -P)}"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

run_gate() {
  local label="$1"
  shift
  printf 'GATE START %s\n' "$label"
  "$@"
  printf 'GATE PASS %s\n' "$label"
}

for command_name in bash git node npm npx docker awk tee; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required certification command missing: $command_name"
done
[[ "$(git -C "$repository_dir" rev-parse --is-inside-work-tree 2>/dev/null || true)" == "true" ]] \
  || fail "certification target is not a Git checkout"
[[ "$(node --version)" == v22.* ]] || fail "formal collector certification requires Node 22"
git -C "$repository_dir" diff --quiet || fail "formal certification refuses an unstaged working tree"
git -C "$repository_dir" diff --cached --quiet || fail "formal certification refuses a staged working tree"
[[ -z "$(git -C "$repository_dir" status --porcelain --untracked-files=normal)" ]] \
  || fail "formal certification refuses tracked or untracked working-tree changes"
certified_commit="$(git -C "$repository_dir" rev-parse HEAD)"
[[ "$certified_commit" =~ ^[a-fA-F0-9]{40}$ ]] || fail "unable to resolve an exact Git commit"
[[ "${BCLIF_UPDATE_GOLDENS:-0}" != "1" ]] || fail "formal certification may not update visual goldens"
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"

required_test_files=(
  scripts/bclif-collector-tests.ts
  scripts/bclif-orderbook-tests.ts
  scripts/bclif-recovery-tests.ts
  scripts/bclif-tile-codec-tests.ts
  scripts/bclif-no-lookahead-tests.ts
  scripts/bclif-collector-benchmarks.ts
  scripts/bclif-operational-clarity-tests.ts
  scripts/bclif-operational-performance.ts
  scripts/bclif-visual-regression.js
)
for test_file in "${required_test_files[@]}"; do
  [[ -f "$repository_dir/$test_file" ]] || fail "required collector gate is missing: $test_file"
done

required_package_scripts=(
  test:bclif-api-security test:bclif-migration-contracts test:bclif-client-contracts
  test:bclif-collector test:bclif-orderbook test:bclif-recovery test:bclif-tile-codec
  test:bclif-no-lookahead test:bclif-collector-contracts benchmark:bclif-collector
  test:bclif-operational-clarity benchmark:bclif-operational
  test:bclif-visual bclif:collector bclif:preflight bclif:build bclif:deploy bclif:status
  bclif:drain bclif:restart bclif:rollback bclif:certify bclif:soak
)
node -e '
  const manifest = require(process.argv[1]);
  const missing = process.argv.slice(2).filter((name) => !manifest.scripts?.[name]);
  if (missing.length) {
    console.error(`Missing package scripts: ${missing.join(", ")}`);
    process.exit(1);
  }
' "$repository_dir/package.json" "${required_package_scripts[@]}"

cd "$repository_dir"
run_gate deployment-shell-syntax bash -n \
  scripts/bclif-collector-preflight.sh scripts/deploy-bclif-collector.sh \
  scripts/bclif-collector-certification.sh scripts/bclif-collector-soak.sh
run_gate frontend-typecheck npm run typecheck
run_gate production-build npm run build
run_gate collector-typecheck npx tsc --noEmit -p tsconfig.bclif-collector.json
run_gate model-regression npm run test:liquidation-heatmap
run_gate operational-clarity npm run test:bclif-operational-clarity
run_gate api-security npm run test:bclif-api-security
run_gate migration-contracts npm run test:bclif-migration-contracts
run_gate client-contracts npm run test:bclif-client-contracts
run_gate collector-contracts npm run test:bclif-collector
run_gate orderbook-reconstruction npm run test:bclif-orderbook
run_gate checkpoint-recovery npm run test:bclif-recovery
run_gate tile-codec npm run test:bclif-tile-codec
run_gate chronological-no-lookahead npm run test:bclif-no-lookahead
run_gate collector-benchmarks npm run benchmark:bclif-collector
run_gate operational-benchmarks npm run benchmark:bclif-operational
run_gate security-contracts npm run security:contracts
run_gate migration-source-security npm run security:verify-migration-source

export BCLIF_ENV_FILE="$repository_dir/.env.liquidation-intelligence.example"
export BCLIF_IMAGE_REFERENCE="black-terminal-bclif:${certified_commit}"
export BCLIF_IMAGE_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"
export BCLIF_DEPLOYMENT_COMMIT="$certified_commit"
run_gate compose-contract docker compose \
  --env-file "$repository_dir/.env.liquidation-intelligence.example" \
  --file "$repository_dir/docker-compose.liquidation-intelligence.yml" config --quiet

visual_report="$(mktemp -t bclif-visual-certification.XXXXXX.json)"
trap 'rm -f "$visual_report"' EXIT
printf 'GATE START visual-regression\n'
set +e
node scripts/bclif-visual-regression.js | tee "$visual_report"
visual_status="${PIPESTATUS[0]}"
set -e
(( visual_status == 0 )) || fail "visual regression process failed"
visual_decision="$(node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(report.decision || "MISSING"));
' "$visual_report" 2>/dev/null || true)"
[[ "$visual_decision" == "PASS" ]] \
  || fail "formal visual certification requires PASS; observed ${visual_decision:-UNPARSEABLE} (SKIP is explicitly non-passing)"
printf 'GATE PASS visual-regression decision=PASS\n'

ended_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
elapsed_ms=$(( ended_ms - started_ms ))
artifact_dir="$repository_dir/tests/.artifacts/bclif"
mkdir -p "$artifact_dir"
certificate_path="$artifact_dir/collector-certification-${certified_commit}.json"
node -e '
  const fs = require("node:fs");
  const [path, commit, started, ended, elapsed] = process.argv.slice(1);
  fs.writeFileSync(path, `${JSON.stringify({
    decision: "PASS",
    commit,
    nodeVersion: process.version,
    startedAtMs: Number(started),
    endedAtMs: Number(ended),
    exactDurationMs: Number(elapsed),
    visualDecision: "PASS",
    migrationAction: "NOT_RUN"
  }, null, 2)}\n`, { mode: 0o600 });
' "$certificate_path" "$certified_commit" "$started_ms" "$ended_ms" "$elapsed_ms"

printf 'CERTIFICATION PASS commit=%s exact-duration-ms=%s visual=PASS migration-action=NOT_RUN report=%s\n' \
  "$certified_commit" "$elapsed_ms" "$certificate_path"
