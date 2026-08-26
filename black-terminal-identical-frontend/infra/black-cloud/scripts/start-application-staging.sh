#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
"$SCRIPT_DIR/require-database-ready.sh"

"$SCRIPT_DIR/preflight.sh" staging
docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$INFRA_DIR/docker-compose.staging.yml" build frontend api
docker compose --env-file "$INFRA_DIR/.env" -f "$INFRA_DIR/docker-compose.yml" -f "$INFRA_DIR/docker-compose.staging.yml" up -d --wait frontend api gateway

printf 'Black Cloud application staging is available only through the configured loopback binding.\n'
printf 'Analytics and live-execution profiles remain stopped.\n'
