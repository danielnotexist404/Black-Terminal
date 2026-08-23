# BC-QALC Strategy Lab

BC-QALC appears separately from generic indicator strategies under `Start From Template / Microstructure`.

Its eight-step setup is Market, Data Quality, Feature Model, Quote Policy, Inventory Exit, Risk, Paper Latency and Review. The form exposes bounded operational controls rather than hundreds of raw coefficients.

The cockpit shows runtime/book/trade/clock health, direction, move, gross/net cost fields, fill probability, toxicity, quote age, queue ahead, inventory and drawdown. Compact sparklines cover QI, microprice edge, OFI, real CVD impulse, replenishment and toxicity.

Configurations are private. “Save Paper Configuration” does not publish, connect a broker or submit an order. Start remains disabled until event-replay certification and a safe VPS clock exist.
