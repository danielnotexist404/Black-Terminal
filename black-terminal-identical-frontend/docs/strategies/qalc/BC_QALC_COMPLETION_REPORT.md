# BC-QALC Completion Report

This is an engineering checkpoint, not a final certification claim.

Implemented: canonical QALC Bybit L200+trade normalization, serialized arrival-order processing, atomic book, event dedupe, exchange clock monitor, dynamic instrument events, multi-horizon weighted QI/microprice/OFI/real CVD/volatility/cancellation/replenishment/resilience/sweep/toxicity features, separate models, authenticated account-fee adapter, all-in cost gate, one-sided PostOnly Paper lifecycle, conservative queue fills, partial fills, inventory/risk exits, gzip+SHA-256 archive, deterministic replay, authenticated configuration/status API, RLS metadata migration, Docker worker and Strategy Lab wizard/cockpit.

Starting commit: `97767f7cc52d5a5dcbe3b92cf5315990677ae7ac`. Implementation commit: `671f7557d224c4b736a82054e881274741e04117`. Credential-isolation follow-up: `9e37a7e8643877d841c5762973a00d41e80f869d`.

VPS preview deployment: immutable release `/opt/black-cloud/releases/9e37a7e-local-ai-v2`, frontend/API/runtime images tagged `9e37a7e-local-ai-v2`, and additive migration `202608230004_black_core_qalc`. Encrypted pre-migration Restic snapshot `403dcd4f` passed snapshots/trees/blobs plus a 5% data-pack read with zero errors. Migrations `202608230002` and `202608230003` remain deliberately unapplied and are not prerequisites for QALC metadata.

Measured in the exact VPS runtime image over 20,000 synthetic events: order-book p50/p95/p99 `0.0050/0.0117/0.0236 ms`, feature `0.0593/0.1191/0.4834 ms`, and model `0.00037/0.00166/0.00264 ms`. An early real-feed telemetry sample over 4,406 accepted events measured order-book `0.215/0.308/0.446 ms`, feature update `0.024/0.047/0.071 ms`, Paper decision `0.170/0.258/0.474 ms`, and total event processing `0.645/1.055/1.221 ms`. These are engineering samples, not soak-test claims.

Certification: RESEARCH. The deployed worker has no privileged runtime env file, no inbound ports, only public egress, and hard-false Paper/live/group flags. It is intentionally `RISK_SUSPENDED` until an owned account fee schedule is bound after replay certification. The platform-wide single-socket raw-event bus, calibration, markout/statistical/sensitivity reports, checkpoint recovery and elapsed forward tests remain pending. No real order was placed. Live execution and Investment Group fanout remain disabled. No claim is made for profitability, calibrated expectancy, restart recovery, VPS reboot recovery, 24h, 72h or seven-day forward stability.
