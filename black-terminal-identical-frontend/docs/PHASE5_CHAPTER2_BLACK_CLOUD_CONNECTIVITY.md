# Phase V Chapter II — Black Cloud Connectivity

Status: implementation and production control-plane migration deployed; persistent worker provisioning and offline execution certification remain open.

Production web deployment: `dpl_Hh9aSdgTBvT7KCLLGFgxy3pqT8iA`. Supabase Chapter II migrations `202607200003` through `202607200006` are applied; all eleven local/remote migrations match.

## Implemented

- persistent `BlackCloudExecutionWorker` with command claims, leases, fencing, bounded retries and graceful drain;
- `BrokerConnectionManager` behavior through the cloud connection supervisor: discovery, heartbeat, private stream, reconnect, health, recovery and reconciliation;
- formal server ExchangeAdapter registry with Bybit as the initial implementation;
- AES-256-GCM credential boundary and operation-scoped server retrieval;
- atomic credential rotation and strict mainnet/testnet account isolation;
- capability discovery and withdrawal prohibition;
- signed Trade Intents, immutable versions and deterministic expansion;
- proportional follower allocation and pre-execution mandate/risk/capability enforcement;
- continuous private-event synchronization and exchange-authoritative reconciliation;
- deterministic duplicate prevention and ambiguous-submission recovery;
- pause/resume/emergency-stop controls that preserve monitoring and positions;
- authenticated Black Cloud status/control APIs and server-backed Portfolio Manager dashboard;
- OCI worker packaging on Node 22 with `/live` and `/ready` probes;
- dedicated broker connectivity, investor execution, mandate and reconciliation suites.

## Rollout Boundary

The production control plane intentionally remains disabled for activation until an always-on container provider is provisioned. No claim is made that broker connections currently survive device shutdown. Enablement order is: deploy worker with testnet flags, verify `/ready`, enable the Vercel control plane, activate a test connection, complete the offline certification, then consider mainnet.

## Verification

- `npm run test:phase5-chapter2` passes all five suites.
- `npm run security:contracts` passes 27 strict mutating-route contracts.
- TypeScript and production build pass; bundled assets contain no provider secrets.
- live `/api/cloud-execution/status` and `/control` enforce bearer authentication.
- chart CSP regression remains passing after deployment.

See the dedicated broker, mandate, intent, reconciliation, adapter and offline-certification documents for operational detail.
