# Hyperliquid Delegated Execution

MetaMask identity and persistent Hyperliquid execution are separate states. A browser wallet session
does not survive browser shutdown as an execution engine. Persistent automation must use an approved
Hyperliquid API/agent wallet bound to the correct master account or vault.

## Current implementation

Black Terminal can connect MetaMask interactively and can onboard an explicitly supplied
Hyperliquid agent key into the existing encrypted server relay. The relay validates master/agent
association, uses a durable nonce RPC, supports order/cancel/modify/close/sync routes, and applies
risk and mainnet gates. It never asks for the MetaMask seed phrase or master private key.

This is a server-side request relay, not yet a registered persistent adapter: it does not own a
continuous Hyperliquid user WebSocket through `BrokerConnectionManager`, does not use the common
automation mandate table, and has not passed worker-restart/browser-closed certification. Its UI
truth state is `REQUEST RELAY — NOT PERSISTENT`.

## Required next stage

1. Replace agent-key entry with an explicit `approveAgent` authorization ceremony.
2. Store the agent in the v2 envelope vault and issue a bounded automation mandate.
3. Implement the full persistent adapter contract and user WebSocket snapshots/reconnect.
4. Reconcile open orders, fills, positions, and nonce state before READY.
5. Implement delegation revocation and testnet certification.

Official references:

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
