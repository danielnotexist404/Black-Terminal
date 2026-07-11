# Phase III Chapter XI - Universal Mainnet Connectivity

Date: 2026-07-11

Status: Foundation implemented. Venue truthfulness, certification registry, read-only/signer-only gating, and server fail-closed credential validation are active.

Chapter XI is not a promise that every exchange is fully live. It is the architecture that prevents Black Terminal from lying about venue support.

## What Changed

- Added a machine-readable venue certification registry: `src/connectivity/venueRegistry.ts`.
- Added normalized connection vocabulary for execution mode, network, and readiness.
- Positions connection cockpit now renders venue certification before connection.
- CEX credential connection is allowed only for certified credential adapters.
- Hyperliquid no longer appears as a CEX broker option; it belongs to the protocol/DEX path through MetaMask.
- MetaMask and Phantom remain signer-only unless paired with a protocol adapter.
- The frontend no longer falls back to local mock credential storage for real exchanges if server validation fails.
- Vercel `api/exchange-accounts/connect.js` rejects uncertified exchange credential attempts.

## Current Venue Support Matrix

| Venue | Category | Current Mode | Mainnet Certified | Status | Limitation |
| --- | --- | --- | --- | --- | --- |
| Hyperliquid | Protocol | Relay capable / execution-blocked until ready | No | Partial | Requires MetaMask, authorized agent wallet, relay env, nonce, metadata, risk, and Developer Mainnet Validation Mode. |
| MetaMask | Wallet | Signer-only | No | Signer-only | Does not execute futures alone. Defaults to Hyperliquid protocol flow in Positions. |
| Phantom | Wallet | Signer-only | No | Signer-only | Drift/Jupiter/Raydium protocol execution is not certified. |
| Bybit | CEX | Read-only | No | Partial | Mainnet credential validation and account snapshot sync only. Trading disabled until adapter certification. |
| Binance | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| OKX | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| Bitget | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| Coinbase Advanced | CEX | Market-data-only | No | Market-data-only | Spot account/execution adapter not certified. |
| Kraken | CEX | Market-data-only | No | Market-data-only | Spot account/execution adapter not certified. |
| Bitfinex | CEX | Market-data-only | No | Market-data-only | Spot account/execution adapter not certified. |
| Bitstamp | CEX | Market-data-only | No | Market-data-only | Spot account/execution adapter not certified. |
| Deribit | CEX | Market-data-only | No | Market-data-only | Options/futures auth and execution adapter not certified. |
| KuCoin | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| Gate.io | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| MEXC | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| BitMEX | CEX | Market-data-only | No | Market-data-only | Credential validation and live execution adapter not certified. |
| Uniswap | Protocol | Signer-only | No | Signer-only | Quote, approval, slippage, signing, and transaction status are not certified. |
| Jupiter | Protocol | Signer-only | No | Signer-only | Quote/sign/submit adapter not certified. |
| Raydium | Protocol | Signer-only | No | Signer-only | Swap adapter not certified. |
| PancakeSwap | Protocol | Signer-only | No | Signer-only | Quote/approval/swap adapter not certified. |
| GMX | Protocol | Unavailable | No | Deferred | Perpetual protocol adapter not implemented. |
| dYdX | Protocol | Unavailable | No | Deferred | Protocol signing and account-state adapter not implemented. |
| Vertex | Protocol | Unavailable | No | Deferred | Protocol signing and account-state adapter not implemented. |
| Drift | Protocol | Unavailable | No | Deferred | Phantom/Solana protocol adapter not implemented. |
| WalletConnect | Wallet | Unavailable | No | Deferred | Future signer boundary. |
| FIX / IBKR / Tradovate / Rithmic / CQG / Prime Broker | Institutional | Unavailable | No | Deferred | Institutional adapter boundary only. |

## Current Rules

- A connection can only show trading-ready when the adapter and dynamic connection report execution readiness.
- Public market data support does not imply account connectivity.
- Read-only account support does not imply order placement.
- Wallet signer support does not imply protocol execution.
- A venue with no certified credential adapter cannot store credentials.
- If secure server validation fails, real exchange credentials are rejected instead of stored locally.

## Mainnet Validation

Mainnet validation remains controlled by Chapter X:

- Off by default.
- Browser session opt-in required.
- Server env gate required.
- Order amount comes from the ticket.
- OMS, EMS, Risk, Router, Adapter, audit, and normalized report path remain mandatory.

Chapter XI adds the certification foundation that can later persist:

- adapter certification state
- venue metadata cache
- connection health snapshots
- mainnet validation records
- rate-limit and time-sync status

## Next Adapter Wave

Wave 1 should now be implemented one venue at a time:

1. Bybit read/write certification.
2. Binance credential validation and account sync.
3. OKX credential validation and account sync.
4. Bitget credential validation and account sync.
5. Coinbase Advanced spot account sync.

Do not mark any venue execution-ready until its real adapter supports account state, symbol metadata, precision validation, order submission, cancel, reconciliation, and audit through OMS/EMS/Risk.

## Validation

Command:

```bash
npm run build
```

Result:

- TypeScript passed.
- Vite production build passed.
- Existing chunk-size warning remains.
