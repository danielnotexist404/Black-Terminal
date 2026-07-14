# Bybit Mainnet Environment Setup

Status: Chapter XII-C operational activation guide.

Bybit remains fail-closed until the runtime configuration, Supabase prerequisites, private-stream worker, and operator certification evidence are present.

## Vercel Environment

Bybit rejects API requests originating from US IP addresses. Black Terminal therefore pins Vercel Functions to the Frankfurt region (`fra1`) in `vercel.json`. Do not move exchange-account or execution functions back to a restricted region such as the default Washington, D.C. region (`iad1`). After deployment, verify the function build region in `vercel inspect` before testing credentials.

The Bybit transport uses the two official global mainnet hosts, `api.bybit.com` and `api.bytick.com`, with automatic failover for network errors, HTTP 403, and upstream HTTP 5xx responses. A non-empty `BYBIT_BASE_URL` is attempted first for regional Bybit domains.

Set these in Vercel for API routes:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
EXCHANGE_CREDENTIAL_MASTER_KEY=
BYBIT_BASE_URL=https://api.bybit.com
BYBIT_PRIVATE_WS_URL=wss://stream.bybit.com/v5/private
BYBIT_NETWORK=mainnet
BYBIT_MAINNET_VALIDATION_ENABLED=false
BYBIT_MAINNET_ALLOWED_CONNECTIONS=
BYBIT_MAINNET_ALLOWED_SYMBOLS=*
# Optional absolute operator ceiling. Leave unset for live account-margin capacity.
BYBIT_MAINNET_MAX_NOTIONAL_USD=
BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS=
```

Leave `BYBIT_MAINNET_ALLOWED_CONNECTIONS` empty to permit authenticated owners to activate only their own trade-authorized accounts, or populate it with comma-separated account ids for an operator-managed allowlist. `*` explicitly allows every owned account while the remaining confirmation, permission, risk, symbol, and notional gates still apply.

Set `BYBIT_MAINNET_ALLOWED_SYMBOLS=*` to permit every symbol that passes live Bybit metadata, product, quantity, price, balance and risk validation. Use a comma-separated symbol list when an operator wants a narrower production universe.

`BYBIT_MAINNET_MAX_NOTIONAL_USD` is optional. A positive value is an absolute operator ceiling. When it is unset or zero, Black Terminal derives order capacity from Bybit Unified Account `totalAvailableBalance`, selected leverage, estimated fees, venue quantity/notional rules, risk tier and any positive per-account risk limits. Zero risk ceilings mean venue/account capacity; they do not disable authentication, venue validation, collateral checks, confirmations, emergency stops or withdrawal-permission blocking.

Secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `EXCHANGE_CREDENTIAL_MASTER_KEY`

Do not expose secrets with a `VITE_` prefix. The Supabase URL is not secret, but server routes should still prefer `SUPABASE_URL`.

## Private-Stream Worker Environment

Run this outside Vercel as a persistent supervised process:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
EXCHANGE_CREDENTIAL_MASTER_KEY=
BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED=true
BYBIT_STREAM_ACCOUNT_ID=
BYBIT_STREAM_SYMBOL=BTCUSDT
BYBIT_NETWORK=mainnet
npm run bybit:private-stream:supervise
```

Status check:

```bash
npm run bybit:private-stream:status
```

## Local Operator Environment

Use this only from the operator machine that will run certification:

```bash
BYBIT_CERTIFY_ACCOUNT_ID=
BYBIT_CERTIFY_SYMBOL=BTCUSDT
BYBIT_CERTIFY_API_BASE_URL=https://<vercel-deployment>
BYBIT_CERTIFY_USER_TOKEN=<short-lived-supabase-user-jwt>
BYBIT_CERTIFY_CONFIRMATION=
BYBIT_CERTIFY_OPERATOR_PAUSE=true
BYBIT_CERTIFY_INCLUDE_REVERSE=false
npm run certify:bybit-mainnet -- --interactive
```

Initial activation requires:

```text
LIVE BYBIT MAINNET
```

Exposure-changing stages require:

```text
LIVE
```

Abort any stage with:

```text
ABORT
```

## Infrastructure Verification

Before live validation:

```bash
npm run verify:bybit-infrastructure
```

This checks Chapter XI operational tables, portfolio/execution baseline tables, and optional relay RPC prerequisites without printing secrets.

## Rotation

To rotate Bybit API keys:

1. Disable live validation by setting `BYBIT_MAINNET_VALIDATION_ENABLED=false`.
2. Disconnect or delete the affected exchange account.
3. Create a Bybit API key without withdrawal permissions.
4. Reconnect through Positions.
5. Restart the private-stream worker with the new `BYBIT_STREAM_ACCOUNT_ID`.
6. Run diagnostics and certification again.

To rotate `EXCHANGE_CREDENTIAL_MASTER_KEY`, decrypt/re-encrypt existing credential records in a controlled maintenance window. Old encrypted payloads cannot be read after the key changes.

## Emergency Disable

Immediate kill switch:

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=false
```

Then redeploy Vercel and stop the private-stream worker. Existing account records remain stored, but order routes fail closed.
