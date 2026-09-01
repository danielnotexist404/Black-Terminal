# Black Core Strategy Automation Engine

Black Core strategy automation is server-authoritative. Definitions are evaluated on closed candles by a leased VPS signal worker. Paper execution remains available, while authenticated Bybit Demo and separately enabled Mainnet targets emit durable, idempotent commands to environment-isolated broker workers. Immutable version records, Paper accounts, target policies, audit events and runtime checkpoints remain in PostgreSQL.

The My Strategy UX binds active indicator instances and confirmed alert manifests to a mutable draft and activates only certified private definitions. `running_version` is the only definition the worker may execute. Eligible owned Black Script v3 strategies are independently recompiled from a pinned immutable source by the worker; browser certification metadata is never sufficient authority. The runtime and all per-target command manifests cross one fenced PostgreSQL transaction before an execution worker can claim them.

Black Script v3 direct execution is currently limited to Bybit futures and `pyramiding=1`. Partial trailing exits, custom-script Spot execution and custom-script Investment Group fanout are rejected before broker submission. Demo and Mainnet remain separate execution environments, and Mainnet still requires its explicit deployment switches and target arming.

Operational and recovery details remain in `docs/connectivity/STRATEGY_RUNTIME_RECOVERY.md` and the VPS operations handoff.
