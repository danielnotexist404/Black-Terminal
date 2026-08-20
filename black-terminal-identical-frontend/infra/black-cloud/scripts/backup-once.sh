#!/usr/bin/env bash
set -euo pipefail

lock_dir=/staging/.black-cloud-backup.lock
if ! mkdir "$lock_dir" 2>/dev/null; then
  printf '{"level":"warning","event":"black_cloud_backup_already_running"}\n' >&2
  exit 75
fi
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
snapshot_dir="/staging/$timestamp"
mkdir -p "$snapshot_dir"
cleanup(){ rm -rf "$snapshot_dir"; rmdir "$lock_dir" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

pg_dumpall --roles-only --no-role-passwords --no-comments > "$snapshot_dir/roles.sql.partial"
mv "$snapshot_dir/roles.sql.partial" "$snapshot_dir/roles.sql"
pg_dump --format=custom --compress=9 --file "$snapshot_dir/postgres.dump.partial"
mv "$snapshot_dir/postgres.dump.partial" "$snapshot_dir/postgres.dump"
tar --xattrs --xattrs-include='*' -C /source -czf "$snapshot_dir/storage.tar.gz.partial" storage
mv "$snapshot_dir/storage.tar.gz.partial" "$snapshot_dir/storage.tar.gz"

(cd "$snapshot_dir" && sha256sum roles.sql postgres.dump storage.tar.gz > SHA256SUMS)
printf '{"format":"black-cloud-backup-v2","createdAt":"%s","database":"postgres","storage":"supabase-local","storageExtendedAttributes":true}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$snapshot_dir/manifest.json"

if ! restic snapshots >/dev/null 2>&1; then restic init; fi
restic backup --tag black-cloud --tag "$timestamp" "$snapshot_dir"
restic check --read-data-subset=5%
restic forget --prune \
  --keep-daily "${BLACK_CLOUD_BACKUP_RETENTION_DAILY:-14}" \
  --keep-weekly "${BLACK_CLOUD_BACKUP_RETENTION_WEEKLY:-8}" \
  --keep-monthly "${BLACK_CLOUD_BACKUP_RETENTION_MONTHLY:-12}"

printf '{"level":"info","event":"black_cloud_backup_complete","timestamp":"%s"}\n' "$timestamp"
