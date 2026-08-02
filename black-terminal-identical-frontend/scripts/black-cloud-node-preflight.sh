#!/usr/bin/env bash
set -euo pipefail

deployment_dir="${1:-/opt/black-terminal/black-cloud}"
environment_file="${2:-/etc/black-terminal/black-cloud-node01.env}"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

for command_name in git docker curl stat df free timedatectl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command missing: $command_name"
done

[[ "$(uname -s)" == "Linux" ]] || fail "host must be Linux"
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

[[ -d "$deployment_dir/.git" ]] || fail "deployment directory is not a Git checkout: $deployment_dir"
[[ -f "$environment_file" ]] || fail "root-owned environment file is missing: $environment_file"
[[ "$(stat -c '%a' "$environment_file")" == "600" ]] || fail "environment file mode must be 600"
[[ "$(stat -c '%U' "$environment_file")" == "root" ]] || fail "environment file owner must be root"

required_variables=(
  SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY BLACK_CLOUD_SECRET_MASTER_KEY_V1
  BLACK_CLOUD_MASTER_KEY_VERSION BLACK_CLOUD_INTENT_SIGNING_KEY
  BLACK_CLOUD_EXECUTION_ENABLED INVESTMENT_GROUP_EXECUTION_ENABLED
  BYBIT_CLOUD_EXECUTION_ENABLED BLACK_CLOUD_NODE_ID BLACK_CLOUD_WORKER_REGION
  BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT BLACK_CLOUD_DEPLOYMENT_COMMIT
  BLACK_CLOUD_IMAGE_REFERENCE BLACK_CLOUD_IMAGE_DIGEST
  BLACK_CLOUD_EXECUTION_ENVIRONMENT
)
for variable_name in "${required_variables[@]}"; do
  grep -q "^${variable_name}=" "$environment_file" || fail "environment manifest is missing $variable_name"
done

docker info >/dev/null
docker compose version
[[ "$(timedatectl show -p NTPSynchronized --value)" == "yes" ]] || fail "system clock is not NTP synchronized"

git -C "$deployment_dir" diff --quiet || fail "deployment checkout has unstaged changes"
git -C "$deployment_dir" diff --cached --quiet || fail "deployment checkout has staged changes"
[[ "$(git -C "$deployment_dir" branch --show-current)" == "main" ]] || fail "deployment checkout must be on main"

printf 'PASS operating-system=%s architecture=%s\n' "$(uname -sr)" "$(uname -m)"
printf 'PASS docker=%s\n' "$(docker version --format '{{.Server.Version}}')"
printf 'PASS compose=%s\n' "$(docker compose version --short)"
printf 'PASS ntp-synchronized=yes timezone=%s\n' "$(timedatectl show -p Timezone --value)"
printf 'PASS deployment-directory=%s commit=%s\n' "$deployment_dir" "$(git -C "$deployment_dir" rev-parse HEAD)"
printf 'PASS environment-file=%s owner=root mode=600 values=redacted\n' "$environment_file"
df -h "$deployment_dir"
free -h

if command -v ufw >/dev/null 2>&1; then
  ufw status
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --state
else
  printf 'WARNING no supported firewall status command was detected\n'
fi
