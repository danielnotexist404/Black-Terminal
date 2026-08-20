#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
MONITORING_ENV=${BLACK_CLOUD_MONITORING_ENV_FILE:-$INFRA_DIR/secrets/monitoring.env}

test -f "$MONITORING_ENV" || { echo "Monitoring environment file is missing." >&2; exit 1; }
password=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n 1)
test -n "$password" || { echo "The deployed database password is unavailable." >&2; exit 1; }

temp_file=$(mktemp "$INFRA_DIR/secrets/monitoring.env.XXXXXX")
cleanup(){ test ! -e "$temp_file" || rm -f "$temp_file"; }
trap cleanup EXIT
awk -F= -v password="$password" '
  BEGIN { updated=0 }
  $1 == "DATA_SOURCE_PASS" { print "DATA_SOURCE_PASS=" password; updated += 1; next }
  { print }
  END { if (updated != 1) exit 42 }
' "$MONITORING_ENV" > "$temp_file" || { echo "Monitoring environment must contain exactly one DATA_SOURCE_PASS entry." >&2; exit 1; }
chmod 600 "$temp_file"
mv "$temp_file" "$MONITORING_ENV"
trap - EXIT
printf 'PostgreSQL exporter credential synchronized without exposing secret material.\n'
