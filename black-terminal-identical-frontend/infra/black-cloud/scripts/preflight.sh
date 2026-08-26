#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MODE=${1:-staging}

fail(){ printf 'PRECHECK FAIL: %s\n' "$*" >&2; exit 1; }
pass(){ printf 'PRECHECK PASS: %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || fail "Docker is unavailable"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"
compose_version=$(docker compose version --short | sed 's/^v//')
test "$(printf '%s\n' 2.24.4 "$compose_version" | sort -V | head -n 1)" = 2.24.4 || fail "Docker Compose >=2.24.4 is required for fail-closed port overrides"
command -v git >/dev/null 2>&1 || fail "Git is unavailable"
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is unavailable"
pass "Docker, Compose, Git, and OpenSSL are available"

memory_kib=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
disk_kib=$(df -Pk "$INFRA_DIR" | awk 'NR == 2 {print $4}')
test "${memory_kib:-0}" -ge 16000000 || fail "Black Cloud requires at least 16 GiB RAM for the complete container set"
test "${disk_kib:-0}" -ge 60000000 || fail "Black Cloud requires at least 60 GiB free storage before import"
pass "capacity floor met: memory_kib=$memory_kib free_disk_kib=$disk_kib"

test -f "$INFRA_DIR/.env" || fail "$INFRA_DIR/.env is missing"
test -f "$INFRA_DIR/secrets/runtime.env" || fail "runtime secret environment is missing"
env_mode=$((8#$(stat -c '%a' "$INFRA_DIR/.env")))
runtime_mode=$((8#$(stat -c '%a' "$INFRA_DIR/secrets/runtime.env")))
test $((env_mode & 8#077)) = 0 || fail ".env must not be group/world readable"
test $((runtime_mode & 8#077)) = 0 || fail "runtime.env must not be group/world readable"
grep -Eq '^BLACK_CLOUD_SUPABASE_STATE_ROOT=/var/lib/black-cloud/supabase$' "$INFRA_DIR/.env" || fail "Supabase state must remain outside immutable releases at /var/lib/black-cloud/supabase"
qalc_data_root=$(sed -n 's/^QALC_DATA_ROOT=//p' "$INFRA_DIR/.env" | head -n 1)
test "${qalc_data_root:-/var/lib/black-cloud/qalc}" = "/var/lib/black-cloud/qalc" || fail "QALC data must remain outside immutable releases at /var/lib/black-cloud/qalc"

if [ "$MODE" = staging ]; then
  compose_overlay="$INFRA_DIR/docker-compose.staging.yml"
  grep -Eq '^BLACK_CLOUD_GATEWAY_BIND=127\.0\.0\.1:' "$INFRA_DIR/.env" || fail "staging gateway must bind to host loopback"
  grep -Eq '^BLACK_CLOUD_CADDYFILE=\./Caddyfile\.staging$' "$INFRA_DIR/.env" || fail "staging must use Caddyfile.staging"
  for flag in BLACK_CLOUD_EXECUTION_ENABLED INVESTMENT_GROUP_EXECUTION_ENABLED BYBIT_CLOUD_EXECUTION_ENABLED BLACK_CLOUD_MAINNET_ENABLED BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED; do
    grep -Eq "^${flag}=false$" "$INFRA_DIR/secrets/runtime.env" || fail "$flag must remain false in staging"
  done
  pass "staging is loopback-only and every live-execution gate is disabled"
elif [ "$MODE" = production ]; then
  compose_overlay="$INFRA_DIR/docker-compose.production.yml"
  grep -Eq '^BLACK_CLOUD_CADDYFILE=\./Caddyfile\.production$' "$INFRA_DIR/.env" || fail "production must use Caddyfile.production"
  grep -Eq '^BLACK_CLOUD_CUTOVER_APPROVED=true$' "$INFRA_DIR/.env" || fail "production cutover requires an explicit BLACK_CLOUD_CUTOVER_APPROVED=true decision"
  grep -Eq '^BLACK_CLOUD_PUBLIC_URL=https://[^/]+/?$' "$INFRA_DIR/.env" || fail "production public URL must be HTTPS"
  grep -Eq '^BLACK_CLOUD_DOMAIN=[A-Za-z0-9.-]+$' "$INFRA_DIR/.env" || fail "production domain is missing"
  ! grep -Eq '^BLACK_CLOUD_DOMAIN=.*(invalid|localhost)$' "$INFRA_DIR/.env" || fail "production domain is still a placeholder"

  required_runtime_values=(
    CLAUDE_API_KEY RESEND_API_KEY RESEND_FROM GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
    EXCHANGE_CREDENTIAL_MASTER_KEY BLACK_CLOUD_SECRET_MASTER_KEY_V1 BLACK_CLOUD_INTENT_SIGNING_KEY
  )
  for key in "${required_runtime_values[@]}"; do
    value=$(sed -n "s/^${key}=//p" "$INFRA_DIR/secrets/runtime.env" | head -n 1)
    test -n "$value" || fail "$key is required for full production parity"
    printf '%s' "$value" | grep -Eiq 'replace-with|placeholder|example' && fail "$key still contains a placeholder"
  done
  grep -Eq '^BYBIT_MAINNET_VALIDATION_ENABLED=true$' "$INFRA_DIR/secrets/runtime.env" || fail "production manual Bybit connectivity requires BYBIT_MAINNET_VALIDATION_ENABLED=true"
  bybit_symbols=$(sed -n 's/^BYBIT_MAINNET_ALLOWED_SYMBOLS=//p' "$INFRA_DIR/secrets/runtime.env" | head -n 1)
  test -n "$bybit_symbols" || fail "production manual Bybit connectivity requires a non-empty symbol policy"

  backup_env=${BLACK_CLOUD_BACKUP_ENV_FILE:-$INFRA_DIR/secrets/backup.env}
  test -f "$backup_env" || fail "production backup environment is missing"
  backup_mode=$((8#$(stat -c '%a' "$backup_env")))
  test $((backup_mode & 8#077)) = 0 || fail "backup.env must not be group/world readable"
  restic_repository=$(sed -n 's/^RESTIC_REPOSITORY=//p' "$backup_env" | head -n 1)
  printf '%s' "$restic_repository" | grep -Eq '^(s3:|sftp:|rest:|rclone:)' || fail "production Restic repository must be off-host"
  pass "production secrets, OAuth continuity and off-host backup prerequisites are present"
else
  fail "mode must be staging or production"
fi

if ss -ltnH | awk '{print $4}' \
  | awk '/(^|:)5432$|(^|:)6543$|(^|:)6379$|(^|:)9000$/ && !/^127\.0\.0\.1:/ && !/^\[?::1\]?:/' \
  | grep -q .; then
  fail "a database/cache/object-store port is exposed beyond host loopback"
fi
pass "no prohibited data-plane port is exposed beyond host loopback"

docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$compose_overlay" config --quiet
pass "Black Cloud application Compose model is valid"
