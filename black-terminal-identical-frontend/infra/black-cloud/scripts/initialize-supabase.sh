#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SUPABASE_ROOT=${SUPABASE_VENDOR_DIR:-"$INFRA_DIR/vendor/supabase"}
DOCKER_DIR="$SUPABASE_ROOT/docker"

"$SCRIPT_DIR/prepare-supabase.sh"
test -f "$INFRA_DIR/.env" || { echo "Copy .env.example to .env first." >&2; exit 1; }

if [ ! -f "$DOCKER_DIR/.env" ]; then
  umask 077
  cp "$DOCKER_DIR/.env.example" "$DOCKER_DIR/.env"
  (cd "$DOCKER_DIR" && sh utils/generate-keys.sh --update-env >/dev/null)
  (cd "$DOCKER_DIR" && sh utils/add-new-auth-keys.sh --update-env >/dev/null)
fi

set_env(){
  key=$1
  value=$2
  file=$3
  escaped=$(printf '%s' "$value" | sed 's/[&|]/\\&/g')
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

. "$INFRA_DIR/.env"
PUBLIC_URL=${BLACK_CLOUD_PUBLIC_URL:?BLACK_CLOUD_PUBLIC_URL is required}
STATE_ROOT=${BLACK_CLOUD_SUPABASE_STATE_ROOT:-/var/lib/black-cloud/supabase}
set_env SUPABASE_PUBLIC_URL "$PUBLIC_URL" "$DOCKER_DIR/.env"
set_env API_EXTERNAL_URL "$PUBLIC_URL/auth/v1" "$DOCKER_DIR/.env"
set_env SITE_URL "$PUBLIC_URL" "$DOCKER_DIR/.env"
set_env ADDITIONAL_REDIRECT_URLS "$PUBLIC_URL/**" "$DOCKER_DIR/.env"
set_env KONG_HTTP_PORT "127.0.0.1:18000" "$DOCKER_DIR/.env"
set_env KONG_HTTPS_PORT "127.0.0.1:18443" "$DOCKER_DIR/.env"
set_env ENABLE_PHONE_SIGNUP "false" "$DOCKER_DIR/.env"
set_env ENABLE_PHONE_AUTOCONFIRM "false" "$DOCKER_DIR/.env"
set_env ENABLE_EMAIL_AUTOCONFIRM "false" "$DOCKER_DIR/.env"
set_env PGRST_DB_SCHEMAS "public,storage,graphql_public" "$DOCKER_DIR/.env"
set_env BLACK_CLOUD_SUPABASE_STATE_ROOT "$STATE_ROOT" "$DOCKER_DIR/.env"

google_client_id=$(sed -n 's/^GOOGLE_OAUTH_CLIENT_ID=//p' "$INFRA_DIR/secrets/runtime.env" | head -n 1)
google_client_secret=$(sed -n 's/^GOOGLE_OAUTH_CLIENT_SECRET=//p' "$INFRA_DIR/secrets/runtime.env" | head -n 1)
if [ -n "$google_client_id" ] || [ -n "$google_client_secret" ]; then
  test -n "$google_client_id" && test -n "$google_client_secret" || { echo "Google OAuth requires both client ID and client secret." >&2; exit 1; }
  set_env GOOGLE_ENABLED "true" "$DOCKER_DIR/.env"
  set_env GOOGLE_CLIENT_ID "$google_client_id" "$DOCKER_DIR/.env"
  set_env GOOGLE_SECRET "$google_client_secret" "$DOCKER_DIR/.env"
else
  set_env GOOGLE_ENABLED "false" "$DOCKER_DIR/.env"
  set_env GOOGLE_CLIENT_ID "" "$DOCKER_DIR/.env"
  set_env GOOGLE_SECRET "" "$DOCKER_DIR/.env"
fi

cp "$INFRA_DIR/supabase.override.yml" "$DOCKER_DIR/black-cloud.override.yml"
chmod 600 "$DOCKER_DIR/.env"

anon_key=$(sed -n 's/^ANON_KEY=//p' "$DOCKER_DIR/.env")
service_key=$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$DOCKER_DIR/.env")
secret_key=$(sed -n 's/^SUPABASE_SECRET_KEY=//p' "$DOCKER_DIR/.env")
test -n "$anon_key" || { echo "Generated ANON_KEY is empty." >&2; exit 1; }
test -n "$service_key" || { echo "Generated SERVICE_ROLE_KEY is empty." >&2; exit 1; }

set_env ANON_KEY "$anon_key" "$INFRA_DIR/.env"
set_env SUPABASE_SERVICE_ROLE_KEY "$service_key" "$INFRA_DIR/secrets/runtime.env"
if [ -n "$secret_key" ]; then set_env SUPABASE_SECRET_KEY "$secret_key" "$INFRA_DIR/secrets/runtime.env"; fi
chmod 600 "$INFRA_DIR/.env" "$INFRA_DIR/secrets/runtime.env"

printf 'Self-hosted Supabase configuration initialized at %s (secrets not printed).\n' "$DOCKER_DIR"
