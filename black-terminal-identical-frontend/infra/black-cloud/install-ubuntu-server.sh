#!/usr/bin/env bash
set -Eeuo pipefail

# Black Terminal / Black Cloud fresh-server installer.
# Supported hosts: 64-bit Ubuntu 22.04, 24.04, or 26.04.
# The installer is intentionally fresh-host only. It does not import an existing
# database, change DNS/firewall policy, or enable real-funds execution by default.

MODE=staging
DOMAIN=
TLS_EMAIL=
PRIVATE_ENV=
RCLONE_CONFIG=
INSTALL_ROOT=/opt/black-cloud
STATE_ROOT=/var/lib/black-cloud
STAGING_PORT=18080
REGION=ap-southeast-1
WITH_ANALYTICS=true
WITH_QALC=true
WITH_OBSERVABILITY=true
WITH_BACKUP=true
WITH_PAPER_AUTOMATION=true
ENABLE_DEMO_EXECUTION=false
ENABLE_LIVE_EXECUTION=false
ACKNOWLEDGE_REAL_FUNDS=false
SKIP_DOCKER_INSTALL=false
DRY_RUN=false
CURRENT_PHASE=argument-validation

usage(){
  cat <<'USAGE'
Usage:
  sudo ./infra/black-cloud/install-ubuntu-server.sh [options]

Core options:
  --mode staging|production       Staging is loopback-only (default).
  --domain HOSTNAME               Required in production; DNS must already point here.
  --tls-email EMAIL               Required in production for Caddy/ACME.
  --private-env PATH              Mode-600 provider/continuity secret file.
  --rclone-config PATH            Mode-600 rclone config for a rclone: Restic repository.
  --install-root PATH             Immutable releases and shared config (default /opt/black-cloud).
  --staging-port PORT             Loopback staging port (default 18080).
  --region REGION                 Worker region label (default ap-southeast-1).
  --skip-docker-install           Require an existing Docker Engine + Compose v2.

Optional component switches:
  --without-analytics             Do not start Event Alpha, IMM depth, or BCLIF collectors.
  --without-qalc                  Do not start the BC-QALC research collector.
  --without-observability         Do not start Prometheus, Grafana, or exporters.
  --without-backup                Do not start Restic backups (staging only).
  --without-paper-automation      Do not start the paper strategy scheduler.

Execution switches (production only):
  --enable-demo-execution         Start the isolated Bybit Demo execution worker.
  --enable-live-execution         Request the isolated real-funds worker.
  --acknowledge-real-funds        Required together with --enable-live-execution.

Safety and inspection:
  --dry-run                       Print the resolved plan; make no changes and require no root.
  --help                          Show this help.

The private env is parsed as data, never sourced. It may provide provider keys,
Google OAuth continuity keys, encryption/signing continuity keys, and off-host
Restic credentials. Do not pass secret values on the command line.
USAGE
}

die(){
  printf 'INSTALL FAIL [%s]: %s\n' "$CURRENT_PHASE" "$*" >&2
  if [ -n "${FAILED_REPORT:-}" ] && declare -F on_error >/dev/null 2>&1; then on_error 1; fi
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE=${2:?--mode requires a value}; shift 2 ;;
    --domain) DOMAIN=${2:?--domain requires a value}; shift 2 ;;
    --tls-email) TLS_EMAIL=${2:?--tls-email requires a value}; shift 2 ;;
    --private-env) PRIVATE_ENV=${2:?--private-env requires a value}; shift 2 ;;
    --rclone-config) RCLONE_CONFIG=${2:?--rclone-config requires a value}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:?--install-root requires a value}; shift 2 ;;
    --staging-port) STAGING_PORT=${2:?--staging-port requires a value}; shift 2 ;;
    --region) REGION=${2:?--region requires a value}; shift 2 ;;
    --without-analytics) WITH_ANALYTICS=false; shift ;;
    --without-qalc) WITH_QALC=false; shift ;;
    --without-observability) WITH_OBSERVABILITY=false; shift ;;
    --without-backup) WITH_BACKUP=false; shift ;;
    --without-paper-automation) WITH_PAPER_AUTOMATION=false; shift ;;
    --enable-demo-execution) ENABLE_DEMO_EXECUTION=true; shift ;;
    --enable-live-execution) ENABLE_LIVE_EXECUTION=true; shift ;;
    --acknowledge-real-funds) ACKNOWLEDGE_REAL_FUNDS=true; shift ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

test "$MODE" = staging -o "$MODE" = production || die "mode must be staging or production"
case "$STAGING_PORT" in ''|*[!0-9]*) die "staging port must be numeric" ;; esac
test "$STAGING_PORT" -ge 1024 -a "$STAGING_PORT" -le 65535 || die "staging port must be between 1024 and 65535"
[[ "$REGION" =~ ^[A-Za-z0-9-]+$ ]] || die "region must contain only letters, digits, and hyphens"
case "$INSTALL_ROOT" in /opt/*|/srv/*) ;; *) die "install root must be an explicit path below /opt or /srv" ;; esac

if [ "$MODE" = production ]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "production requires a valid --domain"
  [[ "$TLS_EMAIL" == *@* ]] || die "production requires --tls-email"
  if [ "$DRY_RUN" = false ]; then
    test -n "$PRIVATE_ENV" || die "production requires --private-env"
    test "$WITH_BACKUP" = true || die "production cannot disable encrypted off-host backups"
  fi
else
  test "$ENABLE_DEMO_EXECUTION" = false -a "$ENABLE_LIVE_EXECUTION" = false || die "execution workers require production mode"
fi
if [ "$ENABLE_LIVE_EXECUTION" = true ] && [ "$ACKNOWLEDGE_REAL_FUNDS" != true ]; then
  die "real-funds worker requires both --enable-live-execution and --acknowledge-real-funds"
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || die "installer must run from a Git checkout"
SOURCE_COMMIT=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "source commit is not immutable"

if [ -n "$PRIVATE_ENV" ]; then
  PRIVATE_ENV=$(realpath "$PRIVATE_ENV")
  test -f "$PRIVATE_ENV" || die "private env does not exist"
  private_mode=$(stat -c '%a' "$PRIVATE_ENV")
  private_mode_bits=$((8#$private_mode))
  test $((private_mode_bits & 8#077)) = 0 || die "private env must not be group/world readable (mode 600 or stricter)"
fi
if [ -n "$RCLONE_CONFIG" ]; then
  RCLONE_CONFIG=$(realpath "$RCLONE_CONFIG")
  test -f "$RCLONE_CONFIG" || die "rclone config does not exist"
  rclone_mode=$(stat -c '%a' "$RCLONE_CONFIG")
  rclone_mode_bits=$((8#$rclone_mode))
  test $((rclone_mode_bits & 8#077)) = 0 || die "rclone config must not be group/world readable (mode 600 or stricter)"
fi

PUBLIC_URL="http://127.0.0.1:$STAGING_PORT"
GATEWAY_BIND="127.0.0.1:$STAGING_PORT"
CADDYFILE=./Caddyfile.staging
CUTOVER_APPROVED=false
BCLIF_ENVIRONMENT=STAGING
if [ "$MODE" = production ]; then
  PUBLIC_URL="https://$DOMAIN"
  GATEWAY_BIND=0.0.0.0:443
  CADDYFILE=./Caddyfile.production
  CUTOVER_APPROVED=true
  BCLIF_ENVIRONMENT=PRODUCTION
fi

if [ "$DRY_RUN" = true ]; then
  cat <<PLAN
Black Cloud Ubuntu installation plan
  source commit:       $SOURCE_COMMIT
  mode:                $MODE
  public URL:          $PUBLIC_URL
  install root:        $INSTALL_ROOT
  persistent state:    $STATE_ROOT
  worker region:       $REGION
  analytics/IMM/BCLIF: $WITH_ANALYTICS
  BC-QALC research:    $WITH_QALC
  observability:       $WITH_OBSERVABILITY
  encrypted backup:   $WITH_BACKUP
  paper automation:    $WITH_PAPER_AUTOMATION
  demo execution:      $ENABLE_DEMO_EXECUTION
  real-funds worker:   $ENABLE_LIVE_EXECUTION
  DNS changes:         never
  firewall changes:    never
PLAN
  exit 0
fi

test "$(id -u)" = 0 || die "run the installer with sudo/root"
if [ -e "$INSTALL_ROOT/current" ] || [ -L "$INSTALL_ROOT/current" ]; then
  die "an installed release already exists; this fresh-host installer will not overwrite it"
fi
RESUME_MARKER="$INSTALL_ROOT/.fresh-install-${SOURCE_COMMIT}.in-progress"
state_already_present=false
for protected_path in "$STATE_ROOT/supabase/postgres" "$INSTALL_ROOT/shared-secrets" "$INSTALL_ROOT/vendor/supabase/docker/.env"; do
  if [ -f "$protected_path" ] || { [ -d "$protected_path" ] && find "$protected_path" -mindepth 1 -print -quit 2>/dev/null | grep -q .; }; then
    state_already_present=true
  fi
done
if [ "$state_already_present" = true ] && [ ! -f "$RESUME_MARKER" ]; then
  die "persistent Black Cloud state already exists without this installer's resume marker"
fi
install -d -m 0755 "$INSTALL_ROOT"
if [ ! -f "$RESUME_MARKER" ]; then
  install -m 0600 /dev/null "$RESUME_MARKER"
fi

REPORT_DIR="$STATE_ROOT/installations"
install -d -m 0750 "$REPORT_DIR"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FAILED_REPORT="$REPORT_DIR/${STARTED_AT//:/-}-${SOURCE_COMMIT:0:12}-failed.txt"
on_error(){
  status=${1:-$?}
  trap - ERR
  {
    printf 'status=FAILED\n'
    printf 'started_at=%s\n' "$STARTED_AT"
    printf 'failed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'phase=%s\n' "$CURRENT_PHASE"
    printf 'source_commit=%s\n' "$SOURCE_COMMIT"
    printf 'exit_status=%s\n' "$status"
    printf 'recovery=Inspect container state and this phase; no automatic rollback or volume deletion was attempted.\n'
  } > "$FAILED_REPORT"
  chmod 0640 "$FAILED_REPORT"
  exit "$status"
}
trap on_error ERR

CURRENT_PHASE=host-validation
test -r /etc/os-release || die "cannot identify the operating system"
. /etc/os-release
test "${ID:-}" = ubuntu || die "only Ubuntu Server is supported"
case "${VERSION_ID:-}" in 22.04|24.04|26.04) ;; *) die "supported Ubuntu releases are 22.04, 24.04, and 26.04" ;; esac
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) die "supported architectures are amd64 and arm64" ;; esac
memory_kib=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
disk_kib=$(df -Pk "$(dirname -- "$INSTALL_ROOT")" 2>/dev/null | awk 'NR == 2 {print $4}')
test "${memory_kib:-0}" -ge 16000000 || die "complete Black Cloud requires at least 16 GiB RAM"
test "${disk_kib:-0}" -ge 60000000 || die "at least 60 GiB free storage is required"

CURRENT_PHASE=host-packages
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq openssl rsync chrony iproute2 tar python3-minimal
if [ "$SKIP_DOCKER_INSTALL" = false ] && command -v docker >/dev/null 2>&1; then
  dpkg-query -W -f='${Status}' docker-ce 2>/dev/null | grep -q 'install ok installed' || die "existing Docker is not the approved docker-ce package; inspect it and rerun with --skip-docker-install only if explicitly accepted"
fi
if [ "$SKIP_DOCKER_INSTALL" = false ] && ! command -v docker >/dev/null 2>&1; then
  for conflicting in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$conflicting" 2>/dev/null | grep -q 'install ok installed'; then
      die "conflicting package '$conflicting' is installed; remove it deliberately before using Docker's official repository"
    fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<DOCKER_REPOSITORY
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER_REPOSITORY
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  for command_name in curl git jq openssl rsync chronyc ss tar python3 docker; do
    command -v "$command_name" >/dev/null 2>&1 || die "required host command is missing: $command_name"
  done
fi
systemctl enable --now docker
systemctl enable --now chrony
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable"
compose_version=$(docker compose version --short | sed 's/^v//')
test "$(printf '%s\n' 2.24.4 "$compose_version" | sort -V | head -n 1)" = 2.24.4 || die "Docker Compose >=2.24.4 is required for fail-closed port overrides"

CURRENT_PHASE=immutable-release
RELEASE_DIR="$INSTALL_ROOT/releases/$SOURCE_COMMIT"
SHARED_SECRETS="$INSTALL_ROOT/shared-secrets"
SUPABASE_VENDOR_DIR="$INSTALL_ROOT/vendor/supabase"
install -d -m 0755 "$INSTALL_ROOT/releases" "$INSTALL_ROOT/vendor"
install -d -m 0700 "$SHARED_SECRETS" "$SHARED_SECRETS/rclone"
install -d -m 0750 "$STATE_ROOT/supabase/postgres" "$STATE_ROOT/supabase/storage" "$STATE_ROOT/qalc" "$STATE_ROOT/restic"
if [ ! -d "$RELEASE_DIR" ]; then
  release_stage=$(mktemp -d "$INSTALL_ROOT/releases/.stage-${SOURCE_COMMIT:0:12}.XXXXXX")
  git -C "$SOURCE_ROOT" archive --format=tar "$SOURCE_COMMIT" | tar -xf - -C "$release_stage"
  printf '%s\n' "$SOURCE_COMMIT" > "$release_stage/.black-cloud-source-sha"
  chmod -R a-w "$release_stage"
  mv "$release_stage" "$RELEASE_DIR"
fi
test "$(cat "$RELEASE_DIR/.black-cloud-source-sha")" = "$SOURCE_COMMIT" || die "existing release identity does not match source commit"
INFRA_DIR="$RELEASE_DIR/infra/black-cloud"

upsert_env(){
  key=$1; value=$2; file=$3
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || die "invalid environment key"
  [[ "$value" != *$'\n'* ]] || die "multiline environment values are unsupported"
  temp=$(mktemp "${file}.tmp.XXXXXX")
  if [ -f "$file" ]; then awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$temp"; fi
  printf '%s=%s\n' "$key" "$value" >> "$temp"
  chmod 0600 "$temp"
  mv "$temp" "$file"
}

env_raw(){ awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1"; }

import_key(){
  key=$1; source_file=$2; target_file=$3
  test -n "$source_file" || return 0
  value=$(env_raw "$source_file" "$key")
  test -n "$value" || return 0
  upsert_env "$key" "$value" "$target_file"
}

ensure_generated_key(){
  key=$1; bytes=$2; file=$3; encoding=${4:-base64}
  value=$(env_raw "$file" "$key")
  if [ -z "$value" ] || printf '%s' "$value" | grep -Eiq 'replace-with|placeholder|example'; then
    if [ "$encoding" = hex ]; then value=$(openssl rand -hex "$bytes"); else value=$(openssl rand -base64 "$bytes" | tr -d '\n'); fi
    upsert_env "$key" "$value" "$file"
  fi
}

CURRENT_PHASE=private-configuration
RUNTIME_ENV="$SHARED_SECRETS/runtime.env"
BACKUP_ENV="$SHARED_SECRETS/backup.env"
MONITORING_ENV="$SHARED_SECRETS/monitoring.env"
test -f "$RUNTIME_ENV" || install -m 0600 "$INFRA_DIR/secrets/runtime.env.example" "$RUNTIME_ENV"
test -f "$BACKUP_ENV" || install -m 0600 "$INFRA_DIR/secrets/backup.env.example" "$BACKUP_ENV"
test -f "$MONITORING_ENV" || install -m 0600 "$INFRA_DIR/secrets/monitoring.env.example" "$MONITORING_ENV"

runtime_imports=(
  CLAUDE_API_KEY RESEND_API_KEY RESEND_FROM GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
  EXCHANGE_CREDENTIAL_MASTER_KEY BLACK_CLOUD_SECRET_MASTER_KEY_V1 BLACK_CLOUD_MASTER_KEY_VERSION
  BLACK_CLOUD_INTENT_SIGNING_KEY IMM_BASE_URL IMM_ENDPOINT IMM_SHARED_HMAC_KEY IMM_PROTOCOL_VERSION
  BYBIT_MAINNET_ALLOWED_SYMBOLS BYBIT_ENDPOINT_PROFILE
)
backup_imports=(RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION)
monitoring_imports=(GF_SECURITY_ADMIN_USER GF_SECURITY_ADMIN_PASSWORD)
for key in "${runtime_imports[@]}"; do import_key "$key" "$PRIVATE_ENV" "$RUNTIME_ENV"; done
for key in "${backup_imports[@]}"; do import_key "$key" "$PRIVATE_ENV" "$BACKUP_ENV"; done
for key in "${monitoring_imports[@]}"; do import_key "$key" "$PRIVATE_ENV" "$MONITORING_ENV"; done

ensure_generated_key EXCHANGE_CREDENTIAL_MASTER_KEY 32 "$RUNTIME_ENV"
ensure_generated_key BLACK_CLOUD_SECRET_MASTER_KEY_V1 32 "$RUNTIME_ENV"
ensure_generated_key BLACK_CLOUD_INTENT_SIGNING_KEY 48 "$RUNTIME_ENV"
ensure_generated_key RESTIC_PASSWORD 32 "$BACKUP_ENV" hex
ensure_generated_key GF_SECURITY_ADMIN_PASSWORD 24 "$MONITORING_ENV" hex
upsert_env NODE_ENV production "$RUNTIME_ENV"
upsert_env PUBLIC_APP_URL "$PUBLIC_URL" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_WORKER_REGION "$REGION" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT PRODUCTION "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_DEPLOYMENT_COMMIT "$SOURCE_COMMIT" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_IMAGE_REFERENCE "black-terminal-runtime:$SOURCE_COMMIT" "$RUNTIME_ENV"
upsert_env CLOUD_EXECUTION_CONTROL_PLANE_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$RUNTIME_ENV"
upsert_env BYBIT_CLOUD_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_STRATEGY_RUNTIME_ENABLED "$WITH_PAPER_AUTOMATION" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_MAINNET_ENABLED "$ENABLE_LIVE_EXECUTION" "$RUNTIME_ENV"
upsert_env BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED false "$RUNTIME_ENV"
upsert_env STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED "$ENABLE_DEMO_EXECUTION" "$RUNTIME_ENV"
upsert_env BYBIT_DEMO_ENABLED "$ENABLE_DEMO_EXECUTION" "$RUNTIME_ENV"
upsert_env STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED "$ENABLE_LIVE_EXECUTION" "$RUNTIME_ENV"
upsert_env STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED "$ENABLE_LIVE_EXECUTION" "$RUNTIME_ENV"
upsert_env INVESTMENT_GROUP_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$RUNTIME_ENV"
upsert_env STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$RUNTIME_ENV"
upsert_env BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo false || echo true)" "$RUNTIME_ENV"
upsert_env EVENT_ALPHA_PAPER_EXECUTION_ENABLED false "$RUNTIME_ENV"
upsert_env EVENT_ALPHA_LIVE_EXECUTION_ENABLED false "$RUNTIME_ENV"
upsert_env EVENT_ALPHA_STRATEGY_KILL_SWITCH true "$RUNTIME_ENV"
upsert_env EVENT_ALPHA_GLOBAL_EXECUTION_KILL_SWITCH true "$RUNTIME_ENV"
upsert_env IMM_ENABLED "$WITH_ANALYTICS" "$RUNTIME_ENV"
upsert_env IMM_REQUIRED false "$RUNTIME_ENV"
upsert_env QALC_PAPER_ENABLED false "$RUNTIME_ENV"
upsert_env QALC_LIVE_EXECUTION_ENABLED false "$RUNTIME_ENV"
upsert_env QALC_GROUP_FANOUT_ENABLED false "$RUNTIME_ENV"
upsert_env BYBIT_MAINNET_VALIDATION_ENABLED "$([ "$MODE" = production ] && echo true || echo false)" "$RUNTIME_ENV"
if [ "$MODE" = production ] && [ -z "$(env_raw "$RUNTIME_ENV" BYBIT_MAINNET_ALLOWED_SYMBOLS)" ]; then
  upsert_env BYBIT_MAINNET_ALLOWED_SYMBOLS '*' "$RUNTIME_ENV"
fi
if [ -z "$(env_raw "$RUNTIME_ENV" BYBIT_ENDPOINT_PROFILE)" ]; then
  upsert_env BYBIT_ENDPOINT_PROFILE GLOBAL "$RUNTIME_ENV"
fi

if [ -n "$RCLONE_CONFIG" ]; then
  install -m 0600 "$RCLONE_CONFIG" "$SHARED_SECRETS/rclone/rclone.conf"
else
  touch "$SHARED_SECRETS/rclone/rclone.conf"
fi
chmod 0600 "$RUNTIME_ENV" "$BACKUP_ENV" "$MONITORING_ENV" "$SHARED_SECRETS/rclone/rclone.conf"
ln -sfn "$RUNTIME_ENV" "$INFRA_DIR/secrets/runtime.env"
ln -sfn "$BACKUP_ENV" "$INFRA_DIR/secrets/backup.env"
ln -sfn "$MONITORING_ENV" "$INFRA_DIR/secrets/monitoring.env"

install -m 0600 "$INFRA_DIR/.env.example" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_DEPLOYMENT_COMMIT "$SOURCE_COMMIT" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_PUBLIC_URL "$PUBLIC_URL" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_GATEWAY_BIND "$GATEWAY_BIND" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_CADDYFILE "$CADDYFILE" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_DOMAIN "${DOMAIN:-black-cloud-staging.invalid}" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_TLS_EMAIL "${TLS_EMAIL:-operator@example.invalid}" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_CUTOVER_APPROVED "$CUTOVER_APPROVED" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_RUNTIME_ENV_FILE "$RUNTIME_ENV" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_BACKUP_ENV_FILE "$BACKUP_ENV" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_MONITORING_ENV_FILE "$MONITORING_ENV" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_SUPABASE_STATE_ROOT "$STATE_ROOT/supabase" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_LOCAL_RESTIC_PATH "$STATE_ROOT/restic" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_RCLONE_CONFIG_FILE "$SHARED_SECRETS/rclone/rclone.conf" "$INFRA_DIR/.env"
upsert_env QALC_DATA_ROOT "$STATE_ROOT/qalc" "$INFRA_DIR/.env"
upsert_env IMM_ENABLED "$WITH_ANALYTICS" "$INFRA_DIR/.env"
upsert_env QALC_RESEARCH_ENABLED "$WITH_QALC" "$INFRA_DIR/.env"
upsert_env BCLIF_ENVIRONMENT "$BCLIF_ENVIRONMENT" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_REGION "$REGION" "$INFRA_DIR/.env"
upsert_env STRATEGY_AUTOMATION_PAPER_ENABLED "$WITH_PAPER_AUTOMATION" "$INFRA_DIR/.env"
upsert_env STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED "$ENABLE_DEMO_EXECUTION" "$INFRA_DIR/.env"
upsert_env BYBIT_DEMO_ENABLED "$ENABLE_DEMO_EXECUTION" "$INFRA_DIR/.env"
upsert_env STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED "$ENABLE_LIVE_EXECUTION" "$INFRA_DIR/.env"
upsert_env STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED "$ENABLE_LIVE_EXECUTION" "$INFRA_DIR/.env"
upsert_env STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$INFRA_DIR/.env"
upsert_env INVESTMENT_GROUP_EXECUTION_ENABLED "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo true || echo false)" "$INFRA_DIR/.env"
upsert_env BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH "$([ "$ENABLE_DEMO_EXECUTION" = true -o "$ENABLE_LIVE_EXECUTION" = true ] && echo false || echo true)" "$INFRA_DIR/.env"

if [ "$MODE" = production ]; then
  restic_repository=$(env_raw "$BACKUP_ENV" RESTIC_REPOSITORY)
  if [ "$WITH_BACKUP" = true ]; then
    printf '%s' "$restic_repository" | grep -Eq '^(s3:|sftp:|rest:|rclone:)' || die "production backup must use an off-host Restic repository"
    if printf '%s' "$restic_repository" | grep -q '^rclone:'; then
      test -n "$RCLONE_CONFIG" || die "a rclone: Restic repository requires --rclone-config"
    fi
  fi
fi

CURRENT_PHASE=network-boundary
ensure_internal_network(){
  name=$1
  if docker network inspect "$name" >/dev/null 2>&1; then
    internal=$(docker network inspect "$name" --format '{{.Internal}}')
    test "$internal" = true || die "existing network $name is not internal"
  else
    docker network create --internal "$name" >/dev/null
  fi
}
ensure_internal_network black-cloud-backplane
ensure_internal_network black-cloud-data

CURRENT_PHASE=supabase-bootstrap
export SUPABASE_VENDOR_DIR
export SUPABASE_SELF_HOSTED_TAG=self-hosted/v0.7.2
export SUPABASE_SELF_HOSTED_COMMIT=549db119c44c25167461812041ba198bde2b31a4
"$INFRA_DIR/scripts/initialize-supabase.sh"
SUPABASE_DOCKER="$SUPABASE_VENDOR_DIR/docker"
supabase_compose=(docker compose --env-file "$SUPABASE_DOCKER/.env" -f "$SUPABASE_DOCKER/docker-compose.yml" -f "$SUPABASE_DOCKER/black-cloud.override.yml")
"${supabase_compose[@]}" config --quiet
"${supabase_compose[@]}" pull
"${supabase_compose[@]}" up -d --wait

CURRENT_PHASE=sql-migrations
BLACK_CLOUD_MIGRATION_LOCK_ROOT="$STATE_ROOT/locks" "$INFRA_DIR/scripts/apply-repository-migrations.sh" apply
install -d -m 0750 "$INFRA_DIR/artifacts"
cat > "$INFRA_DIR/artifacts/FRESH_INSTALL_VERIFIED" <<FRESH_INSTALL
source_commit=$SOURCE_COMMIT
verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
migration_count=$(find "$RELEASE_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l)
FRESH_INSTALL
chmod 0440 "$INFRA_DIR/artifacts/FRESH_INSTALL_VERIFIED"

CURRENT_PHASE=platform-preflight
"$INFRA_DIR/scripts/preflight.sh" "$MODE"
overlay="$INFRA_DIR/docker-compose.$MODE.yml"
app_compose=(docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$overlay")
"${app_compose[@]}" config --quiet

CURRENT_PHASE=application-build
"${app_compose[@]}" build frontend api event-alpha-worker
export BCLIF_IMAGE_DIGEST
BCLIF_IMAGE_DIGEST=$(docker image inspect "black-terminal-runtime:$SOURCE_COMMIT" --format '{{.Id}}')
[[ "$BCLIF_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || die "runtime image has no immutable sha256 identity"
upsert_env BLACK_CLOUD_IMAGE_DIGEST "$BCLIF_IMAGE_DIGEST" "$RUNTIME_ENV"

CURRENT_PHASE=application-start
"${app_compose[@]}" up -d --wait frontend api gateway

if [ "$WITH_ANALYTICS" = true ]; then
  CURRENT_PHASE=analytics-start
  analytics_compose=("${app_compose[@]}" --profile analytics)
  "${analytics_compose[@]}" up -d bclif-spool-init event-alpha-worker market-depth-worker bclif-collector
fi

if [ "$WITH_QALC" = true ]; then
  CURRENT_PHASE=qalc-start
  if ! chronyc waitsync 30 1 >/dev/null 2>&1 && [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" != yes ]; then
    die "host clock did not synchronize; QALC was not started"
  fi
  qalc_compose=("${app_compose[@]}" --profile qalc-research)
  "${qalc_compose[@]}" up -d qalc-data-init qalc-worker
fi

if [ "$WITH_PAPER_AUTOMATION" = true ]; then
  CURRENT_PHASE=paper-automation-start
  strategy_compose=("${app_compose[@]}" --profile strategy-automation)
  "${strategy_compose[@]}" up -d strategy-automation-worker
fi

if [ "$ENABLE_DEMO_EXECUTION" = true ]; then
  CURRENT_PHASE=demo-execution-start
  strategy_compose=("${app_compose[@]}" --profile strategy-automation)
  "${strategy_compose[@]}" up -d black-cloud-demo-execution-worker
fi

if [ "$ENABLE_LIVE_EXECUTION" = true ]; then
  CURRENT_PHASE=live-execution-start
  live_compose=("${app_compose[@]}" --profile live-execution)
  "${live_compose[@]}" up -d black-cloud-execution-worker
fi

CURRENT_PHASE=database-secret-synchronization
if [ "$WITH_OBSERVABILITY" = true ]; then "$INFRA_DIR/scripts/synchronize-monitoring-database-secret.sh"; fi
if [ "$WITH_BACKUP" = true ]; then "$INFRA_DIR/scripts/synchronize-backup-database-secret.sh"; fi

if [ "$WITH_OBSERVABILITY" = true ]; then
  CURRENT_PHASE=observability-start
  monitoring_compose=(docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.monitoring.yml")
  "${monitoring_compose[@]}" config --quiet
  "${monitoring_compose[@]}" pull
  "${monitoring_compose[@]}" up -d
fi

if [ "$WITH_BACKUP" = true ]; then
  CURRENT_PHASE=backup-start
  backup_compose=(docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.backup.yml")
  "${backup_compose[@]}" config --quiet
  "${backup_compose[@]}" build backup
  "${backup_compose[@]}" up -d backup
fi

CURRENT_PHASE=post-install-verification
wait_container_running(){
  project=$1; service=$2
  for _ in $(seq 1 30); do
    if docker ps \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service" \
      --format '{{.ID}}' | grep -q .; then
      return 0
    fi
    sleep 1
  done
  die "container did not remain running: $project/$service"
}

for service in frontend api gateway; do wait_container_running black-cloud "$service"; done
if [ "$WITH_ANALYTICS" = true ]; then
  for service in event-alpha-worker market-depth-worker bclif-collector; do wait_container_running black-cloud "$service"; done
fi
if [ "$WITH_QALC" = true ]; then wait_container_running black-cloud qalc-worker; fi
if [ "$WITH_PAPER_AUTOMATION" = true ]; then wait_container_running black-cloud strategy-automation-worker; fi
if [ "$ENABLE_DEMO_EXECUTION" = true ]; then wait_container_running black-cloud black-cloud-demo-execution-worker; fi
if [ "$ENABLE_LIVE_EXECUTION" = true ]; then wait_container_running black-cloud black-cloud-execution-worker; fi
if [ "$WITH_OBSERVABILITY" = true ]; then
  for service in prometheus grafana node-exporter cadvisor postgres-exporter; do wait_container_running black-cloud-observability "$service"; done
fi
backup_snapshot_verified=false
if [ "$WITH_BACKUP" = true ]; then
  wait_container_running black-cloud-backup backup
  backup_container=$(docker ps \
    --filter 'label=com.docker.compose.project=black-cloud-backup' \
    --filter 'label=com.docker.compose.service=backup' \
    --format '{{.ID}}' | head -n 1)
  for _ in $(seq 1 120); do
    backup_logs=$(docker logs --since "$STARTED_AT" "$backup_container" 2>&1 || true)
    if printf '%s' "$backup_logs" | grep -q 'black_cloud_backup_complete'; then
      backup_snapshot_verified=true
      break
    fi
    if printf '%s' "$backup_logs" | grep -q 'black_cloud_backup_failed'; then
      die "the first encrypted backup failed; inspect the backup container without exposing its environment"
    fi
    sleep 2
  done
  test "$backup_snapshot_verified" = true || die "the first encrypted backup did not complete within four minutes"
fi
health_url="$PUBLIC_URL/healthz"
curl -fsS --retry 12 --retry-delay 5 --retry-all-errors "$health_url" >/dev/null || die "public gateway readiness failed: $health_url"
curl -fsSI --retry 5 --retry-delay 2 "$PUBLIC_URL/" | tr -d '\r' | grep -Eiq '^x-content-type-options:[[:space:]]*nosniff$' || die "public security headers are missing"
BLACK_CLOUD_MIGRATION_LOCK_ROOT="$STATE_ROOT/locks" "$INFRA_DIR/scripts/apply-repository-migrations.sh" verify
execution_rows=$(docker exec supabase-db psql -X -U postgres -d postgres -Atq -c "select count(*) from public.execution_orders")
test "$execution_rows" = 0 || die "fresh installation unexpectedly contains execution orders"
"$INFRA_DIR/scripts/preflight.sh" "$MODE"

migration_count=$(find "$RELEASE_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l)
latest_migration=$(find "$RELEASE_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort | tail -n 1)
frontend_image=$(docker image inspect "black-terminal-frontend:$SOURCE_COMMIT" --format '{{.Id}}')
api_image=$(docker image inspect "black-terminal-api:$SOURCE_COMMIT" --format '{{.Id}}')
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SUCCESS_REPORT="$REPORT_DIR/${COMPLETED_AT//:/-}-${SOURCE_COMMIT:0:12}-installed.txt"
cat > "$SUCCESS_REPORT" <<REPORT
status=INSTALLED_AND_VERIFIED
started_at=$STARTED_AT
completed_at=$COMPLETED_AT
source_commit=$SOURCE_COMMIT
mode=$MODE
public_url=$PUBLIC_URL
release_dir=$RELEASE_DIR
supabase_pin=$SUPABASE_SELF_HOSTED_COMMIT
migration_count=$migration_count
latest_migration=$latest_migration
frontend_image=$frontend_image
api_image=$api_image
runtime_image=$BCLIF_IMAGE_DIGEST
analytics_imm_bclif=$WITH_ANALYTICS
qalc_research=$WITH_QALC
observability=$WITH_OBSERVABILITY
encrypted_backup=$WITH_BACKUP
initial_backup_verified=$backup_snapshot_verified
paper_automation=$WITH_PAPER_AUTOMATION
demo_execution=$ENABLE_DEMO_EXECUTION
real_funds_execution=$ENABLE_LIVE_EXECUTION
execution_rows_after_install=$execution_rows
dns_modified=false
firewall_modified=false
secrets_printed=false
rollback=Stop this release's Compose projects and repoint /opt/black-cloud/current to a previously verified release; never delete persistent volumes as rollback.
REPORT
chmod 0640 "$SUCCESS_REPORT"
ln -s "$RELEASE_DIR" "$INSTALL_ROOT/current"
rm -f "$RESUME_MARKER"
trap - ERR

CURRENT_PHASE=complete
printf 'Black Cloud installation verified: commit=%s mode=%s migrations=%s.\n' "$SOURCE_COMMIT" "$MODE" "$migration_count"
printf 'Public endpoint: %s\n' "$PUBLIC_URL"
printf 'Non-secret installation evidence: %s\n' "$SUCCESS_REPORT"
printf 'No DNS or firewall rules were changed; no real order was submitted during verification.\n'
