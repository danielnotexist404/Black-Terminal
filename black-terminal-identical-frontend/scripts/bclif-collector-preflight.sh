#!/usr/bin/env bash
set -euo pipefail

deployment_dir="${1:-/opt/black-terminal/liquidation-intelligence}"
environment_file="${2:-/etc/black-terminal/liquidation-intelligence.env}"
preflight_mode="${3:-host}"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$environment_file"
}

[[ "$preflight_mode" == "host" || "$preflight_mode" == "build-only" ]] \
  || fail "preflight mode must be host or build-only"

for command_name in git docker hostname stat df awk grep tr uname; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command missing: $command_name"
done

[[ "$(uname -s)" == "Linux" ]] || fail "the collector deployment target must be Linux"
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) fail "unsupported CPU architecture: $(uname -m); only AMD64 and ARM64 are supported" ;;
esac

host_name="$(hostname 2>/dev/null || true)"
machine_model=""
if [[ -r /proc/device-tree/model ]]; then
  machine_model="$(tr -d '\000' </proc/device-tree/model 2>/dev/null || true)"
elif [[ -r /sys/class/dmi/id/product_name ]]; then
  machine_model="$(tr -d '\000' </sys/class/dmi/id/product_name 2>/dev/null || true)"
fi
host_identity="$(printf '%s %s %s' "$host_name" "$machine_model" "$deployment_dir" | tr '[:upper:]' '[:lower:]')"
case "$host_identity" in
  *raspberry*pi*|*black-cloud-node-01*|*black_cloud_node_01*|*/black-cloud*|*/black_cloud*)
    fail "refusing BCLIF deployment on a Raspberry Pi or BLACK_CLOUD_NODE_01 execution target"
    ;;
esac

[[ "$(git -C "$deployment_dir" rev-parse --is-inside-work-tree 2>/dev/null || true)" == "true" ]] \
  || fail "deployment directory is not a Git checkout: $deployment_dir"
[[ -f "$deployment_dir/Dockerfile.liquidation-intelligence" ]] || fail "collector Dockerfile is missing"
[[ -f "$deployment_dir/docker-compose.liquidation-intelligence.yml" ]] || fail "collector compose file is missing"
git -C "$deployment_dir" diff --quiet || fail "deployment checkout has unstaged changes"
git -C "$deployment_dir" diff --cached --quiet || fail "deployment checkout has staged changes"
[[ -z "$(git -C "$deployment_dir" status --porcelain --untracked-files=normal)" ]] \
  || fail "deployment checkout contains tracked or untracked changes"
branch_name="$(git -C "$deployment_dir" branch --show-current)"
[[ "$branch_name" == "main" || -z "$branch_name" ]] || fail "deployment checkout must be main or a detached immutable commit"

docker info >/dev/null
docker compose version >/dev/null
docker buildx version >/dev/null

if [[ "$preflight_mode" == "host" ]]; then
  for command_name in curl timedatectl free; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required host command missing: $command_name"
  done
  [[ -f "$environment_file" && ! -L "$environment_file" ]] || fail "root-owned regular environment file is missing: $environment_file"
  [[ "$(stat -c '%a' "$environment_file")" == "600" ]] || fail "environment file mode must be 600"
  [[ "$(stat -c '%U' "$environment_file")" == "root" ]] || fail "environment file owner must be root"

  required_variables=(
    SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY BCLIF_HOST_ROLE BCLIF_NODE_ID
    BCLIF_ENVIRONMENT BCLIF_REGION BCLIF_SYMBOLS BCLIF_DEPLOYMENT_COMMIT
    BCLIF_IMAGE_REFERENCE BCLIF_IMAGE_DIGEST BCLIF_MODEL_VERSION
    BCLIF_SOURCE_VERSION BCLIF_OBJECT_BUCKET BCLIF_HEALTH_PORT
    BCLIF_SPOOL_DIRECTORY BCLIF_SPOOL_MAX_BYTES
  )
  for variable_name in "${required_variables[@]}"; do
    grep -q "^${variable_name}=" "$environment_file" || fail "environment manifest is missing $variable_name"
    [[ -n "$(read_env_value "$variable_name")" ]] || fail "environment variable $variable_name is empty"
  done

  if grep -Eq '^[[:space:]]*(BLACK_CLOUD_|BYBIT_(API_KEY|API_SECRET|PRIVATE_KEY)|BROKER_|EXCHANGE_CREDENTIAL_|CLOUD_EXECUTION_|INVESTMENT_GROUP_EXECUTION_)' "$environment_file"; then
    fail "collector environment contains a broker credential or Black Cloud execution variable"
  fi
  [[ "$(read_env_value BCLIF_HOST_ROLE)" == "LIQUIDATION_INTELLIGENCE" ]] \
    || fail "BCLIF_HOST_ROLE must be LIQUIDATION_INTELLIGENCE"
  case "$(read_env_value BCLIF_NODE_ID)" in
    LIQUIDATION_INTELLIGENCE_NODE_01|IMM_NODE_01) ;;
    *) fail "BCLIF_NODE_ID must identify a dedicated analytics node" ;;
  esac
  [[ "$(read_env_value BCLIF_ENVIRONMENT)" == "PRODUCTION" ]] || fail "production host requires BCLIF_ENVIRONMENT=PRODUCTION"
  [[ "$(read_env_value BCLIF_HEALTH_PORT)" == "8091" ]] || fail "container BCLIF_HEALTH_PORT must be 8091"
  [[ "$(read_env_value BCLIF_MODEL_VERSION)" == "BCLIF_MODEL_V6_ABSOLUTE_SHELVES" ]] || fail "unsupported model version"
  [[ "$(read_env_value BCLIF_SOURCE_VERSION)" == "BYBIT_V6_PUBLIC_2026_08" ]] || fail "unsupported source version"
  [[ "$(read_env_value BCLIF_OBJECT_BUCKET)" == "bclif-field-chunks" ]] || fail "unexpected private object bucket"
  [[ "$(read_env_value BCLIF_DEPLOYMENT_COMMIT)" =~ ^[a-fA-F0-9]{40}$ ]] || fail "BCLIF_DEPLOYMENT_COMMIT must be a full 40-character Git commit"
  [[ "$(read_env_value BCLIF_IMAGE_DIGEST)" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || fail "BCLIF_IMAGE_DIGEST must be an immutable sha256 digest"
  [[ "$(read_env_value BCLIF_DEPLOYMENT_COMMIT)" != "0000000000000000000000000000000000000000" ]] || fail "deployment commit placeholder has not been replaced"
  [[ "$(read_env_value BCLIF_IMAGE_DIGEST)" != "sha256:0000000000000000000000000000000000000000000000000000000000000000" ]] || fail "image digest placeholder has not been replaced"
  [[ "$(read_env_value SUPABASE_URL)" != *project-id* && "$(read_env_value SUPABASE_URL)" != *project.supabase.co* ]] || fail "Supabase URL placeholder has not been replaced"
  [[ "$(read_env_value SUPABASE_SERVICE_ROLE_KEY)" != *service-role-value* ]] || fail "Supabase service-role placeholder has not been replaced"

  ntp_state="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  [[ "$ntp_state" == "yes" ]] || fail "system clock is not NTP synchronized"

  available_kib="$(df -Pk "$deployment_dir" | awk 'NR == 2 { print $4 }')"
  minimum_kib="${BCLIF_MIN_FREE_KIB:-10485760}"
  [[ "$available_kib" =~ ^[0-9]+$ && "$minimum_kib" =~ ^[0-9]+$ ]] || fail "unable to determine free disk capacity"
  (( available_kib >= minimum_kib )) || fail "less than $minimum_kib KiB free disk is available"
  memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
  minimum_memory_kib="${BCLIF_MIN_MEMORY_KIB:-2097152}"
  [[ "$memory_kib" =~ ^[0-9]+$ && "$minimum_memory_kib" =~ ^[0-9]+$ ]] || fail "unable to determine host memory"
  (( memory_kib >= minimum_memory_kib )) || fail "less than $minimum_memory_kib KiB total memory is available"
fi

printf 'PASS target-role=LIQUIDATION_INTELLIGENCE black-cloud-execution=REFUSED\n'
printf 'PASS operating-system=%s architecture=%s host=%s model=%s\n' "$(uname -sr)" "$(uname -m)" "$host_name" "${machine_model:-unknown}"
printf 'PASS docker=%s compose=%s buildx=available\n' \
  "$(docker version --format '{{.Server.Version}}')" "$(docker compose version --short)"
printf 'PASS deployment-directory=%s commit=%s branch=%s clean=yes\n' \
  "$deployment_dir" "$(git -C "$deployment_dir" rev-parse HEAD)" "${branch_name:-detached}"
if [[ "$preflight_mode" == "host" ]]; then
  printf 'PASS ntp-synchronized=yes environment-file=%s owner=root mode=600 values=redacted\n' "$environment_file"
  printf 'PASS disk-free-kib=%s memory-total-kib=%s\n' "$available_kib" "$memory_kib"
fi
printf 'PASS migration-action=NOT_RUN\n'
