#!/usr/bin/env bash
set -euo pipefail

interval=${BLACK_CLOUD_BACKUP_INTERVAL_SECONDS:-21600}
case "$interval" in ''|*[!0-9]*) echo "BLACK_CLOUD_BACKUP_INTERVAL_SECONDS must be numeric." >&2; exit 1;; esac
test "$interval" -ge 900 || { echo "Backup interval must be at least 900 seconds." >&2; exit 1; }

stopping=false
trap 'stopping=true' TERM INT
while [ "$stopping" = false ]; do
  /usr/local/bin/backup-once || printf '{"level":"error","event":"black_cloud_backup_failed","timestamp":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  remaining=$interval
  while [ "$stopping" = false ] && [ "$remaining" -gt 0 ]; do
    step=30
    if [ "$remaining" -lt "$step" ]; then step=$remaining; fi
    sleep "$step" & wait $! || true
    remaining=$((remaining-step))
  done
done
