# Phase V — Chapter II-C: Bybit Production Connectivity

## Certified environment contract

The active Bybit path accepts exactly one execution environment per connection and per worker:

- `DEMO`: simulated funds, Demo REST/private account system, Mainnet public market data, REST order entry.
- `MAINNET_LIVE`: real funds and real execution, with an explicit live confirmation and a validated regional endpoint profile.

Testnet is not part of this certification path. Endpoint URLs are resolved only by
`server/exchanges/bybit-endpoints.js`; URL overrides are rejected.

## Migration order

Apply the files through the linked Supabase migration workflow, in order:

1. `202608020001_phase5_chapter2b_persistent_connectivity.sql`
2. `202608020002_phase5_chapter2c_bybit_production_activation.sql`

The second migration adds environment-bound credential envelopes (v3), immutable
risk-policy versions, permission snapshots, UID binding, certification state and
atomic environment-bound automation mandates.

## Worker environment manifest

| Variable | Class | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | REQUIRED | Production Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED/SECRET | Service worker identity; worker host only |
| `BLACK_CLOUD_SECRET_MASTER_KEY_V<n>` | REQUIRED/SECRET | Credential wrapping keys |
| `BLACK_CLOUD_MASTER_KEY_VERSION` | REQUIRED | Active wrapping-key version |
| `BLACK_CLOUD_INTENT_SIGNING_KEY` | REQUIRED/SECRET | Mandate and intent signing |
| `BLACK_CLOUD_WORKER_ID` | REQUIRED | Stable unique worker identity |
| `BLACK_CLOUD_WORKER_REGION` | REQUIRED | Auditable host region |
| `BLACK_CLOUD_EXECUTION_ENVIRONMENT` | REQUIRED | `DEMO` or `MAINNET_LIVE` |
| `BYBIT_ENDPOINT_PROFILE` | REQUIRED | Validated Mainnet regional profile; `GLOBAL` for Demo |
| `BYBIT_DEMO_ENABLED` | DEMO | Must be `true` for a Demo worker |
| `BLACK_CLOUD_MAINNET_ENABLED` | MAINNET_LIVE | Must be `true` for a live worker |
| `BLACK_CLOUD_EXECUTION_ENABLED` | REQUIRED | Global execution gate |
| `INVESTMENT_GROUP_EXECUTION_ENABLED` | REQUIRED | Group execution gate |
| `BYBIT_CLOUD_EXECUTION_ENABLED` | REQUIRED | Provider execution gate |
| `BLACK_CLOUD_HEALTH_PORT` | OPTIONAL | Health/metrics port; default 8080 |
| `BLACK_CLOUD_POLL_INTERVAL_MS` | OPTIONAL | Durable queue poll interval |
| `BLACK_CLOUD_CLAIM_LIMIT` | OPTIONAL | Commands claimed per poll |
| `BLACK_CLOUD_LEASE_TTL_SECONDS` | OPTIONAL | Connection lease duration |
| `BLACK_CLOUD_NETWORK` | DEPRECATED | Rejected for this chapter |
| `BYBIT_BASE_URL` | DEPRECATED | Forbidden endpoint override |
| `BYBIT_PRIVATE_WS_URL` | DEPRECATED | Forbidden endpoint override |

Deploy separate Demo and Mainnet worker instances. Never put worker service-role
credentials, vault keys or persistent broker sockets in Vercel.

## Readiness and incident truth

Execution remains blocked until the credential environment, connection,
automation mandate and isolated worker environment all match; the UID and current
permission snapshot pass; the private stream authenticates/subscribes; REST
reconciliation completes; and a current fencing lease is held.

If permissions, UID, private-stream health or reconciliation changes, the
connection is degraded and new execution is blocked. Broker-native protection is
preserved.

## Certification boundary

Source tests and deployment health prove infrastructure only. Demo or Mainnet
execution certification requires user-supplied credentials, a user-selected valid
order size and recorded broker events. Never infer a fill from a REST
acknowledgement and never mark live execution certified without that evidence.
