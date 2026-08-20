#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TARGET_DIR=${SUPABASE_VENDOR_DIR:-"$INFRA_DIR/vendor/supabase"}
TAG=${SUPABASE_SELF_HOSTED_TAG:-self-hosted/v0.7.2}
EXPECTED_COMMIT=${SUPABASE_SELF_HOSTED_COMMIT:-549db119c44c25167461812041ba198bde2b31a4}
REPOSITORY=https://github.com/supabase/supabase.git

if ! printf '%s' "$EXPECTED_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "SUPABASE_SELF_HOSTED_COMMIT must be an exact 40-character Git commit." >&2
  exit 1
fi

mkdir -p "$(dirname -- "$TARGET_DIR")"
if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" fetch --depth 1 origin "$EXPECTED_COMMIT"
else
  test ! -e "$TARGET_DIR" || { echo "Refusing to overwrite non-Git path: $TARGET_DIR" >&2; exit 1; }
  git init -q "$TARGET_DIR"
  git -C "$TARGET_DIR" remote add origin "$REPOSITORY"
  git -C "$TARGET_DIR" fetch --depth 1 origin "$EXPECTED_COMMIT"
fi

git -C "$TARGET_DIR" checkout -q --detach "$EXPECTED_COMMIT"
ACTUAL_COMMIT=$(git -C "$TARGET_DIR" rev-parse HEAD)
REMOTE_TAG_COMMIT=$(git ls-remote --tags "$REPOSITORY" "refs/tags/$TAG^{}" | awk 'NR == 1 { print $1 }')
test "$ACTUAL_COMMIT" = "$EXPECTED_COMMIT" || { echo "Supabase checkout mismatch." >&2; exit 1; }
test "$REMOTE_TAG_COMMIT" = "$EXPECTED_COMMIT" || { echo "Supabase tag no longer resolves to the approved commit." >&2; exit 1; }
test -f "$TARGET_DIR/docker/docker-compose.yml" || { echo "Pinned Supabase Docker bundle is incomplete." >&2; exit 1; }

printf 'Supabase self-hosted bundle ready: tag=%s commit=%s\n' "$TAG" "$ACTUAL_COMMIT"
