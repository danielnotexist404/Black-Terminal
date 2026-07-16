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

## Runtime-Scoped Private Data

Persisted Supabase account records are not runtime connections. Portfolio snapshot polling is scoped exclusively to account IDs currently owned by Black Core Connection Manager.

- With zero active runtime account IDs, the client returns an empty portfolio snapshot without calling the private portfolio API.
- Snapshot requests include only active account IDs; the server filters the authenticated user's account query before any venue synchronization occurs.
- Canonical order ingestion rejects orders belonging to accounts outside the authoritative runtime set.
- Chart overlays, Positions and Portfolio Manager apply a final connected-account filter, preventing delayed responses from drawing stale private state after disconnect.

Public Bybit market data remains independent and can continue driving charts and DOM. Private balances, positions and orders exist in the UI only while their broker connection is active.
