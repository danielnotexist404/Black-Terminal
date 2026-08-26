#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
"$SCRIPT_DIR/require-database-ready.sh"

"$SCRIPT_DIR/preflight.sh" staging
for flag in EVENT_ALPHA_LIVE_EXECUTION_ENABLED EVENT_ALPHA_PAPER_EXECUTION_ENABLED BLACK_CLOUD_EXECUTION_ENABLED INVESTMENT_GROUP_EXECUTION_ENABLED; do
  grep -Eq "^${flag}=false$" "$INFRA_DIR/secrets/runtime.env" || { echo "$flag must remain false for staging analytics." >&2; exit 1; }
done

compose=(docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$INFRA_DIR/docker-compose.staging.yml" --profile analytics)
"${compose[@]}" build event-alpha-worker market-depth-worker bclif-collector
deployment_commit=$(awk -F= '$1 == "BLACK_CLOUD_DEPLOYMENT_COMMIT" { print $2; exit }' "$INFRA_DIR/.env")
test -n "$deployment_commit" || { echo "BLACK_CLOUD_DEPLOYMENT_COMMIT is missing." >&2; exit 1; }
export BCLIF_IMAGE_DIGEST
BCLIF_IMAGE_DIGEST=$(docker image inspect "black-terminal-runtime:${deployment_commit}" --format '{{.Id}}')
[[ "$BCLIF_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Built BCLIF image has no immutable sha256 identity." >&2; exit 1; }
"${compose[@]}" up -d event-alpha-worker market-depth-worker bclif-collector
printf 'Non-trading Black Cloud analytics started; every execution worker remains stopped.\n'
