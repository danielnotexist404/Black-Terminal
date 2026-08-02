# Black Cloud Persistent Connectivity

## Architectural boundary

Black Terminal separates three independent authorities:

```text
Authenticated UI session
  authorizes or revokes
Broker automation mandate
  permits bounded operations by
Black Cloud execution session
```

The browser is a control surface. It must never own broker credentials, private account sockets,
strategy runtime state, order monitoring, or position protection. Ordinary logout terminates the UI
session only. `Stop Automations and Log Out`, mandate revocation, broker disconnect, and emergency
account lock are explicit data-plane controls with different semantics.

## Implemented boundary

- The control plane is authenticated and schema validated under the existing consolidated API router.
- A signed, immutable, versioned automation mandate is required before the worker may read or trade.
- Broker credentials are stored as environment-bound v3 envelope-encrypted records and are decrypted only in the worker.
- The Node 22 worker owns private broker streams, leases, reconciliation, durable commands, and order mutations.
- A fencing token is asserted immediately before every external broker mutation.
- Account events enter a durable, deduplicated inbox before local OMS state is changed.
- Connection health separates credential, worker, synchronization, mandate, and execution-readiness state.

## Safety gates

Black Cloud fails closed when the database, queue, vault, lease subsystem, mandate, account sync, or
worker tick is unhealthy. Mainnet also requires `BLACK_CLOUD_MAINNET_ENABLED=true`. The Chapter II-B
code does not itself prove that an external worker host has been provisioned or that a live broker
scenario has passed.

## Runtime entry points

- Worker: `scripts/black-cloud-execution-worker.js`
- Worker runtime: `server/cloud-execution/worker.js`
- Connection supervisor: `server/cloud-execution/connection-supervisor.js`
- Repository and leases: `server/cloud-execution/repository.js`
- Control routes: `server/routes/cloud-execution/`
- Container: `Dockerfile.black-cloud`, `docker-compose.black-cloud.yml`
- Health: `GET /health/live`, `GET /health/ready`
- Metrics: `GET /metrics`

## Chapter II-D production node package

The existing VPS is the sole authorized host and will be `BLACK_CLOUD_NODE_01`. The node registry, generated worker-instance identity, synthetic crypto self-test, public-time clock gate, heartbeat/stale threshold, commit/digest-bound Compose configuration, bounded logging, preflight/deploy/rollback scripts and safe UI node health are implemented. Demo and Mainnet Live are isolated; Testnet is not used.

## Current operational truth

The architecture and local contract tests are implemented. Chapter II-B and II-C are applied; Chapter II-D adds the node registry and certification record. The current Codex environment has no VPS address, SSH user/port or usable SSH identity, so the container has not been built or started on the existing VPS. Private authentication, subscriptions, reconciliation, restart, reboot, browser-offline operation, protection and any external broker action remain untested. The truthful state is `PERSISTENT CAPABLE — REMOTE DEPLOYMENT BLOCKED`, not `FULLY PERSISTENT`.
