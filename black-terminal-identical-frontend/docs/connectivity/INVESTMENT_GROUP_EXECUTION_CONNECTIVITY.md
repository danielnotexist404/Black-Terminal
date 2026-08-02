# Investment Group Execution Connectivity

Investment Groups consume the same Positions/Connection Manager records as single-account trading.
They may not store separate broker secrets or bypass OMS/EMS.

Each follower has an isolated broker connection, v2 credential envelope or delegated authority,
automation mandate, group execution mandate, risk policy, connection health, OMS orders, positions,
and audit trail. `investment_group_connection_assignments` binds a follower allocation to that
follower's connection and mandate; no shared investor credential exists.

Group signals expand into one deterministic child command per active follower. Allocation and EMS
risk evaluation happen independently. A disconnected or rejected follower does not roll back other
followers. Withdrawal scope is prohibited in both the broker automation and group mandate paths.

## Readiness boundary

Durable fan-out, allocation, lease/fencing, Bybit routing, and failure isolation foundations exist.
Investor-group mainnet fan-out remains disabled until single-account Bybit browser-independent
testnet certification succeeds and the per-follower connection assignment/control UI is completed.
