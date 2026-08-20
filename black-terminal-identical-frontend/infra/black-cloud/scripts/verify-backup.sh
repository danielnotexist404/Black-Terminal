#!/usr/bin/env bash
set -euo pipefail

work_dir=$(mktemp -d /tmp/black-cloud-restore.XXXXXX)
trap 'rm -r "$work_dir"' EXIT
restic check --read-data
restic restore latest --target "$work_dir"
manifest_file=$(find "$work_dir" -type f -name manifest.json -print -quit)
snapshot_dir=${manifest_file%/*}
test -n "$snapshot_dir" || { echo "Backup manifest is missing after restore." >&2; exit 1; }
(cd "$snapshot_dir" && sha256sum -c SHA256SUMS)
pg_restore --list "$snapshot_dir/postgres.dump" >/dev/null
xattr_report="$work_dir/storage-xattrs.txt"
tar --xattrs --xattrs-include='*' -tvvvzf "$snapshot_dir/storage.tar.gz" > "$xattr_report"
grep -Eq '^  x: [0-9]+ user\.supabase\.(cache-control|content-type)$' "$xattr_report" || {
  echo "Storage backup is missing required Supabase file-backend extended attributes." >&2
  exit 1
}
grep -Eq '"format":"black-cloud-backup-v2".*"storageExtendedAttributes":true' "$snapshot_dir/manifest.json"
printf 'Encrypted backup restore rehearsal passed: Restic data, PostgreSQL archive, and Storage archive are readable.\n'
