# Black Cloud Production Environment

Values are never documented. Presence may be checked with the preflight script, which does not print values.

| Variable | Class | Source | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | REQUIRED | root env file | Production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED/SECRET | root env file | Minimum server worker identity |
| `BLACK_CLOUD_SECRET_MASTER_KEY_V<n>` | REQUIRED/SECRET | root env file | Active credential-envelope wrapping keys |
| `BLACK_CLOUD_MASTER_KEY_VERSION` | REQUIRED | root env file | Current wrapping-key version |
| `BLACK_CLOUD_INTENT_SIGNING_KEY` | REQUIRED/SECRET | root env file | Mandate and intent verification |
| `BLACK_CLOUD_NODE_ID` | REQUIRED | root env file | Must be `BLACK_CLOUD_NODE_01` |
| `BLACK_CLOUD_WORKER_REGION` | REQUIRED | root env file | Operator-assigned region label |
| `BLACK_CLOUD_HOSTNAME` | OPTIONAL | root env file | Redacted host reference, not an IP secret |
| `BLACK_CLOUD_DEPLOYMENT_ENVIRONMENT` | REQUIRED | root env file | Must be `PRODUCTION` |
| `BLACK_CLOUD_DEPLOYMENT_COMMIT` | REQUIRED | build/deploy | Immutable Git revision |
| `BLACK_CLOUD_IMAGE_REFERENCE` | REQUIRED | build/deploy | Commit-tagged local image |
| `BLACK_CLOUD_IMAGE_DIGEST` | REQUIRED | build output | Exact local image ID/digest |
| `BLACK_CLOUD_EXECUTION_ENVIRONMENT` | REQUIRED | isolated worker | `DEMO` or `MAINNET_LIVE` |
| `BYBIT_ENDPOINT_PROFILE` | REQUIRED | root env file | Approved Bybit regional endpoint profile |
| `BYBIT_DEMO_ENABLED` | DEMO | root env file | Must be true for Demo worker |
| `BLACK_CLOUD_MAINNET_ENABLED` | MAINNET_LIVE | root env file | Explicit live infrastructure gate |
| `BLACK_CLOUD_EXECUTION_ENABLED` | REQUIRED | root env file | Durable worker execution gate |
| `INVESTMENT_GROUP_EXECUTION_ENABLED` | REQUIRED | root env file | Existing group execution foundation gate |
| `BYBIT_CLOUD_EXECUTION_ENABLED` | REQUIRED | root env file | Bybit adapter gate |
| `BLACK_CLOUD_STRATEGY_RUNTIME_ENABLED` | OPTIONAL | root env file | Keep false until runtime certification |
| `BLACK_CLOUD_POLL_INTERVAL_MS` | OPTIONAL | root env file | Queue polling interval |
| `BLACK_CLOUD_CLAIM_LIMIT` | OPTIONAL | root env file | Bounded command batch size |
| `BLACK_CLOUD_LEASE_TTL_SECONDS` | OPTIONAL | root env file | Connection lease TTL |
| `BLACK_CLOUD_NODE_HEARTBEAT_INTERVAL_MS` | OPTIONAL | root env file | Persistent node heartbeat period |
| `BLACK_CLOUD_MAX_CLOCK_DRIFT_MS` | OPTIONAL | root env file | Fail-closed signed-request threshold |
| `BLACK_CLOUD_HEALTH_BIND_ADDRESS` | OPTIONAL | root env file | Container health bind address |
| `BLACK_CLOUD_HEALTH_PORT` | OPTIONAL | root env file | Health port, default 8080 |
| `BLACK_CLOUD_METRICS_BIND_ADDRESS` | OPTIONAL | root env file | Container metrics bind address |
| `BLACK_CLOUD_METRICS_PORT` | OPTIONAL | root env file | Metrics port, default health port |
| `BLACK_CLOUD_LOG_LEVEL` | OPTIONAL | root env file | Structured logging threshold |

Deprecated or forbidden: `BLACK_CLOUD_WORKER_ID` as a stable node identity, `BLACK_CLOUD_NETWORK`, `BYBIT_BASE_URL`, and `BYBIT_PRIVATE_WS_URL`. The worker instance ID is generated per start. Endpoint overrides are rejected to preserve the outbound allowlist.

The health port may bind to `0.0.0.0` inside the container only because Compose publishes it exclusively on host loopback. Do not change the host mapping to a public address.
