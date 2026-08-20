#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SUPABASE_ROOT=${SUPABASE_VENDOR_DIR:-"$INFRA_DIR/vendor/supabase"}
DOCKER_DIR="$SUPABASE_ROOT/docker"

"$SCRIPT_DIR/preflight.sh" staging
"$SCRIPT_DIR/initialize-supabase.sh"

docker network inspect black-cloud-backplane >/dev/null 2>&1 || docker network create --internal black-cloud-backplane >/dev/null
docker network inspect black-cloud-data >/dev/null 2>&1 || docker network create --internal black-cloud-data >/dev/null

docker compose --env-file "$DOCKER_DIR/.env" -f "$DOCKER_DIR/docker-compose.yml" -f "$DOCKER_DIR/black-cloud.override.yml" config --quiet
docker compose --env-file "$DOCKER_DIR/.env" -f "$DOCKER_DIR/docker-compose.yml" -f "$DOCKER_DIR/black-cloud.override.yml" pull
docker compose --env-file "$DOCKER_DIR/.env" -f "$DOCKER_DIR/docker-compose.yml" -f "$DOCKER_DIR/black-cloud.override.yml" up -d --wait

printf 'Supabase staging is healthy. Database import must complete before the application is started.\n'
printf 'No live-execution profile was started and no public port was opened.\n'
