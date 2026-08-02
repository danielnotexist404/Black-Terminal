# Broker Adapter Contract

Persistent providers implement the lifecycle declared by
`server/cloud-execution/adapters/exchange-adapter.js`:

```text
verifyCredentials  connect  disconnect  synchronizeAccount
placeOrder  modifyOrder  cancelOrder  cancelAll
fetchOpenOrders  fetchPositions  fetchBalances  fetchExecutions
subscribeAccountEvents  getHealth
```

Provider payloads are normalized at the adapter boundary. UI, strategies, OMS, EMS, Investment
Groups, and copy-trade fan-out may not call provider SDKs directly. A provider without this contract
is not a persistent Black Cloud provider, regardless of whether it has public market data or an
interactive wallet card.

## Registration and failure behavior

`createCloudExchangeAdapter` returns only registered adapters. Unsupported or rollout-disabled
providers raise typed errors; they are never ignored and never downgraded to a generic connected
state. Bybit is the only registered Chapter II-B persistent adapter. Hyperliquid remains a separate
server request relay until it implements this complete lifecycle.

## Required certification evidence

An adapter is not certified by unit tests alone. It needs broker-environment evidence for credential
permissions, initial snapshot, private stream, reconnect, duplicate/out-of-order events, ambiguous
submission recovery, partial fills, cancellation/modification, protection, account modes, rate
limits, clock skew, revocation, and worker failover.
