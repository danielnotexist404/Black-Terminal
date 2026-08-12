# Copy Trading mandate

The mandate contains the selected connection, equity allocation percentage, user leverage ceiling, manager requested leverage, group/instrument/EMS constraints, exposure/loss/drawdown ceilings, symbols, markets, directions, order types, margin mode, slippage, exit policy and portfolio visibility.

Effective leverage is `min(manager requested, user maximum, group maximum, EMS cap, instrument cap)`.

The manager can request a lower value but cannot exceed the member-signed cap. Updates use optimistic policy versions and record previous/new versions and correlation ID. A fresh membership/mandate read occurs immediately before broker submission to fence stale workers.

Mandates explicitly set withdrawal and asset-transfer authority to `false`. Broker credentials remain in the encrypted connectivity boundary; managers see only operational health and authorized portfolio data.
