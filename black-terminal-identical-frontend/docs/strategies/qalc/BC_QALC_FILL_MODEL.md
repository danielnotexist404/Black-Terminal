# BC-QALC Fill Model

The model estimates fill intensity from observed opposing aggressor flow, conservative same-side cancellation credit and replenishment ahead:

`effectiveQueue = queueAhead + 0.5 × sameSideReplenishment`

`intensity = (opposingTradeFlow + 0.25 × cancellationRate × effectiveQueue) / effectiveQueue`

`P(fill by t) = clamp(1 - exp(-intensity × t), 0, 0.98)`

Paper matching is stricter than the probability estimate. A quote must be acknowledged first. Only a real opposing taker trade reaching the quote price consumes queue-ahead. Remaining trade quantity may create a partial fill. Price touch, crossed display, future flow and candle high/low never create a fill.

Baseline coefficients are priors pending event-replay calibration; they are not presented as trained probabilities.
