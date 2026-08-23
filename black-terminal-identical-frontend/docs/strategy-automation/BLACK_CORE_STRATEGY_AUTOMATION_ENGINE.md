# Black Core Strategy Automation Engine

Black Core strategy automation is server-authoritative. Definitions are evaluated on closed candles by a leased VPS signal worker. Paper execution remains available, while authenticated Bybit Demo targets can emit durable, idempotent commands to a separately fenced Demo broker worker. Immutable version records, Paper accounts, target policies, audit events and runtime checkpoints remain in PostgreSQL.

The My Strategy UX binds active indicator instances and confirmed alert manifests to a mutable draft and activates only certified private definitions. `running_version` is the only definition the worker may execute. Bybit Demo uses simulated funds and Mainnet public market data; Testnet and automated real-funds Mainnet execution remain outside this boundary. Investment Group execution is independently gated.

Operational and recovery details remain in `docs/connectivity/STRATEGY_RUNTIME_RECOVERY.md` and the VPS operations handoff.
