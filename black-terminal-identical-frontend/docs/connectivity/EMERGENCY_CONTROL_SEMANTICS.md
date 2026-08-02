# Emergency Control Semantics

| Action | New entries | Monitoring/reconciliation | Existing protection | Authority/session |
|---|---|---|---|---|
| Pause New Entries | Blocked | Continues | Preserved | Mandate active |
| Stop Strategy | Selected deployment stopped | Continues | Preserved | Connection active |
| Cancel Working Entry Orders | Blocked only if separately paused | Continues | Preserved | Connection active |
| Cancel All Orders | Unchanged | Continues | Preserved unless explicitly included | Connection active |
| Close Strategy Positions | Refused until attribution is complete | Continues | Preserved | Connection active |
| Revoke Automation Mandate | Blocked | Worker session stops | Broker-native protection preserved | Mandate revoked |
| Disconnect Broker | Blocked | Stops | Broker-native state untouched | Connection disabled |
| Emergency Account Lock | Blocked | Continues while worker can monitor | Preserved | Mandates paused |

Every successful action writes immutable execution and connection audit events. `Cancel All Orders`
requires an explicit `cancelProtectiveOrders=true` to include protection. `Close Strategy Positions`
currently fails with `STRATEGY_POSITION_ATTRIBUTION_REQUIRED`; this is intentional because closing
all account positions could liquidate unrelated manual positions.

`Stop Automations and Log Out` pauses new entries on each active cloud connection, preserves
protection, and logs out only after the control requests succeed. Ordinary logout does not change
mandates or worker sessions.
