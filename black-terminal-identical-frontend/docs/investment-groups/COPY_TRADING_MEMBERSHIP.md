# Copy Trading membership

Operational states are `DRAFT`, `RISK_ACCEPTED`, `METHOD_SELECTED`, `CONFIGURING`, `PENDING_APPROVAL`, `APPROVED`, `ACTIVATING`, `ACTIVE`, the pause/suspension states, and terminal exit/removal states.

Activation requires an approved membership, current disclosure acceptance, valid signed mandate, eligible reconciled broker connection and a ready Black Cloud node. One active/paused/exit-only group authority is allowed per broker account. Every member keeps a separate encrypted connection, mandate version, risk decision, follower plan, position attribution and audit history.

User pause immediately blocks new entry. Only the user can resume a user pause. Manager pause is separately labeled and reversible by authorized group management. Existing broker-native protective orders remain active.
