# Cutover Runbook

Cutover requires explicit approval after staging evidence is reviewed.

1. Confirm off-host backup and isolated restore evidence.
2. Lower DNS TTL in advance.
3. Announce maintenance and make the legacy application read-only.
4. Stop legacy background workers; record fencing/lease state.
5. Capture final database and Storage exports.
6. Restore the final snapshot into a clean Black Cloud target and verify all invariants.
7. Configure SMTP/OAuth, TLS domain, rate limits and production secrets.
   Google Auth requires both original/approved OAuth credentials and the production callback `<public-url>/auth/v1/callback`; run `initialize-supabase.sh` only after the values are placed in the mode-600 runtime environment.
8. Start frontend/API, then non-execution analytics; run internal authenticated smoke tests.
9. Confirm no old and new worker can process the same job.
10. Change DNS/routing to Black Cloud.
11. Monitor Auth, API error rate, Realtime, Storage, database, queues and resource headroom.
12. Re-enable writes only after verification.
13. Keep Vercel and hosted Supabase intact for the approved rollback window.

Do not start real-funds automation merely because hosting cutover succeeded.
`preflight.sh production` also refuses cutover until the explicit approval gate, HTTPS identity, continuity keys, provider configuration and an off-host Restic target are present.
