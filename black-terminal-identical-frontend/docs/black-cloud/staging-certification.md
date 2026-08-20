# Black Cloud Staging Certification

Status: **STAGING PASS / PRODUCTION CUTOVER BLOCKED**

Evidence date: 2026-08-20 UTC

Canonical migration base: `21dfd6814b6e92a949ed9a7a0a422faa5d53605d` from `origin/main`

Migration candidate: branch `infra/black-cloud-central-vps`; the exact immutable release SHA is written to `.black-cloud-source-sha` and injected into runtime health metadata during deployment.

This report certifies the isolated Docker staging deployment only. It does not authorize DNS changes, public TLS exposure, hosted-service shutdown, live execution or real-funds testing.

## Docker topology

- Ubuntu host responsibility is limited to Docker, SSH, firewalling, fail2ban and unattended security updates.
- Frontend, central API, Caddy, PostgreSQL/Supabase, Auth, REST, Realtime, Storage, Event Alpha, market depth, BCLIF, Prometheus, Grafana, exporters and encrypted backup run as containers.
- Staging Caddy is bound to `127.0.0.1:18080`.
- Kong, Supavisor, Prometheus and Grafana are loopback-only.
- Database, Storage and administrative services have no public listener.
- Every inspected running container had restart count zero at certification time.
- The `live-execution` Compose profile was not started; observed execution-worker count was zero.
- `IMM_ENABLED=false` and `IMM_REQUIRED=false`; IMM absence does not block readiness.

## Data migration evidence

- Hosted source inventory: 133 public tables, 46 public functions, 140 RLS policies, five Auth users, two Storage buckets and three Realtime-published tables.
- Encrypted database and Storage exports were restored into the isolated target.
- Target Auth user count: five after disposable smoke-user cleanup.
- Target migration ledger: 28 entries; latest version `20260820153100`.
- Forward target corrections cover BCLIF lease qualification and Storage object-path regular expressions.
- Auth create/login/delete, authenticated RLS REST, two-bucket Storage discovery and Realtime `SUBSCRIBED` all passed against the self-hosted target.
- Built frontend assets contain no hosted Supabase project reference. The generic `supabase.co` text retained by the third-party SDK is not a configured fallback.

## Runtime evidence

- Central API readiness: `ready`; persistence `READY`; IMM `DISABLED`; exact source commit reported.
- BCLIF collector/source: `LIVE`; model `BCLIF_MODEL_V6_ABSOLUTE_SHELVES`; source `BYBIT_V6_PUBLIC_2026_08`; current fenced writer heartbeat observed within seconds.
- BCLIF observed growth: canonical chunks and deduplication rows continued increasing during the staging soak; no collector error/fatal log was observed in the sampled interval.
- Event Alpha: worker healthy with no failed processing job in the sampled state; all execution flags remain false.
- Market depth: collector online, ingest rows increasing, and source diagnostics reported zero rejected updates.
- Prometheus targets `black-cloud-api`, `containers`, `node` and `postgres` were all up. `pg_up=1` and alert count was zero after synchronizing the exporter credential with the restored database.
- Encrypted Restic snapshot `4657973a` was created at `2026-08-20T16:15:55Z` after the single-writer lock and extended-attribute verifier were deployed.
- Restic read every repository pack; archive checksums, `pg_restore --list`, and the Supabase Storage file-backend xattr check all passed.
- A disposable network-isolated PostgreSQL container restored the latest encrypted snapshot successfully and reproduced the critical counts: five Auth users, five `bt_users`, two Storage buckets and 28 migration-ledger rows.

## Measured loopback latency

Two hundred serial requests per endpoint were measured on the VPS staging loopback:

| Path | p50 | p95 | p99 | maximum |
| --- | ---: | ---: | ---: | ---: |
| central health | 5.477 ms | 7.739 ms | 11.426 ms | 15.234 ms |
| frontend index | 1.777 ms | 2.680 ms | 4.088 ms | 8.887 ms |
| PostgREST `bt_users` service query | 2.720 ms | 4.540 ms | 5.252 ms | 9.785 ms |

These are staging loopback samples, not internet latency, capacity certification or a production SLO.

## Repository verification

Passed on the migration workstation:

- TypeScript and production Vite build.
- Security contracts and built-asset secret audit.
- Event Alpha complete suite.
- BC-RDA deterministic, invariant, worker, Python parity, signal-intelligence and flow-pressure suites.
- BCLIF API, live pipeline, collector/orderbook/recovery/codec/no-lookahead, migration and client contracts.
- Black Cloud central API mapping, Storage transfer, Docker topology and migration-source contracts.
- Broker lifecycle, reconciliation, mandates, mainnet readiness, Bybit certification/state/external-order and non-mutating position-interaction suites.
- Kioseff, AIF, RADAP, liquidation-field, VWAP, oscillator, DOM and performance suites.
- Local production-CSP chart render with a live Pixi canvas and no `unsafe-eval`.
- Shell syntax for all Black Cloud scripts, four Docker Compose configuration renders and `git diff --check`.

The default public-site CSP test reached the unauthenticated landing page and could not enter the terminal. The same test passed against the built local production assets. Browser visual inspection through the Codex in-app browser was not available in this environment, so no visual-production claim is made.

## Hard cutover blockers

1. No encrypted off-host Restic repository/credential is configured. Same-host backup is not disaster recovery.
2. Google OAuth client credentials and production redirect configuration are absent; migrated Google identities cannot be called cutover-ready.
3. Sensitive Vercel values are non-readable after creation. The original exchange credential master key, Black Cloud secret master key and intent signing key must be supplied through an authorized secure channel; otherwise existing encrypted broker credentials and signature continuity cannot be certified.
4. Anthropic and Resend production provider credentials are absent.
5. Browser visual acceptance is not complete.
6. No live order, mutation, cancellation or real-funds test was performed.
7. No production DNS/TLS cutover approval has been given.
8. One VPS remains one failure domain and is not host-level high availability.

Until every applicable blocker is resolved, keep Vercel and hosted Supabase operational and treat Black Cloud as private staging.
