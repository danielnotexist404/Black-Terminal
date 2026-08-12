# My Investment Group cockpit

The cockpit is returned only to group owners or authorized managers. It contains group health/emergency state, one bounded aggregate stream, member directory, member drawer, attributed positions, analytics, execution quality and separate Copy Trading/Obsidian sections.

Member controls include approve/reject, requested leverage within the signed cap, manager pause and audited removal. Sensitive controls are confirmed and server-authorized. The UI presents explicit `LOADING`, no-member, no-position, stale/degraded, no-consent and Obsidian-research states instead of fabricated metrics.

The Execution tab opens the canonical Group Execution Ticket. Its confirmed submission creates one idempotent, signed `group_trade_intents` record through the protected Black Cloud API. MARKET, LIMIT, TWAP and ICEBERG parameters remain server-side inputs; OMS/EMS creates independent follower plans, applies the lower member/group/EMS/instrument leverage and slippage caps, and never fans orders out from the browser.

The cockpit reads canonical snapshots rather than starting one polling loop per member. Current web refresh is a single group-level five-second refresh; positions/orders remain represented by server-owned canonical state.
