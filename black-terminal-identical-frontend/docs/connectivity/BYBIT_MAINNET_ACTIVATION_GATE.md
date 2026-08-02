# Bybit Mainnet Activation Gate

Mainnet is real funds and real execution. The user chooses order size; Black Terminal applies the signed mandate, configured risk policy, current balance/margin, OMS/EMS validation, current Bybit instrument constraints and exchange risk rules. There is no arbitrary platform dollar ceiling and no silent resizing.

Certification states:

1. `INFRASTRUCTURE_READY`
2. `MANUAL_EXECUTION_VERIFIED`
3. `PRIVATE_EVENTS_VERIFIED`
4. `PROTECTION_VERIFIED`
5. `BROWSER_OFFLINE_VERIFIED`
6. `RESTART_RECOVERY_VERIFIED`
7. `FULLY_ACTIVATED`

`BLACK_CLOUD_MAINNET_ENABLED=true` only identifies the isolated live worker environment; it is not order consent. The frontend still requires `ENABLE LIVE BYBIT EXECUTION`, an environment-bound trade/read credential, matching Bybit UID, no withdrawal/transfer authority, and an active signed mandate. The first real order requires immediate explicit user confirmation.

Manual certification must use the real Black Terminal workflow: place and cancel a valid limit order, submit a user-approved market/marketable order, observe private order and execution events, synchronize the position, install and verify broker-native SL/TP, then reduce/close and reconcile final state.

Any failed or missing stage blocks progression. Do not use Testnet, do not silently switch Demo/Mainnet endpoints, do not manually insert credentials into Supabase, and do not mark `FULLY_ACTIVATED` from container health alone.
