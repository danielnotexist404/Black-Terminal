#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

SSH_TARGET=${BLACK_CLOUD_SSH_TARGET:-}
SSH_IDENTITY=${BLACK_CLOUD_SSH_IDENTITY:-}
RELEASE_NAME=${1:-}
RELEASE_ROOT=${BLACK_CLOUD_RELEASE_ROOT:-/opt/black-cloud/releases}
ALLOW_DIRTY=${BLACK_CLOUD_ALLOW_DIRTY:-false}

fail() {
  printf 'Black Cloud release sync refused: %s\n' "$1" >&2
  exit 1
}

[[ -n "$SSH_TARGET" ]] || fail "BLACK_CLOUD_SSH_TARGET is required"
[[ -n "$SSH_IDENTITY" ]] || fail "BLACK_CLOUD_SSH_IDENTITY is required"
[[ -f "$SSH_IDENTITY" ]] || fail "SSH identity file does not exist"
[[ "$RELEASE_NAME" =~ ^[0-9a-f]{8,40}(-[a-z0-9][a-z0-9.-]{0,31})?$ ]] || fail "release name must begin with an 8-40 character lowercase Git SHA"
[[ "$RELEASE_ROOT" == /opt/black-cloud/releases ]] || fail "release root must remain /opt/black-cloud/releases"

SOURCE_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
[[ "$RELEASE_NAME" == "$SOURCE_SHA" || "$RELEASE_NAME" == "$SOURCE_SHA"-* || "$SOURCE_SHA" == "$RELEASE_NAME"* ]] || fail "release name does not match the current Git commit"

if [[ "$ALLOW_DIRTY" != true ]] && [[ -n "$(git -C "$APP_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  fail "working tree is dirty; commit first or set BLACK_CLOUD_ALLOW_DIRTY=true for an explicitly non-production staging rehearsal"
fi

SSH=(ssh -i "$SSH_IDENTITY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$SSH_TARGET")
RSYNC_SSH="ssh -i $SSH_IDENTITY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
FINAL_PATH="$RELEASE_ROOT/$RELEASE_NAME"

"${SSH[@]}" test ! -e "$FINAL_PATH" || fail "immutable release already exists on the VPS"

INCOMING_PATH=$("${SSH[@]}" mktemp -d "$RELEASE_ROOT/.incoming-$RELEASE_NAME.XXXXXX")
[[ "$INCOMING_PATH" == "$RELEASE_ROOT/.incoming-$RELEASE_NAME."* ]] || fail "VPS returned an unsafe temporary release path"

cleanup() {
  if [[ -n "${INCOMING_PATH:-}" ]]; then
    "${SSH[@]}" rm -rf -- "$INCOMING_PATH"
  fi
}
trap cleanup EXIT

rsync -a --checksum --human-readable \
  --exclude '/.git/' \
  --exclude '/.vercel/' \
  --exclude '/node_modules/' \
  --exclude '/dist/' \
  --exclude '/infra/black-cloud/vendor/' \
  --exclude '/infra/black-cloud/secrets/' \
  --exclude '/infra/black-cloud/artifacts/' \
  --exclude '/.env' \
  --exclude '/.env.local' \
  --exclude '/.env.production' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  -e "$RSYNC_SSH" \
  "$APP_ROOT/" "$SSH_TARGET:$INCOMING_PATH/"

"${SSH[@]}" test -f "$INCOMING_PATH/package.json"
"${SSH[@]}" test -f "$INCOMING_PATH/infra/black-cloud/docker-compose.yml"
"${SSH[@]}" test ! -e "$INCOMING_PATH/infra/black-cloud/secrets/runtime.env"
"${SSH[@]}" test ! -e "$INCOMING_PATH/infra/black-cloud/artifacts/source-db-export/data.sql.gz.enc"

"${SSH[@]}" sh -eu -c 'printf "%s\n" "$1" > "$2/.black-cloud-source-sha"' sh "$SOURCE_SHA" "$INCOMING_PATH"
"${SSH[@]}" mv -- "$INCOMING_PATH" "$FINAL_PATH"
INCOMING_PATH=

printf 'Immutable Black Cloud release synchronized to %s:%s\n' "$SSH_TARGET" "$FINAL_PATH"
printf 'No Docker service was restarted and no production port or DNS record was changed.\n'
