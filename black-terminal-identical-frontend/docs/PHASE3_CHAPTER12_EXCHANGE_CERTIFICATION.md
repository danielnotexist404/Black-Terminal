# Phase III Chapter XII - Universal Exchange Certification

Date: 2026-07-11

Status: Bybit production-certification layer implemented. Production-certified status is still blocked until live private-stream runtime and recorded validation evidence are completed.

Chapter XII converts the Chapter XI truth layer into executable exchange certification. This sprint stays scoped to Bybit. Binance, OKX, and other adapters must not start until Bybit is either fully certified or explicitly blocked by an external venue/runtime requirement.

## Bybit Implemented

- Server time diagnostics and clock-skew measurement.
- V5 instrument metadata loading.
- Metadata-backed order validation for tick size, quantity step, min quantity, min notional, max quantity, leverage, margin mode, and time in force.
- Balance, position, and open-order snapshots.
- API-key permission probe.
- Private WebSocket client for `order`, `execution`, `position`, and `wallet`.
- Private-stream heartbeat, stale detection, reconnect, resubscribe, diagnostics, and event normalization.
- Long-running worker entrypoint: `npm run bybit:private-stream`.
- Snapshot plus stream reconciliation service.
- Reconciliation route: `POST /api/exchange-accounts/sync`.
- Diagnostics route persists updated certification, health, time-sync, metadata, endpoint, and private-stream runtime state.
- Order placement for market, limit, reduce-only, post-only, GTC, IOC, and FOK where venue metadata allows it.
- Order management routes:
  - `POST /api/execution/cancel`
  - `POST /api/execution/cancel-all`
  - `POST /api/execution/modify`
  - `POST /api/execution/position-action`
  - `POST /api/execution/protection`
  - `POST /api/execution/account-mode`
- Explicit margin-mode and position-mode controls. These are never changed silently by normal order placement.
- Native Bybit TP/SL/trailing-stop protection route.
- Normalized Bybit execution reports.
- Mainnet validation record creation for Bybit order attempts.
- Account-owner controlled validation route: `POST /api/exchange-accounts/mainnet-validation`, with server-side trade-permission revalidation.
- Unified Execution Ticket, Portfolio execution panel, and DOM Pro+ send Bybit orders through the server-backed portfolio route.
- Unified Execution Ticket consumes Bybit Unified Account `totalAvailableBalance`, equity, and margin state from authenticated account sync.
- USD-value order sizing is converted to metadata-aligned base quantity before venue validation and submission.
- Both browser risk preview and server execution reject orders whose required collateral plus estimated fees exceeds venue-reported available balance.
- Account owners can explicitly activate a trade-authorized Bybit key through the existing mainnet-validation route; withdrawal-enabled keys remain blocked.

## Validation Harness

Bybit live validation is fail-closed unless all are true:

- `BYBIT_MAINNET_VALIDATION_ENABLED=true`
- authenticated Supabase session
- account id is in `BYBIT_MAINNET_ALLOWED_CONNECTIONS` when an operator allowlist is configured
- symbol is in `BYBIT_MAINNET_ALLOWED_SYMBOLS`
- `BYBIT_MAINNET_MAX_NOTIONAL_USD` is configured
- user is admin or in `BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS`
- account has explicitly been enabled with `ENABLE BYBIT LIVE VALIDATION`
- browser session has Developer Mainnet Validation Mode enabled
- each order includes `mainnetConfirmed=true`
- each order includes `liveConfirmation=LIVE`
- OMS/EMS/Risk approve the order
- venue metadata validation passes

Disable account validation with `DISABLE BYBIT LIVE VALIDATION`.

## Private Stream Runtime

Vercel API routes cannot host persistent private WebSockets. The Bybit private stream must run in a long-lived Node process:

```bash
BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED=true
BYBIT_STREAM_ACCOUNT_ID=<exchange_accounts.id>
BYBIT_STREAM_SYMBOL=BTCUSDT
npm run bybit:private-stream
```

The worker authenticates, subscribes to private topics, audits incoming events, and triggers snapshot reconciliation on fills, positions, and wallet updates.

## Certification Matrix

| Requirement | Status | Reason |
| --- | --- | --- |
| Auth | Implemented | Diagnostics authenticate with stored encrypted credentials. |
| Account reads | Implemented | Balances, positions, and open orders are loaded. |
| Private streams | Implemented / Runtime required | Client and worker exist, but production certification requires a live worker run. |
| Market order | Implemented / Validation required | Route exists behind mainnet validation gate. |
| Limit order | Implemented / Validation required | Route exists behind metadata validation and mainnet gate. |
| Cancel | Implemented / Validation required | Cancel and cancel-all routes exist behind management gate. |
| Modify | Implemented / Validation required | Amend route exists behind management gate. |
| Close / partial close | Implemented / Validation required | Position action route exists. |
| Reverse | Implemented / Validation required | Reverse route closes then opens opposite side. |
| TP/SL/trailing | Implemented / Validation required | Native Bybit trading-stop route exists. |
| Reconnect reconciliation | Implemented / Runtime validation required | Worker reconnects and reconciliation service repairs snapshots. |
| Mainnet validation evidence | Blocked | Requires real Bybit account, allowlisted account id, env configuration, and tiny live validation orders. |

Bybit must remain `partial`, not production-certified, until the validation evidence is recorded in `mainnet_validation_records` and private-stream diagnostics prove reconnect/reconciliation.

## Tests

Command:

```bash
npm run test:bybit-certification
npm run build
```

Coverage:

- clock-skew math
- metadata precision
- minimum-notional validation
- order status normalization
- execution report mapping
- private-stream event normalization
- WebSocket auth payload shape
- fail-closed mainnet gate

## Environment

```bash
BYBIT_MAINNET_VALIDATION_ENABLED=true
BYBIT_MAINNET_VALIDATION_ADMIN_EMAILS=owner@example.com
BYBIT_MAINNET_ALLOWED_CONNECTIONS=<exchange_accounts.id>
BYBIT_MAINNET_ALLOWED_SYMBOLS=BTCUSDT,ETHUSDT
BYBIT_MAINNET_MAX_NOTIONAL_USD=5
BYBIT_PRIVATE_STREAM_RUNTIME_ENABLED=true
BYBIT_STREAM_ACCOUNT_ID=<exchange_accounts.id>
BYBIT_STREAM_SYMBOL=BTCUSDT
```

Hyperliquid remains separate:

```bash
HYPERLIQUID_RELAY_ENABLED=true
HYPERLIQUID_MAINNET_VALIDATION_ENABLED=true
```

`BYBIT_MAINNET_ALLOWED_CONNECTIONS` is an optional operator restriction. When non-empty, only listed account ids (or `*`) can be activated. When empty, an authenticated owner may activate only their own account after the API key's trading and withdrawal permissions are revalidated.

## Remaining Blocker

The current code is ready for controlled Bybit validation, but it cannot honestly mark Bybit production-certified until a real Bybit credential with trade permission is activated, the private-stream worker is running, and tiny live orders validate market, limit, cancel, modify, close, TP/SL, reconnect, and reconciliation.

## Chapter XII-B Mainnet Certification Runner

Chapter XII-B adds the production validation command. It does not certify Bybit by itself; it verifies runtime readiness, executes tiny live steps only after explicit operator confirmation, records evidence, and writes `docs/BYBIT_MAINNET_CERTIFICATION_REPORT.md`.

Command:

```bash
npm run certify:bybit-mainnet
```

The runner refuses to continue unless all required safety inputs exist:

- `BYBIT_MAINNET_VALIDATION_ENABLED=true`
- `EXCHANGE_CREDENTIAL_MASTER_KEY`
- `SUPABASE_URL` or `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BYBIT_CERTIFY_ACCOUNT_ID`
- `BYBIT_CERTIFY_API_BASE_URL`
- `BYBIT_CERTIFY_USER_TOKEN`
- `BYBIT_MAINNET_ALLOWED_CONNECTIONS`
- `BYBIT_MAINNET_ALLOWED_SYMBOLS`
- `BYBIT_MAINNET_MAX_NOTIONAL_USD`
- fresh private-stream health from `npm run bybit:private-stream`
- typed `LIVE` confirmation

Validated sequence:

- preflight account and stream readiness,
- tiny away-from-market limit submit/cancel,
- modify then cancel,
- tiny market fill,
- position sync,
- native TP/SL attach/modify/cancel/restore,
- partial close if minimum size permits,
- full close,
- optional reverse with `BYBIT_CERTIFY_INCLUDE_REVERSE=true`,
- private-stream restart and reconciliation.

Registry rule:

- `src/connectivity/venueRegistry.ts` must remain partial until the report and Supabase evidence show every required step passed.

## Chapter XII-C Activation Checkpoint

Chapter XII-C converts Bybit certification into an operational activation workflow.

Added:

- `.env.bybit-mainnet.example` with exact runtime variable names.
- `docs/BYBIT_MAINNET_ENVIRONMENT_SETUP.md`.
- `npm run verify:bybit-infrastructure`.
- `npm run bybit:private-stream:supervise`.
- `npm run bybit:private-stream:status`.
- `GET /api/exchange-accounts/bybit-runtime-status`.
- `server/exchanges/bybit-certification.js` deterministic decision evaluator.
- Bybit runtime/certification visibility in the Positions execution dock.
- Runner preflight output with `PASS`, `FAIL`, `WARNING`, and explicit blockers.
- Certification evidence persistence into `mainnet_validation_records.metadata`.

Updated runner behavior:

- Initial live activation requires `LIVE BYBIT MAINNET`.
- Each exposure-changing live stage requires `LIVE`.
- `ABORT` stops the sequence immediately.
- Existing orders or positions are a hard blocker unless `BYBIT_CERTIFY_ALLOW_EXISTING_EXPOSURE=true`.
- The runner computes one of: `CERTIFIED`, `PARTIALLY_CERTIFIED`, `FAILED`, `BLOCKED_EXTERNAL_CONFIGURATION`, `BLOCKED_ACCOUNT_PERMISSION`, `BLOCKED_VENUE_LIMITATION`, or `BLOCKED_RUNTIME_DEFECT`.

Current status:

- Bybit remains `PARTIAL / BLOCKED FOR LIVE CERTIFICATION` in this local environment.
- The code path is ready once Vercel env, Supabase service-role access, a real allowlisted Bybit account, and the supervised private-stream worker are configured.
- Production certification still requires real runtime evidence, not only a passing build.
