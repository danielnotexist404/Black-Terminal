# Persistent Worker Architecture

Black Cloud runs as a Node 22 container, not a Vercel function and not a browser WebSocket. The worker
claims durable commands, obtains a short connection lease, validates the current mandate and risk
policy, routes through the normalized adapter, reconciles results, and records redacted audit events.

## Ownership and fencing

`worker_leases` provides atomic acquisition, expiry, renewal, and a monotonic fencing token. Every
broker mutation calls `black_cloud_assert_current_fencing_token` immediately before network I/O. A
worker that loses its lease stops its private stream and cannot submit further mutations.

## Startup and readiness

Startup fails closed unless database, vault, lease, queue/inbox, and service identity probes succeed.
`/health/live` reports process-loop liveness. `/health/ready` also requires a fresh worker tick and
healthy dependencies. Broker-specific degradation is stored per connection. `/metrics` publishes
secret-free Prometheus counters and gauges for connection, reconnect, command, lease, and unknown-
submission state.

## Deployment template

`docker-compose.black-cloud.yml` supplies `restart: always`, a read-only root filesystem, dropped
Linux capabilities, resource limits, a readiness health check, graceful shutdown, and loopback-only
health/metrics exposure. Copy `.env.black-cloud.example` to a secret-managed runtime environment;
do not commit `.env.black-cloud`.

Deployment order:

1. Apply and verify the Chapter II-B migration.
2. Provision server/KMS secrets and testnet-only feature flags.
3. Build the immutable image and record its digest.
4. Start one worker and require `/health/ready = 200`.
5. Activate one no-withdrawal Bybit testnet connection.
6. Run browser-closed and worker-restart certification.
7. Add alerting and a rollback image before any canary expansion.

This repository contains the deployable artifact, not evidence that a third-party host is running it.
