# Bybit Browser-Offline Certification

Status: `NOT EXECUTED`. This procedure requires the real VPS, a user-selected Bybit Demo or Mainnet Live connection, and explicit authorization for every external order action. Deployment alone is not consent.

## Preconditions

- `BLACK_CLOUD_NODE_01` is fresh and `READY`.
- The connection is environment-bound, private-stream authenticated, subscribed and reconciled.
- The current connection lease and fencing generation are recorded.
- A signed automation mandate is active and limited to the selected account/symbol/strategy.
- The operator selects the order size; OMS/EMS validates current venue constraints and configured risk policy.
- Mainnet requires the separate Mainnet activation gate.
- Broker-native protection is prepared before any position can remain open.

## Evidence sequence

Record UTC timestamps for node heartbeat, strategy deployment/version, last processed market event, durable intent creation, EMS risk approval, queue claim, fencing check, broker acknowledgement, private order event, execution event, position sync, protection confirmation and exit.

Then close the browser tab, terminate the browser, log out, and disconnect the user's workstation. Observe only from the VPS/Supabase operational plane. Prove the VPS continues evaluation and that any authorized intent uses the same OMS → EMS → durable queue → fenced worker → Bybit path. Reconnect the UI and reconstruct the entire lifecycle from durable state.

## Pass conditions

- No browser/workstation process is required.
- Logout does not revoke an intentionally persistent mandate.
- No duplicate signal, intent, client order ID or broker order appears.
- Private events and reconciliation confirm the venue state.
- Broker-native protection remains installed.
- Standard logout text states that active Black Cloud automations continue.

## Safety

Do not insert artificial production signals. A clearly labeled operator-controlled certification trigger is acceptable only if it uses the full strategy/OMS/EMS path and disables itself after completion. If the current strategy runtime is not actually deployed, mark browser-offline strategy execution `BLOCKED`; do not substitute a manual queue write and call it strategy certification.
