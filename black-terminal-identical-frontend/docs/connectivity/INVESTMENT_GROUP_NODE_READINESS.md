# Investment Group Node Readiness

Broad live Investment Group execution is not enabled by Chapter II-D. Node readiness is an infrastructure certification using fixtures, mocks or controlled Demo connections.

Required isolated model:

- one leader strategy;
- two follower connection records, never one shared group broker connection;
- two tenant/environment-bound encrypted credential envelopes;
- two independent signed mandates and risk decisions;
- connection-specific leases/fencing generations;
- two durable execution streams and position states;
- separately auditable client/broker order identities.

Fixture tests must prove that one follower failure or revocation does not stop the other, managers cannot read follower secrets, plaintext credentials are never shared, equity-percentage allocation creates separate follower plans, duplicate delivery remains idempotent, and one reconnect storm cannot monopolize the event loop.

Production readiness additionally requires measured node capacity for connections, strategies, event rate, intent rate and reconciliation load. Until the real VPS workload is measured, capacity is `UNKNOWN`. Hyperliquid persistent delegation, MetaMask persistent execution and Phantom persistent execution remain unsupported and must not be routed through the Bybit worker.
