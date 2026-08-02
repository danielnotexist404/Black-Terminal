# Black Cloud Node 01 Runbook

## Identity

- Stable node: `BLACK_CLOUD_NODE_01`
- Container: `black-cloud-node-01`
- Deployment: `/opt/black-terminal/black-cloud`
- Secrets: `/etc/black-terminal/black-cloud-node01.env`, root-owned mode 600
- Health and metrics: `127.0.0.1:8080`
- Worker instance: generated on every process start and stored beside the stable node ID

## Daily checks

```bash
sudo docker ps --filter name=black-cloud-node-01
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/metrics | grep -E 'worker_ready|node_heartbeat_age|clock_|queue_depth|active_connections'
sudo docker logs --since 30m black-cloud-node-01
```

Expected healthy state: container health `healthy`, liveness `live`, readiness `ready`, startup phase `WORKER_READY`, clock not `UNSAFE`, recent node heartbeat, and no unbounded reconnect loop.

## Startup phases

`PROCESS_STARTING → CONFIG_VALIDATING → CRYPTO_SELF_TEST → DATABASE_CONNECTING → SCHEMA_VALIDATING → LEASE_SUBSYSTEM_READY → QUEUE_READY → WORKER_READY`.

Failure phases are explicit: `CONFIGURATION_ERROR`, `CRYPTOGRAPHIC_ERROR`, `DATABASE_UNAVAILABLE`, `SCHEMA_MISMATCH`, `LEASE_UNAVAILABLE`, `QUEUE_UNAVAILABLE`, `CLOCK_UNSAFE`, and `FATAL`. `CLOCK_UNSAFE` blocks new queue claims and new broker submissions while the process and reconciliation supervisor remain available.

## Controlled restart

```bash
sudo docker restart --time 45 black-cloud-node-01
curl --retry 30 --retry-delay 2 --retry-all-errors --fail http://127.0.0.1:8080/health/ready
```

Expected: old instance records `DRAINING`, the container restarts, a new worker instance ID appears, crypto self-test passes, leases recover, private streams reconnect, reconciliation completes, and readiness returns. Do not certify these outcomes from HTTP alone; inspect Supabase health/audit records and the Bybit connection state.

## Emergency operator rules

- Use Black Terminal's authenticated emergency controls for trading actions.
- Do not call a hidden worker order API; none is exposed.
- Do not delete leases manually while a worker is active.
- Do not delete broker-native protection during recovery.
- Do not enable Mainnet automation merely to test container health.
- When the clock is unsafe, fix host time synchronization before re-enabling new submissions.

## Reboot proof

After container-restart certification succeeds, schedule a real VPS reboot. Record the pre-reboot worker instance, node heartbeat, leases, open positions and broker-native protections. After reboot, prove Docker starts automatically, Compose's `restart: always` restores the container, the instance changes, reconciliation completes, and no duplicate order appears.
