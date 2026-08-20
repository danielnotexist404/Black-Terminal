# Backups

`docker-compose.backup.yml` runs a dedicated backup image. `backup-once.sh` captures PostgreSQL roles plus a custom-format database dump, Supabase Storage data and deployment manifests into an encrypted Restic repository. Storage archives are format v2 and preserve the extended attributes required by Supabase's local file backend. `backup-loop.sh` schedules the operation and applies retention.

Required production configuration:

- `RESTIC_REPOSITORY`: an off-host S3/SFTP/Rest server, not the VPS filesystem.
- `RESTIC_PASSWORD_FILE`: mode-600 encryption password.
- provider credentials scoped only to the backup bucket/path.

`verify-backup.sh` performs full Restic integrity checks and archive readability validation. `verify-backup-database-restore.sh` then starts a network-disabled disposable copy of the pinned Supabase PostgreSQL image, restores the latest custom archive with `--exit-on-error`, verifies critical table counts, and deletes the disposable container and volume. A local repository is acceptable for staging mechanics only. Disaster recovery is incomplete until the same encrypted repository is off-host and a timed replacement-host restore also passes.

Backups must include the exact release SHA, Supabase pin, Compose manifests and non-secret configuration inventory. Secret values remain in the secret manager/offline recovery envelope, never in Git.
