# Event Alpha operator runbook

## Safe rollout

1. Apply the Event Alpha migration using the normal reviewed Supabase migration process. Do not enable flags before the database migration succeeds.
2. Configure one verified HTTPS provider and an exact host allowlist. Never place its token in a `VITE_` variable or browser bundle.
3. Start with all values from `.env.event-alpha.example` unchanged. The UI should report engine off and no source fallback.
4. Enable `EVENT_ALPHA_ENGINE_ENABLED=true` for the read/research control plane. This alone does not start ingestion.
5. Enable `EVENT_ALPHA_INGESTION_ENABLED=true` and `EVENT_ALPHA_TOKEN_SUPPLY_ENABLED=true` only after the provider is reviewed. Confirm the source registers as `HEALTHY` or remains truthfully `DISABLED`.
6. Validate immutable ingestion, duplicate replay, revision behavior, expectation timestamps and audit evidence.
7. Only after a paper review, set `EVENT_ALPHA_STRATEGY_KILL_SWITCH=false` and `EVENT_ALPHA_GLOBAL_EXECUTION_KILL_SWITCH=false`, enable `EVENT_ALPHA_PAPER_EXECUTION_ENABLED=true`, and keep `EVENT_ALPHA_REQUIRE_MANUAL_APPROVAL=true`.

There is deliberately no supported live-execution configuration. If `EVENT_ALPHA_LIVE_EXECUTION_ENABLED=true` is injected, the API and worker reject operation.

## Commands

```bash
npm run test:event-alpha-all
npm run benchmark:event-alpha
npm run typecheck
npm run build
npm run event-alpha:worker
```

Run the synthetic point-in-time research replay (it never reaches an order adapter):

```bash
npm run event-alpha:replay -- --input fixtures/event-alpha/token-unlock-replay.json
```

The worker requires `SUPABASE_URL` plus a server secret, and exits/fails if the durable control plane is unavailable. It never requires exchange credentials.

## Incident response

- `QUARANTINED`: leave the source disabled; inspect only the safe error code, adapter version, configuration fingerprint and provider status. Never log the token or raw authorization header.
- Queue growth: stop paper approvals, preserve the queue, and restore the worker/database. Do not process in the browser.
- Material revision: invalidate or return affected theses to `OBSERVING`; never mutate old revisions.
- Expectation lookahead: reject the snapshot and backtest run. Do not relabel it as pre-event evidence.
- Unsafe live flag: remove it; this is a configuration incident, not an authorization prompt.

## Rollback

Application rollback may disable the engine flags and roll back the application image. The evidence migration is forward-only; preserve ledger tables. Do not drop immutable evidence as part of an app rollback.
