# Black Core Strategy Automation Engine

Black Core strategy automation is server-authoritative and Paper-only in the current certification stage. Definitions are evaluated on closed candles by a leased VPS worker. Immutable version records, Paper accounts, target policies, audit events and runtime checkpoints remain in PostgreSQL.

The My Strategy UX binds active indicator instances and confirmed alert manifests to a mutable draft, publishes only certified definitions, and starts a selected immutable version explicitly. `running_version` is the only definition the worker may execute. Live broker and Investment Group execution remain outside this certification boundary.

Operational and recovery details remain in `docs/connectivity/STRATEGY_RUNTIME_RECOVERY.md` and the VPS operations handoff.
