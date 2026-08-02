# Bybit Persistent Adapter

## Implemented surface

The Bybit adapter implements credential verification, UTA account/balance/position/open-order and
execution snapshots, private order/execution/position/wallet streams, request signing, receive
windows, mainnet/testnet isolation, market and limit orders, conditional inputs, reduce-only,
post-only, TP/SL, leverage/margin controls, modify, cancel, cancel-all, deterministic client IDs,
partial-fill processing, reconnect, and reconciliation.

Bybit order creation is asynchronous: a REST acknowledgement is not treated as a fill or definitive
state. Private order/execution events and REST reconciliation complete the OMS lifecycle. Duplicate
events are persisted by provider identity before application. An ambiguous transport failure queries
the deterministic client order ID before any retry.

Credential verification calls `/v5/user/query-api`, requires trading access, and rejects wallet
withdrawal permission. REST and private WebSocket destinations are constrained to the Bybit
mainnet/testnet allowlist.

Official references:

- https://bybit-exchange.github.io/docs/v5/guide
- https://bybit-exchange.github.io/docs/v5/user/apikey-info
- https://bybit-exchange.github.io/docs/v5/order/create-order
- https://bybit-exchange.github.io/docs/v5/websocket/private/order
- https://bybit-exchange.github.io/docs/v5/websocket/private/execution
- https://bybit-exchange.github.io/docs/v5/ws/connect

## Certification status

Code and local contracts are complete enough for testnet deployment, but no Chapter II-B external
worker run or browser-independent entry/protection/exit evidence is stored in this repository. State:
`PERSISTENT CAPABLE — NOT CERTIFIED`. Mainnet automation remains gated and must not be labelled
production-ready until the staged testnet and canary matrix is recorded.
