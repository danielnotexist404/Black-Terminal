# Bybit Worker Restart Certification

Status: `NOT EXECUTED` until `BLACK_CLOUD_NODE_01` is reachable.

Test restart separately while idle, while a limit order is pending, while partially filled, with an open protected position, while a strategy waits for a signal, and while a submission outcome is ambiguous. Begin with Demo; Mainnet requires explicit authorization and broker-native protection.

For each case record the stable node ID, old/new worker instance IDs, image digest, lease generation, deterministic client order ID, broker order ID, durable intent status, position and protection state.

Expected sequence:

1. SIGTERM changes node state to `DRAINING` and stops new claims.
2. In-flight work finishes or remains durably recoverable.
3. Private streams close; broker-native protection remains.
4. `restart: always` launches a new instance.
5. Config and synthetic crypto self-tests pass.
6. Supabase schema, queue and leases validate.
7. Clock is safe.
8. The lease is acquired/renewed with valid fencing.
9. Bybit authenticates and acknowledges required subscriptions.
10. Account/OMS reconciliation completes before new entries resume.

Pass only with no duplicate entry, exit, TP/SL or fill; no stale worker submission; no missing position; and correct recovery of an ambiguous deterministic client ID. HTTP readiness alone is insufficient.

After container restart succeeds, repeat through an approved real VPS reboot. A reboot that has not been performed must remain `NOT TESTED`.
