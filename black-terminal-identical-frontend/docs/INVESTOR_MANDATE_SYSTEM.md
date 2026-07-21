# Investor Mandate System

An investor keeps ownership of a personal broker connection and separately grants a bounded Investment Group execution mandate. Membership alone never grants trading authority.

Mandates require the exact consent phrase `AUTHORIZE OFFLINE GROUP EXECUTION` and bind:

- follower, group and broker connection;
- cloud or hybrid execution mode;
- percentage-equity, available-margin percentage or fixed-notional allocation;
- maximum order notional, total exposure, daily loss, drawdown and leverage;
- allowed symbols, market types and order types;
- overnight/weekend, reduce-only, reversal and protective-order policy;
- expiration and slippage limits.

Material changes are versioned with a canonical hash and consent evidence. `PENDING_CONSENT`, `ACTIVE`, `PAUSED`, `EXPIRED` and `REVOKED` are enforced server-side. Pause or emergency stop blocks new orders immediately. Resume does not silently reactivate mandates; the investor must explicitly restore authority.

Before every follower order the worker verifies mandate state, connection health/control state, broker capabilities, withdrawal prohibition, symbol/product/order scope, leverage, venue minimums, margin, exposure, daily loss, drawdown and intent validity. Rejection is persisted on the follower plan and audited.
