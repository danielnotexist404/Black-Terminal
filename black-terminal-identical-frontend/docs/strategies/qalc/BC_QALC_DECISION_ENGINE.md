# BC-QALC Decision Engine

Direction, fill and adverse selection are separate functions. The signed direction baseline combines QI5/QI20, microprice edge, one-second combined OFI, three-second notional CVD and depth asymmetry through a logistic link.

One-sided policy:

- probability up ≥0.58: bid candidate;
- probability down ≥0.58: ask candidate;
- otherwise: no quote.

Two consecutive same-side observations are required. Then book, age, clock, warm-up, fees, risk, toxicity, fill probability, expected net edge and quote-action budgets are checked. The gross edge must exceed all-in cost by the configured multiplier (2× default).

Research/Replay/Shadow may emit candidates but cannot create Paper orders. Paper creation additionally requires explicit Paper mode and enablement.
