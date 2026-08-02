# Broker Automation Mandates

An automation mandate is explicit, revocable permission for Black Cloud to operate after the user
closes or logs out of Black Terminal. It is not a browser session and it is not a broker credential.

## Consent and scope

Activation requires the exact confirmation `ENABLE OFFLINE CLOUD EXECUTION`. The UI presents the
broker, account, read/trade/cancel/modify scope, strategy/copy/group permissions, risk caps, duration,
protective-order policy, and permanent withdrawal prohibition.

The mandate stores:

- tenant, connection, broker, and redacted account reference;
- read, trade, cancel, modify, strategy, copy, and Investment Group booleans;
- order-notional, position-notional, leverage, and daily-loss bounds;
- allowed strategies and symbols;
- expiry, status, policy/security versions, consent evidence, canonical hash, and service signature.

`black_cloud_activate_automation_mandate` rotates the active mandate, writes the immutable version,
and appends the authorization audit event in one database transaction. An advisory lock prevents two
concurrent activations from creating competing versions.

## Enforcement

The worker loads an active, unexpired mandate for every operation and validates the requested scope.
Group execution additionally requires `allow_investment_group_execution`. Broker credentials with
withdrawal permission are rejected before mandate creation, and the database enforces
`allow_withdrawals = false`.

Revocation blocks new execution and causes the supervisor to stop the private session on its next
refresh. Protection is preserved by default; revoking authority is not silently treated as cancel-all.
