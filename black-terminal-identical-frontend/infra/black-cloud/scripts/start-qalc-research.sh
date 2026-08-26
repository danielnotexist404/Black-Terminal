#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MODE=${1:-staging}

test "$MODE" = staging -o "$MODE" = production || { echo "mode must be staging or production" >&2; exit 2; }
"$SCRIPT_DIR/require-database-ready.sh"
clock_safe=false
if command -v chronyc >/dev/null 2>&1 && chronyc tracking >/dev/null 2>&1 && chronyc tracking | grep -Eq '^Leap status[[:space:]]*:[[:space:]]*Normal$'; then
  clock_safe=true
elif command -v timedatectl >/dev/null 2>&1 && test "$(timedatectl show -p NTPSynchronized --value)" = yes; then
  clock_safe=true
fi
test "$clock_safe" = true || { echo "No synchronized chrony/systemd-timesyncd clock; refusing to start QALC." >&2; exit 1; }

"$SCRIPT_DIR/preflight.sh" "$MODE"
overlay="$INFRA_DIR/docker-compose.$MODE.yml"
docker compose --profile qalc-research --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$overlay" build api qalc-worker
docker compose --profile qalc-research --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$overlay" up -d --wait api qalc-data-init qalc-worker

printf 'BC-QALC Research capture started. Paper, live execution and Investment Group fanout remain disabled.\n'
