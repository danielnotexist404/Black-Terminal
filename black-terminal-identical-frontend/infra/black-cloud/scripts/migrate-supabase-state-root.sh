#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SUPABASE_DOCKER_DIR=${SUPABASE_DOCKER_DIR:-$INFRA_DIR/vendor/supabase/docker}
STATE_ROOT=${BLACK_CLOUD_SUPABASE_STATE_ROOT:-/var/lib/black-cloud/supabase}
COPY_IMAGE=${BLACK_CLOUD_STATE_COPY_IMAGE:-node:22.23.1-bookworm-slim}

fail(){ printf 'Supabase state migration refused: %s\n' "$1" >&2; exit 1; }

[[ "$STATE_ROOT" == /var/lib/black-cloud/supabase ]] || fail "state root must remain /var/lib/black-cloud/supabase"
test -d "$SUPABASE_DOCKER_DIR/volumes/db/data" || fail "source PostgreSQL data directory is missing"
test -d "$SUPABASE_DOCKER_DIR/volumes/storage" || fail "source Storage directory is missing"

if docker inspect supabase-db >/dev/null 2>&1; then
  running=$(docker inspect supabase-db --format '{{.State.Running}}')
  test "$running" = false || fail "supabase-db must be stopped before copying persistent state"
fi

docker run --rm --network none --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges:true --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add CHOWN \
  --volume "$STATE_ROOT:/state" "$COPY_IMAGE" sh -eu -c '
    mkdir -p /state/postgres /state/storage
    test -z "$(find /state/postgres -mindepth 1 -print -quit)"
    test -z "$(find /state/storage -mindepth 1 -print -quit)"
  '

copy_tree() {
  source_path=$1
  target_path=$2
  docker run --rm --network none --read-only --tmpfs /tmp:size=16m,mode=1777 \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add CHOWN \
    --volume "$source_path:/source:ro" --volume "$target_path:/target" \
    "$COPY_IMAGE" sh -eu -c 'cp -a --preserve=all /source/. /target/'
}

copy_tree "$SUPABASE_DOCKER_DIR/volumes/db/data" "$STATE_ROOT/postgres"
copy_tree "$SUPABASE_DOCKER_DIR/volumes/storage" "$STATE_ROOT/storage"

docker run --rm --network none --read-only \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --volume "$STATE_ROOT:/state:ro" "$COPY_IMAGE" sh -eu -c '
    test -f /state/postgres/PG_VERSION
    test -d /state/storage
  '

printf 'Supabase PostgreSQL and Storage state copied to the shared Docker state root.\n'
printf 'Source data was preserved. Start Compose with the Black Cloud override and verify before any cleanup.\n'
