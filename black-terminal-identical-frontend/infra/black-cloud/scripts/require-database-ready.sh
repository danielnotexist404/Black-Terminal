#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$INFRA_DIR/artifacts/RESTORE_VERIFIED" ]; then
  printf 'Database readiness evidence: verified restore.\n'
  exit 0
fi

if [ -f "$INFRA_DIR/artifacts/FRESH_INSTALL_VERIFIED" ]; then
  printf 'Database readiness evidence: verified fresh installation.\n'
  exit 0
fi

echo "Neither restore nor fresh-install verification evidence is present; refusing to start the service." >&2
exit 1
