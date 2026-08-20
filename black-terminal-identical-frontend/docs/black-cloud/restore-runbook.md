# Restore Runbook

1. Provision an isolated Docker host with equal/newer capacity.
2. Check out the exact release SHA and verify the pinned Supabase tag/commit.
3. Create fresh mode-600 target secrets; restore the original wrapping/signing keys from the recovery envelope.
4. Start an empty self-hosted Supabase stack.
5. Verify encrypted export checksums.
6. Run `restore-database.sh` against the empty target.
7. Run `verify-restore.sh`; do not start the app without `artifacts/RESTORE_VERIFIED`.
8. Import Storage and require re-download SHA-256 verification.
9. Start frontend/API on loopback and run Auth, REST, Realtime and Storage smoke tests.
10. Start analytics only after state/replay checks. Keep real-funds workers stopped.

Abort on any row-count, object-checksum, Auth-identity, RLS, migration or critical aggregate mismatch. Preserve the failed target for forensics; do not modify the source to make target validation pass.
