# Phase III Chapter V - Hyperliquid Server-Side Execution Relay

Status: route foundation implemented; requires Supabase migration and testnet validation before live use.

## Objective

Hyperliquid execution is now treated as the first protocol relay behind Black Core:

```text
Unified Execution Ticket
-> OMS
-> EMS
-> Risk
-> Protocol Router
-> Hyperliquid Relay
-> Hyperliquid /exchange
-> normalized execution report
-> OMS / Position Manager / chart / audit
```

The browser submits normalized execution intent only. Private agent-wallet signing happens server-side.

## Account Model

- Master wallet: connected with MetaMask and used as the Hyperliquid account owner.
- Agent/API wallet: approved by the master wallet and used by the backend relay to sign `/exchange` actions.
- Reads: account state sync reads the master wallet, not the agent wallet.
- Secrets: agent private keys are encrypted with `HYPERLIQUID_CREDENTIAL_ENCRYPTION_KEY` and never returned to the frontend.

## Backend Routes

- `POST /api/protocols/hyperliquid/connect`
- `POST /api/protocols/hyperliquid/order`
- `POST /api/protocols/hyperliquid/cancel`
- `POST /api/protocols/hyperliquid/modify`
- `POST /api/protocols/hyperliquid/close-position`
- `POST /api/protocols/hyperliquid/sync`

All order routes return a Black Terminal normalized execution report. Sync returns balances, positions, open orders, fills, and an `externalStateChanged` flag.

## Readiness

`executionReady = true` only when:

- MetaMask/master wallet is connected.
- Agent credential is encrypted and stored server-side.
- Agent authorization validates against Hyperliquid.
- Metadata loads from Hyperliquid.
- Nonce RPC succeeds.
- Relay environment is enabled.
- Network is selected.

Otherwise `executionReady = false` and `readinessReason` is shown in the ticket and dock.

## Environment

Required:

```bash
HYPERLIQUID_RELAY_ENABLED=true
HYPERLIQUID_CREDENTIAL_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

Optional:

```bash
HYPERLIQUID_NETWORK=testnet
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
HYPERLIQUID_TESTNET_API_URL=https://api.hyperliquid-testnet.xyz
HYPERLIQUID_HTTP_TIMEOUT_MS=10000
HYPERLIQUID_MAINNET_ENABLED=false
```

Mainnet fails closed unless `HYPERLIQUID_MAINNET_ENABLED=true` and the user explicitly confirms mainnet in the UI.

## Current Coverage

Implemented:

- Testnet/mainnet network selection.
- Agent credential storage boundary.
- Atomic nonce RPC contract.
- Metadata-based asset resolution.
- Market and limit orders.
- Reduce-only orders.
- Post-only via ALO.
- IOC/GTC mapping.
- Stop-market and stop-limit trigger orders with TP/SL grouping.
- Cancel by exchange order id or client id.
- Modify order.
- Close position via reduce-only order.
- Account sync for margin, positions, open orders, and fills.

Explicitly blocked:

- TWAP
- Iceberg
- Bracket as a synthetic managed strategy
- Live trailing stop without a monitoring worker

## Supabase

Apply the Chapter V migration in `SUPABASE_MIGRATIONS.md` before using the relay. The relay will fail closed if the nonce RPC or credential table is missing.

## Validation

Required before enabling mainnet:

- Apply migration.
- Configure env vars.
- Approve an agent/API wallet on Hyperliquid testnet.
- Connect MetaMask and store the agent credential through Positions.
- Submit testnet market and limit orders.
- Cancel and modify testnet orders.
- Close a testnet position.
- Sync account state and verify positions/orders/fills update.
- Confirm `npm run build` passes.
