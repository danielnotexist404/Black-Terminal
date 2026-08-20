#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
BACKUP_ENV=${BLACK_CLOUD_BACKUP_ENV_FILE:-$INFRA_DIR/secrets/backup.env}

test -f "$BACKUP_ENV" || { echo "Backup environment file is missing." >&2; exit 1; }
password=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n 1)
test -n "$password" || { echo "The deployed database password is unavailable." >&2; exit 1; }

temp_file=$(mktemp "$INFRA_DIR/secrets/backup.env.XXXXXX")
cleanup(){ test ! -e "$temp_file" || rm -f "$temp_file"; }
trap cleanup EXIT
awk -F= -v password="$password" '
  BEGIN { updated=0 }
  $1 == "PGPASSWORD" { print "PGPASSWORD=" password; updated += 1; next }
  { print }
  END { if (updated != 1) exit 42 }
' "$BACKUP_ENV" > "$temp_file" || { echo "Backup environment must contain exactly one PGPASSWORD entry." >&2; exit 1; }
chmod 600 "$temp_file"
mv "$temp_file" "$BACKUP_ENV"
trap - EXIT
printf 'Backup database credential synchronized without exposing secret material.\n'
