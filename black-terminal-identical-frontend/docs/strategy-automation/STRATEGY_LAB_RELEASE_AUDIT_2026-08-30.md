# Strategy Lab production release audit — 2026-08-30

## Executive result

Strategy Lab is at **controlled production beta / execution release-candidate** maturity. The account-equity, directional-leverage, duplicate-signal, partial-exit, reversal, recovery, and deployment defects addressed by this release have deterministic automated coverage. Production migration and container evidence is recorded during the release procedure, and every strategy target remains unarmed after deployment.

This audit does **not** certify Super7 as an exact live replica of TradingView yet. The original Pine strategy recalculates its ATR exits on subsequent bars; the current Black Terminal adapter resolves the signed TP ladder from the signal context and re-anchors it to the confirmed venue fill, but does not continuously reprice those orders on every later closed bar. That difference is a release blocker for any claim of exact Pine/TradingView equivalence.

No Demo or Mainnet order was submitted during this audit. Tests validate the request contracts and safety boundaries without mutating a broker account.

## Delivered in this release

### Account equity and settings

- Connected broker destinations now read a server-owned `broker_account_equity_snapshots` row produced by authenticated Bybit wallet synchronization.
- Strategy Settings selects the attached broker/group destination instead of silently falling back to the Paper account.
- The UI identifies the field as `Full account equity · API`, treats it as read-only, displays its source timestamp/freshness, and blocks saving broker sizing while the snapshot is absent or stale.
- Fixed-USDT sizing cannot exceed the lesser of total equity and available balance.
- Long and short per-trade leverage are shown beside equity sizing, persist on the selected target, and are passed through server-side risk caps to Bybit leverage configuration before a non-reduce-only futures entry.
- Unsaved settings are no longer overwritten by background refreshes; a failed multi-stage save refetches and rehydrates authoritative VPS state instead of leaving a stale editor open.

### Entries, reversals, and partial exits

- One closed-candle signal key can enqueue only one command per target at the database boundary.
- A same-direction signal is suppressed when that strategy generation is already open.
- Reversal uses deterministic close and entry leg IDs; the entry is blocked until the previous direction is confirmed flat.
- TP1–TP7 are separate reduce-only orders. Quantities are reserved from the actual final cumulative entry fill, floored to Bybit quantity precision, and rejected before submission when the complete configured ladder cannot satisfy venue minimums.
- TP orders are generation-fenced: an old long ladder cannot attach after long → short → long.
- Direct broker and Investment Group paths both recover accepted Bybit orders by deterministic client order ID before evaluating mutable pause, mandate, read-only, or kill-switch gates.
- `PartiallyFilledCanceled` is terminal and retains the cumulative fill. A partially closed reversal with residual exposure fails closed for manual reconciliation rather than opening the new side on top of residual risk.

### Worker availability and deployment safety

- Connection-lease contention during a rolling restart no longer consumes broker execution attempts.
- A PostgreSQL two-worker regression exercised twelve consecutive contention cycles and kept `attempt_count` at zero.
- A genuinely exhausted `RETRY` command is transitioned to `DEAD_LETTER` instead of remaining permanently invisible to workers.
- Release Compose requires explicitly selected frontend, API, and runtime images and reports the exact commit and runtime image identity.
- CI runs the aggregate Strategy Lab release gate.

## Diagnostic evidence

The release matrix completed successfully without broker mutation:

- Production TypeScript typecheck and Vite build: pass (2,716 modules).
- Security contracts: 28 route contracts plus negative-envelope/CORS controls passed.
- Security asset audit: 49 production assets contained no provider secrets.
- PostgreSQL strategy tests: RLS, immutable versions, signed activation, environment-partitioned claims, target fencing, exactly-once signal keys, directional leverage, lease failover, and dead-letter exhaustion passed.
- Super7 offline audit: setup-formula parity, prefix no-repaint, duplicate suppression, reversal barriers, final-fill TP reservations, venue-fill anchoring, reduce-only request shape, and leverage mapping passed.
- Bybit adapter tests: endpoint isolation, server-owned routing, metadata precision, order validation, canonical statuses, private-stream normalization, position identity, snapshot races, and lifecycle handling passed.
- Strategy Lab isolation: automated destinations cannot leak into the personal chart, portfolio, manual orders, or venue state.
- Investment Group allocation, mandate, persistence, reconciliation, and risk tests: pass.
- Infrastructure and immutable release topology: pass.
- Fixture performance: 50 strategies / 9 targets / 500 trades / 1,000 logs yielded p50 0.039 ms, p95 0.149 ms, p99 0.234 ms; the nine-target automation fixture sustained 71,530 model operations/second.

These are deterministic software and database tests. They are evidence of implementation correctness, not evidence of future strategy profitability or a substitute for an authenticated venue canary.

## Remaining release blockers for exact TradingView parity

1. **Dynamic Pine exit repricing.** Recalculate and safely modify TP1–TP4 on every confirmed bar exactly as Pine does, while retaining fixed-percentage exits and cumulative-fill quantity ownership.
2. **Signed source/golden certification.** Pin the exact Pine source hash and compare Black Terminal against exported TradingView closed-bar signals, orders, and fills over multiple symbols/timeframes.
3. **Intrabar execution model.** Define and reproduce TradingView bar magnifier, order-delay, slippage, limit-fill, and same-bar exit ordering semantics.
4. **Durable warm-up history.** Certify restart parity beyond the current rolling runtime window and restore all indicator/position state from durable checkpoints.
5. **Authenticated Bybit Demo lifecycle canary.** With explicit user authorization, execute a bounded entry → partial TP → reversal → remaining TP scenario and reconcile REST, private stream, database ledger, chart labels, and account equity. This audit intentionally did not place that order.
6. **Residual reversal continuation.** Replace the current fail-closed manual path with bounded deterministic residual-close legs (`-c2`, `-c3`, …) before allowing the opposite entry.
7. **Pyramiding semantics.** Live pyramiding above one position generation is not certified and should remain blocked until attribution and TP ownership are designed explicitly.
8. **Atomic settings transaction.** The current save sequence is recovery-safe but not a single composite database transaction; consolidate it into one version-fenced RPC.

## Recommended development sequence

### P0 — before investors use Super7 on real funds

- Implement dynamic confirmed-bar TP repricing and golden Pine fixtures.
- Run the authenticated Bybit Demo lifecycle canary, including forced partial fills and a worker restart between venue acknowledgement and database persistence.
- Add residual reversal continuation and certify hedge-mode/one-way-mode behavior separately.
- Enforce a runtime certification record containing source hash, settings hash, data-feed identity, timeframe, and execution-model version before a target can be armed.

### P1 — faster and more responsive execution

- Keep private Bybit streams hot per connected account and use REST only for reconciliation/fallback.
- Co-locate execution workers near the configured Bybit endpoint while keeping the database control plane region explicit.
- Preload instrument metadata and refresh it asynchronously; never fetch symbol filters on the signal critical path.
- Emit latency spans for signal close → durable command → claim → risk approval → Bybit acknowledgement → private fill → UI render, with p50/p95/p99 alarms.
- Split strategy evaluation from broker submission queues so a slow account cannot head-of-line block unrelated connections.
- Add rate-limit-aware batching and adaptive backoff without consuming business attempts.

### P2 — institutional operations

- Add shadow execution/replay, daily reconciliation attestations, operator incident timelines, immutable configuration approvals, and per-strategy kill-switch drills.
- Add portfolio-level cross-strategy exposure/netting rules before allowing multiple strategies on one account.
- Add blue/green worker failover drills and automated rollback based on queue age, reconciliation divergence, or stale equity.

## Current product-state assessment

- **Strategy authoring/UI:** production beta.
- **Paper execution and deterministic regression:** release candidate.
- **Broker connectivity, equity synchronization, and leverage plumbing:** production beta, pending authenticated post-release observation.
- **Generic Bybit order safety/reconciliation:** release candidate with fail-closed residual reversal behavior.
- **Super7 exact TradingView equivalence:** not yet certified because dynamic ATR exit repricing and golden live fixtures remain incomplete.
- **Investor-grade unattended Mainnet Super7:** not approved by this audit. Keep targets disarmed until the P0 certification sequence is complete.
