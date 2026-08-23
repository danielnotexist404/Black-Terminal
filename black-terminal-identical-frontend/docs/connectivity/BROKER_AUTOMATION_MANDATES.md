# Broker Automation Mandates

An automation mandate is explicit, revocable permission for Black Cloud to operate after the user
closes or logs out of Black Terminal. It is not a browser session and it is not a broker credential.

## Consent and scope

Strategy Lab activation is private and does not use a blocking phrase prompt. The authenticated API
creates server-signed consent evidence only after a Bybit Demo Trading account has been verified and
the user selects **Activate Strategy & Save Configuration**. This path is locked to the official Demo
execution environment (`api-demo.bybit.com`) with Mainnet public market data. It cannot authorize a
real-funds Mainnet account, copy trading, Investment Group execution, withdrawals, or transfers.

The mandate stores:

- tenant, connection, broker, and redacted account reference;
- read, trade, cancel, modify, and strategy permissions; copy and Investment Group permissions remain false;
- order-notional, position-notional, leverage, and daily-loss bounds;
- allowed strategies and symbols;
- expiry, status, policy/security versions, consent evidence, canonical hash, and service signature.

`black_cloud_activate_automation_mandate_v2` rotates the active Demo mandate, writes the immutable version,
and appends the authorization audit event in one database transaction. An advisory lock prevents two
concurrent activations from creating competing versions.

## Enforcement

The Strategy Lab worker loads an active, unexpired mandate for every operation and validates the
requested scope. The route, database RPC, credential envelope, connection, account, mandate and
isolated worker must all agree on `DEMO`; any Mainnet or mixed-environment path fails closed. Broker
credentials with withdrawal or transfer permission are rejected before mandate creation, and the
database enforces `allow_withdrawals = false`.

Revocation blocks new execution and causes the supervisor to stop the private session on its next
refresh. Protection is preserved by default; revoking authority is not silently treated as cancel-all.
