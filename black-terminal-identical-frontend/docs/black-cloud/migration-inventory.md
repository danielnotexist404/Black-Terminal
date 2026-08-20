# Migration Inventory

Canonical source: `origin/main` at `21dfd6814b6e92a949ed9a7a0a422faa5d53605d`. Migration branch: `infra/black-cloud-central-vps`.

The source deployment generated 13 Vercel Functions. The hosted Supabase audit measured 133 public tables, 46 public functions, 62 triggers and 140 RLS policies. It also uses Auth, Realtime, Storage, RPCs and direct browser `supabase-js` access.

The hosted migration ledger was current through `20260818221233_add_execution_order_average_fill_price.sql` at export time. The isolated target now records 28 migrations through `20260820153100_bclif_storage_path_regex_correction.sql`, including Event Alpha and the two target-side BCLIF corrections applied after restoration.

The restored target passed disposable Auth create/login/delete, authenticated RLS REST, Storage bucket discovery and Realtime subscription. Exact staging evidence and unresolved cutover blockers are recorded in `staging-certification.md`.

Migration assets:

- Central API: `server/black-cloud/api-server.js` and `api-router.js`.
- Containers: `infra/black-cloud/Dockerfile.platform` and Compose models.
- Supabase pin: official `self-hosted/v0.7.2`, peeled commit `549db119c44c25167461812041ba198bde2b31a4`.
- Database export/restore: encrypted roles, schema, data and verification manifests.
- Storage: object-by-object SHA-256 export/import verification.
- Monitoring: Prometheus, Grafana, node exporter, cAdvisor and Postgres exporter, all private/loopback.
- Backup: encrypted Restic repository, retention policy and isolated restore rehearsal.

External dependencies intentionally retained are exchanges, market-data providers, Anthropic, Resend and other data/API providers. They are not hosting fallbacks.
