#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_REF=${SUPABASE_PROJECT_REF:-}
SSH_TARGET=${BLACK_CLOUD_SSH_TARGET:-}
SSH_KEY=${BLACK_CLOUD_SSH_KEY:-}
OUTPUT_FILE=${BLACK_CLOUD_COMPATIBILITY_CATALOG:-}
TUNNEL_PORT=${BLACK_CLOUD_COMPATIBILITY_TUNNEL_PORT:-25433}

test -n "$PROJECT_REF" && test -n "$SSH_TARGET" && test -n "$SSH_KEY" && test -n "$OUTPUT_FILE" \
  || { echo "SUPABASE_PROJECT_REF, BLACK_CLOUD_SSH_TARGET, BLACK_CLOUD_SSH_KEY and BLACK_CLOUD_COMPATIBILITY_CATALOG are required." >&2; exit 1; }
test -f "$SSH_KEY" || { echo "SSH key is missing." >&2; exit 1; }
test ! -e "$OUTPUT_FILE" || { echo "Refusing to overwrite compatibility catalog." >&2; exit 1; }

work_dir=$(mktemp -d /tmp/bt-hosted-compatibility.XXXXXX)
tunnel_pid=''
remote_env=''
cleanup(){
  if [ -n "$remote_env" ]; then ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "rm -f '$remote_env'" >/dev/null 2>&1 || true; fi
  if [ -n "$tunnel_pid" ]; then kill "$tunnel_pid" 2>/dev/null || true; wait "$tunnel_pid" 2>/dev/null || true; fi
  rm -r "$work_dir"
}
trap cleanup EXIT

(cd "$work_dir" && supabase init >/dev/null 2>&1 && supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1 && supabase db dump --schema public --dry-run > dry.sh 2>/dev/null)
sed -n '/^export PGHOST=/,/^export PGDATABASE=/p' "$work_dir/dry.sh" > "$work_dir/pg.env.sh"
. "$work_dir/pg.env.sh"

ssh -i "$SSH_KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N -R "127.0.0.1:${TUNNEL_PORT}:${PGHOST}:${PGPORT}" "$SSH_TARGET" &
tunnel_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "timeout 1 bash -c '</dev/tcp/127.0.0.1/${TUNNEL_PORT}'" >/dev/null 2>&1 && break
  sleep 1
done
kill -0 "$tunnel_pid" 2>/dev/null || { echo "SSH reverse database tunnel failed." >&2; exit 1; }

remote_env=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" 'umask 077; mktemp /tmp/bt-pg.XXXXXX')
case "$remote_env" in /tmp/bt-pg.*) ;; *) echo "Remote temporary path validation failed." >&2; exit 1;; esac
printf 'PGHOST=127.0.0.1\nPGPORT=%s\nPGUSER=%s\nPGPASSWORD=%s\nPGDATABASE=%s\nPGSSLMODE=require\n' "$TUNNEL_PORT" "$PGUSER" "$PGPASSWORD" "$PGDATABASE" > "$work_dir/pg.env"
base64 -w0 "$work_dir/pg.env" | ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "base64 -d > '$remote_env' && chmod 600 '$remote_env'"

umask 077
ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "bash -s -- compatibility '$remote_env'" < "$SCRIPT_DIR/remote-supabase-dump.sh" > "$OUTPUT_FILE"
test -s "$OUTPUT_FILE" || { echo "Compatibility catalog is empty." >&2; exit 1; }
chmod 600 "$OUTPUT_FILE"
printf 'Hosted Auth/Storage compatibility catalog written without application row data.\n'
