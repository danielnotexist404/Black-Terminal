#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_REF=${SUPABASE_PROJECT_REF:-}
SSH_TARGET=${BLACK_CLOUD_SSH_TARGET:-}
SSH_KEY=${BLACK_CLOUD_SSH_KEY:-}
OUTPUT_DIR=${BLACK_CLOUD_EXPORT_DIR:-}
PASSPHRASE_FILE=${BLACK_CLOUD_BACKUP_PASSPHRASE_FILE:-}
TUNNEL_PORT=${BLACK_CLOUD_EXPORT_TUNNEL_PORT:-25432}

for pair in "SUPABASE_PROJECT_REF:$PROJECT_REF" "BLACK_CLOUD_SSH_TARGET:$SSH_TARGET" "BLACK_CLOUD_SSH_KEY:$SSH_KEY" "BLACK_CLOUD_EXPORT_DIR:$OUTPUT_DIR" "BLACK_CLOUD_BACKUP_PASSPHRASE_FILE:$PASSPHRASE_FILE"; do
  name=${pair%%:*}; value=${pair#*:}; test -n "$value" || { echo "$name is required." >&2; exit 1; }
done
test -f "$SSH_KEY" || { echo "SSH key does not exist." >&2; exit 1; }
test -f "$PASSPHRASE_FILE" || { echo "Backup passphrase file does not exist." >&2; exit 1; }
test "$(stat -c '%a' "$PASSPHRASE_FILE")" -le 600 || { echo "Backup passphrase file must have mode 600 or stricter." >&2; exit 1; }
case "$OUTPUT_DIR" in /|/home|/home/*/.|"") echo "Unsafe export directory." >&2; exit 1;; esac
test ! -e "$OUTPUT_DIR" || { echo "Refusing to overwrite existing export directory." >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

work_dir=$(mktemp -d /tmp/bt-hosted-export.XXXXXX)
tunnel_pid=''
remote_env=''
cleanup(){
  if [ -n "$remote_env" ]; then ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "rm -f '$remote_env'" >/dev/null 2>&1 || true; fi
  if [ -n "$tunnel_pid" ]; then kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true; fi
  rm -r "$work_dir"
}
trap cleanup EXIT

command -v supabase >/dev/null 2>&1 || { echo "Supabase CLI is required on the controller." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "OpenSSL is required on the controller." >&2; exit 1; }

(cd "$work_dir" && supabase init >/dev/null 2>&1 && supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1)

fetch_credentials(){
  (cd "$work_dir" && supabase db dump --schema public --dry-run > dry.sh 2>/dev/null)
  sed -n '/^export PGHOST=/,/^export PGDATABASE=/p' "$work_dir/dry.sh" > "$work_dir/pg.env.sh"
  . "$work_dir/pg.env.sh"
  test -n "${PGHOST:-}" && test -n "${PGPORT:-}" && test -n "${PGUSER:-}" && test -n "${PGPASSWORD:-}" && test -n "${PGDATABASE:-}" \
    || { echo "Supabase CLI did not return complete temporary database credentials." >&2; exit 1; }
}

fetch_credentials
source_host=$PGHOST
source_port=$PGPORT

ssh -i "$SSH_KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N -R "127.0.0.1:${TUNNEL_PORT}:${PGHOST}:${PGPORT}" "$SSH_TARGET" &
tunnel_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "timeout 1 bash -c '</dev/tcp/127.0.0.1/${TUNNEL_PORT}'" >/dev/null 2>&1 && break
  sleep 1
done
kill -0 "$tunnel_pid" 2>/dev/null || { echo "SSH reverse database tunnel failed." >&2; exit 1; }

remote_env=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" 'umask 077; mktemp /tmp/bt-pg.XXXXXX')
case "$remote_env" in /tmp/bt-pg.*) ;; *) echo "Remote temporary path validation failed." >&2; exit 1;; esac

publish_fresh_credentials(){
  fetch_credentials
  test "$PGHOST" = "$source_host" && test "$PGPORT" = "$source_port" \
    || { echo "Supabase temporary credentials changed database endpoints during export." >&2; exit 1; }
  {
    printf 'PGHOST=127.0.0.1\nPGPORT=%s\nPGUSER=%s\nPGPASSWORD=%s\nPGDATABASE=%s\nPGSSLMODE=require\n' "$TUNNEL_PORT" "$PGUSER" "$PGPASSWORD" "$PGDATABASE"
  } > "$work_dir/pg.env"
  base64 -w0 "$work_dir/pg.env" | ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "base64 -d > '$remote_env' && chmod 600 '$remote_env'"
}

dump_mode(){
  mode=$1
  target="$OUTPUT_DIR/${mode}.sql.gz.enc"
  publish_fresh_credentials
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "bash -s -- '$mode' '$remote_env'" < "$SCRIPT_DIR/remote-supabase-dump.sh" \
    | gzip -9 \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$PASSPHRASE_FILE" -out "$target"
  test -s "$target" || { echo "$mode export is empty." >&2; exit 1; }
  (cd "$OUTPUT_DIR" && sha256sum "${mode}.sql.gz.enc" >> SHA256SUMS)
}

dump_mode roles
dump_mode schema
dump_mode data
publish_fresh_credentials
ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "bash -s -- verification '$remote_env'" < "$SCRIPT_DIR/remote-supabase-dump.sh" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$PASSPHRASE_FILE" -out "$OUTPUT_DIR/source-verification.tsv.enc"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSPHRASE_FILE" \
  -in "$OUTPUT_DIR/source-verification.tsv.enc" -out "$work_dir/source-verification.tsv"
for required_key in postgres_version auth_users public_tables public_functions public_policies storage_buckets storage_objects bt_users exchange_accounts execution_orders investment_groups profiles_extended; do
  grep -q "^${required_key}"$'\t' "$work_dir/source-verification.tsv" \
    || { echo "Source verification is missing $required_key." >&2; exit 1; }
done
(cd "$OUTPUT_DIR" && sha256sum source-verification.tsv.enc >> SHA256SUMS)

printf '{\n  "format": "black-cloud-supabase-export-v1",\n  "projectRef": "%s",\n  "createdAt": "%s",\n  "sourceCommit": "%s",\n  "encrypted": true,\n  "cipher": "AES-256-CBC/PBKDF2-SHA256/600000",\n  "storageObjectsIncluded": false\n}\n' \
  "$PROJECT_REF" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$SCRIPT_DIR/../../.." rev-parse HEAD)" > "$OUTPUT_DIR/manifest.json"
(cd "$OUTPUT_DIR" && sha256sum manifest.json >> SHA256SUMS)
chmod 600 "$OUTPUT_DIR"/*
printf 'Encrypted hosted Supabase export completed at %s (storage objects require the separate transfer stage).\n' "$OUTPUT_DIR"
