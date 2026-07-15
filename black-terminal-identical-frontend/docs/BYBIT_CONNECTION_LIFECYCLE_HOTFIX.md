# Bybit Connection Lifecycle Hotfix

## Production evidence

Repeated connection attempts had created multiple `exchange_accounts` rows for one Bybit API identity. Each row synchronized the same venue order under a different local account ID. Disconnect removed only the browser connection because the centralized-exchange adapter's disconnect method was empty. The server accounts and Black Core orders therefore survived.

## Corrections

- Bybit reconciliation derives canonical connection identity from the venue user ID, with a protected API-key fingerprint fallback.
- Portfolio snapshots collapse legacy duplicate account rows before balances, positions and orders are synchronized or totaled.
- New connections use a deterministic credential reference and update the existing account instead of inserting another row.
- Disconnect calls the authenticated account-delete route and removes all legacy rows carrying the same encrypted API identity.
- Black Core immediately removes the exchange's order state, then reconciles against the authoritative server account list.
- An authoritative empty account list clears retained rows and chart lines.
- Sign-out clears all in-memory connections, heartbeats, active venue selection, positions and canonical orders without deleting the user's saved server connection.

No credential material or fingerprint is returned to the browser.

