# Broker and Protocol Certification Matrix

This matrix describes repository capability, not what a provider API could support in theory. `No`
under certification means no recorded Chapter II-B external test evidence exists.

| Provider | Interactive | Persistent | Market data | Account data | Manual trading | Automated trading | Browser-independent | Testnet certified | Mainnet certified | Current state / limitation |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Bybit | Yes | Code present | Yes | Yes | Gated | Gated | Worker design: yes | No | No | PERSISTENT CAPABLE — NOT CERTIFIED; only registered persistent adapter |
| Hyperliquid | MetaMask | No | Yes | Relay snapshot | Gated relay | No persistent runtime | Requests only | No | No | REQUEST RELAY — NOT PERSISTENT; agent onboarding is not common mandate/worker lifecycle |
| MetaMask | Yes | No | N/A | Address/chain only | User-signed only | No | No | N/A | No | FULLY FUNCTIONAL — INTERACTIVE ONLY |
| Phantom | Yes | No | N/A | Address only | User-signed only | No | No | N/A | No | FULLY FUNCTIONAL — INTERACTIVE ONLY |
| Binance | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| OKX | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Bitget | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Coinbase Advanced | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Kraken | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Bitfinex | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Bitstamp | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Deribit | No | No | Yes | No | No | No | No | No | No | READ ONLY — options market data only |
| KuCoin | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Gate.io | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| MEXC | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| BitMEX | No | No | Yes | No | No | No | No | No | No | READ ONLY — public market data |
| Uniswap | MetaMask signer | No | No certified adapter | No | No | No | No | No | No | Interactive signer placeholder |
| Jupiter | Phantom signer | No | No certified adapter | No | No | No | No | No | No | Interactive signer placeholder |
| Raydium | Phantom signer | No | No certified adapter | No | No | No | No | No | No | Interactive signer placeholder |
| PancakeSwap | MetaMask signer | No | No certified adapter | No | No | No | No | No | No | Interactive signer placeholder |
| GMX / dYdX / Vertex / Drift | No | No | No registered adapter | No | No | No | No | No | No | UNSUPPORTED / deferred and hidden |
| WalletConnect | No | No | N/A | No | No | No | No | N/A | No | UNSUPPORTED / deferred and hidden |
| FIX / IBKR / Tradovate / Rithmic / CQG / Prime Broker | No | No | No | No | No | No | No | No | No | UNSUPPORTED institutional boundaries |

## Official implementation references reviewed

- Bybit: https://bybit-exchange.github.io/docs/v5/guide
- Hyperliquid: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- MetaMask: https://docs.metamask.io/metamask-connect/evm/guides/manage-user-accounts/
- Phantom: https://docs.phantom.com/solana/establishing-a-connection
- Binance: https://developers.binance.com/en/docs/products/spot/rest-api
- OKX: https://app.okx.com/docs-v5/en/
- Bitget: https://www.bitget.com/api-doc/classic/quickStart/intro
- Coinbase: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket
- Kraken: https://docs.kraken.com/api/docs/rest-api/get-api-key-info
- Bitfinex: https://docs.bitfinex.com/docs/ws-auth
- Bitstamp: https://www.bitstamp.net/api/
- Deribit: https://docs.deribit.com/articles/notifications
- KuCoin: https://www.kucoin.com/docs-new/authentication
- Gate.io: https://www.gate.com/docs/developers/apiv4/en/
- MEXC: https://mexcdevelop.github.io/apidocs/contract_v1_en/
- BitMEX: https://www.bitmex.com/app/apiKeysUsage

## Promotion rule

A provider may move to `FULLY PERSISTENT` only after a normalized adapter exists, no-withdrawal
permission validation is implemented, the v2 vault and mandate are used, private streams and full
reconciliation run in the worker, and the browser-independent test matrix is recorded. Public API
documentation or an interactive connection is not certification.
