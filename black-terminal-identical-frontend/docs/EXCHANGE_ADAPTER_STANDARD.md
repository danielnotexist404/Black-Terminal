# Exchange Adapter Standard

All Black Cloud venue integrations implement the server-side `ExchangeAdapter` contract:

`connect`, `authenticate`, `getAccount`, `getPositions`, `getOrders`, `placeOrder`, `cancelOrder`, `modifyOrder`, `subscribeMarketData`, `subscribePrivateEvents`, and `reconcile`.

Adapters own authentication/signing, product naming, precision, venue status normalization, public/private transport and reconciliation translation. Control-plane, allocation and risk code use canonical models and must not contain browser or Black Core venue logic.

The registry currently exposes the Bybit adapter. Binance, OKX, Hyperliquid, Coinbase, Interactive Brokers and Tradovate require independent adapters and certification before registration. An adapter may advertise only capabilities demonstrated by its account permission discovery and certification evidence. Withdrawal-enabled credentials are never eligible.

New adapters must pass the broker contract, idempotency, permission, reconnect, snapshot reconciliation, ambiguous submission and emergency-control suites before production enablement.
