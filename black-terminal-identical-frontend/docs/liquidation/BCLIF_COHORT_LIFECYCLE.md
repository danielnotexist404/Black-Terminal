# BCLIF Cohort Lifecycle

States are `FORMING`, `ACTIVE`, `REDUCING`, `PARTIALLY_LIQUIDATED`, `LIKELY_CLOSED`, `LIQUIDATED`, `EXPIRED`, and `INVALIDATED`.

Allowed transitions are caused by:

- material OI contraction;
- deterministic voluntary-closure allocation;
- observed liquidation assimilation;
- unresolved price traversal when event coverage is absent;
- explicit causal decay/expiry;
- bounded-state expiry with ledger accounting.

`BCLIF_DETERMINISTIC_CLOSURE_ALLOCATION_V1` ranks existing same-side cohorts using age, distance from mark, profitability context, and survival weakness. It allocates closure mass deterministically and never creates a new shelf or silently deletes the newest cohort.

Observed liquidation matching uses side, event price, cohort mean/deviation, time availability, and remaining notional. It records the observed evidence ID, removed mass, price-error reason, and posterior update without moving the historical shelf.

When price traverses a predicted range but confirmed-event coverage is missing, a conservative partial transition lowers mass/confidence and records `UNRESOLVED_TRAVERSAL`; it neither assumes full survival nor fabricates an observed liquidation.

Active cohorts are bounded to 320, particles to 24,576, and lifecycle events to 4,096. Any capacity expiry is explicit in the mass ledger.
