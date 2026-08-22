# Strategy Draft, Published and Running Versions

Forward migration `202608230001_my_strategy_draft_version_model.sql` adds mutable draft fields, `published_version`, and `running_version` without rewriting the original automation migration.

## Invariants

- Draft save increments `draft_revision` under an optimistic revision check.
- Draft save cannot create, pause, reset or restart a Paper runtime.
- Publish validates server certification and creates an immutable version plus a paused Paper account.
- Publish cannot change `running_version`.
- Start-version is explicit. It rejects a version switch while the previous Paper version has an open position, pauses the previous Paper account, activates the selected one, and resets worker lease state for that version.
- Empty live slots have no database rows.
- Existing non-draft strategies are backfilled so current Paper behavior continues. Existing draft rows remain unpublished and unstarted.

The worker reads `running_version`, loads its immutable definition, and writes its runtime heartbeat with that version. It never evaluates an unsaved draft.

All migration RPCs require service-role identity. Existing ownership, RLS, audit and immutable-version controls remain in force.
