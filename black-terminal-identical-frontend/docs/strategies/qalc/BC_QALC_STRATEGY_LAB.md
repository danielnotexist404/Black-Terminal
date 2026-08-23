# BC-QALC Strategy Lab

BC-QALC has two linked product surfaces:

- The Indicators library loads `BC-QALC — Queue-Aware Liquidity Capture` on the chart. It renders only canonical VPS event-time candidates, quotes, cancellations, conservative Paper fills, entries and exits. It never derives markers from candle direction.
- Strategy Lab provides configuration, Paper certification and runtime operations. `OPEN THIS CONFIGURATION IN STRATEGY LAB` transfers the exact chart settings through a versioned, integrity-checked configuration hash.

Its eight-step setup is Market, Data Quality, Feature Model, Quote Policy, Inventory Exit, Risk, Paper Latency and Review. The form exposes bounded operational controls rather than hundreds of raw coefficients.

The cockpit shows runtime/book/trade/clock health, direction, move, gross/net cost fields, fill probability, toxicity, quote age, queue ahead, inventory and drawdown. Compact sparklines cover QI, microprice edge, OFI, real CVD impulse, replenishment and toxicity.

Configurations are private. “Save Paper Configuration” does not publish, connect a broker or submit an order. Start remains disabled until event-replay certification and a safe VPS clock exist.

The Review step records the chart configuration hash and schema version so an operator can prove which indicator configuration was used for a saved Paper candidate.
