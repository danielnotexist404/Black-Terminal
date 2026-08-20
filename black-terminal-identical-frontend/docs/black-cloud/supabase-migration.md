# Supabase Migration

Black Cloud runs the official self-hosted Supabase Docker stack because the application depends deeply on Supabase Auth, PostgREST/RLS, RPC, Realtime and Storage semantics. Replacing those APIs during the hosting move would multiply authentication and authorization risk.

Dry-run procedure:

1. Start the pinned empty self-hosted stack with `infra/black-cloud/scripts/deploy-staging.sh`.
2. Run `export-hosted-supabase.sh` from the trusted controller. Temporary Supabase CLI credentials traverse an SSH reverse tunnel; roles, schema, data and verification results are encrypted before being written.
3. Transfer only encrypted artifacts and the passphrase over SSH.
4. Run `restore-database.sh`. It refuses a non-empty target and restores inside one transaction with triggers disabled for circular application foreign keys.
5. Apply the pending Event Alpha migration.
6. Run `verify-restore.sh` and compare Auth, storage metadata and critical control-plane counts.
7. Import Storage payloads separately and verify every checksum.

The source is never modified. Auth user IDs and password hashes are preserved. A changed self-hosted signing key invalidates old access JWTs; users must be prepared to authenticate again. OAuth providers, SMTP and redirect URLs must be configured before cutover.

Do not treat schema-source tests as a database restore test. Production cutover remains blocked until the encrypted backup is readable, the isolated restore succeeds, storage checksums match, Auth is exercised and an off-host backup restore has passed.
