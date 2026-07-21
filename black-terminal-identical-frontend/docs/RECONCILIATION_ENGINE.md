# Reconciliation Engine

The exchange is authoritative. Reconciliation runs at worker startup, after reconnect, periodically, after private events, after ambiguous submissions and on manual request.

Each run compares balances, positions and active orders with the venue snapshot. It detects balance changes, partial/stale positions, local orders absent from the open-order snapshot and external state changes. Known orders are updated, venue balances/positions replace cached snapshots, stale local positions are zeroed, and every difference/repair is stored in `reconciliation_runs`.

Private order and fill events update known Black Terminal orders immediately and schedule a debounced reconciliation. Duplicate stream events are suppressed. Ambiguous HTTP submission never causes a blind retry: the worker first searches by deterministic client order ID and adopts the venue order if found.

Failures set connection health to degraded, preserve evidence without secrets and remain eligible for bounded retry or operator review. Reconciliation continues while execution is paused or emergency-stopped.
