# Group positions panel

The positions panel reads `position_lifecycle_positions` rows attributed by group, membership and mandate. Black Cloud reconciliation writes group origin, quantity, prices, realized/unrealized PnL, fees, funding and freshness into that canonical PositionManager ledger.

The cockpit table shows symbol, side, quantity, entry/mark, notional, leverage, margin mode, realized/unrealized PnL, fees/funding and lifecycle state. Data is never synthesized. Empty or stale sources are labeled.

Member exit/removal does not discard positions. Detach clears manager attribution/control and changes the origin back to member-managed while preserving the position record. Any requested close must be expressed as a reduce-only OMS/EMS flow, never as a direct client-to-broker request.
