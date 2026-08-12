# Bybit Demo and Mainnet Live Environment Setup

Status: Phase V Chapter II-C production activation guide.

Bybit remains fail-closed until runtime configuration, Supabase migrations,
credential permissions, UID verification, private-stream readiness and account
reconciliation are all valid.

## Vercel control plane

Vercel hosts authenticated UI/control routes only. It must not host the persistent
private WebSocket or execution worker. Configure:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
EXCHANGE_CREDENTIAL_MASTER_KEY=
BLACK_CLOUD_INTENT_SIGNING_KEY=
BYBIT_DEMO_ENABLED=true
BYBIT_MAINNET_VALIDATION_ENABLED=false
BYBIT_MAINNET_ALLOWED_CONNECTIONS=
BYBIT_MAINNET_ALLOWED_SYMBOLS=*
BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS=
CLOUD_EXECUTION_CONTROL_PLANE_ENABLED=false
```

Keep the control-plane flag false until an always-on worker reports healthy and
ready. Do not set `BYBIT_BASE_URL`, `BYBIT_PRIVATE_WS_URL`,
`BYBIT_NETWORK` or `BLACK_CLOUD_NETWORK`. Bybit endpoint selection is
centralized and audited from `DEMO`/`MAINNET_LIVE` plus the regional profile.

There is no mandatory Black Terminal dollar ceiling. Empty allowlists permit the
authenticated owner’s connection; `*` permits every symbol that passes current
Bybit metadata, collateral, account, OMS/EMS and optional user-policy checks.

Server-only secrets must never use a `VITE_` prefix.

## Persistent worker

Run `Dockerfile.black-cloud` on an always-on Linux host, outside Vercel. Deploy
one isolated worker per environment:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
EXCHANGE_CREDENTIAL_MASTER_KEY=
BLACK_CLOUD_INTENT_SIGNING_KEY=
BLACK_CLOUD_EXECUTION_ENVIRONMENT=DEMO
BYBIT_ENDPOINT_PROFILE=GLOBAL
BYBIT_DEMO_ENABLED=true
BLACK_CLOUD_MAINNET_ENABLED=false
BLACK_CLOUD_EXECUTION_ENABLED=true
INVESTMENT_GROUP_EXECUTION_ENABLED=true
BYBIT_CLOUD_EXECUTION_ENABLED=true
BLACK_CLOUD_WORKER_ID=
BLACK_CLOUD_WORKER_REGION=
docker compose -f docker-compose.black-cloud.yml up -d
```

For a live worker, set `BLACK_CLOUD_EXECUTION_ENVIRONMENT=MAINNET_LIVE`, select
the validated account jurisdiction in `BYBIT_ENDPOINT_PROFILE`, set
`BLACK_CLOUD_MAINNET_ENABLED=true`, and do not enable the Demo toggle.

Verify `/health/live`, `/health/ready` and `/metrics` before enabling the
Vercel control plane.

## Authorization model

Bybit connection is locked to Mainnet, the global endpoint, real funds and the
Unified account model. Manual execution readiness is established from the
authenticated server session, account ownership, broker trading permissions,
risk policy and withdrawal/transfer prohibition. There is no browser phrase
prompt. Persistent Black Cloud automation remains a separate, explicitly
gated capability and is never enabled by connecting the manual account.

Demo does not require a real-money confirmation, but its UI must state simulated
funds and simulated execution.

## Rotation and emergency disable

Credential rotation creates a new environment-bound v3 envelope and credential
version; older active envelopes are rotated atomically. Keep all referenced
wrapping-key versions available until their envelopes are retired.

Emergency control:

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=false
CLOUD_EXECUTION_CONTROL_PLANE_ENABLED=false
```

Pause new entries or invoke Account Lock in Black Terminal, preserve
broker-native protection, reconcile account state, then stop the relevant worker.
