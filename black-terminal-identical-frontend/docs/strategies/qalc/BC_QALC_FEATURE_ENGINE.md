# BC-QALC Feature Engine

For depth `n`, queue imbalance is:

`QI_n = (Σ bidQty_n - Σ askQty_n) / (Σ bidQty_n + Σ askQty_n)`

Microprice is:

`microprice = (bestBid × bestAskQty + bestAsk × bestBidQty) / (bestBidQty + bestAskQty)`

Limit OFI signs bid additions positive, bid removals negative, ask additions negative and ask removals positive. Trade OFI/CVD uses Bybit aggressor side: taker buy positive and taker sell negative. Both base and notional CVD are maintained over 250 ms through 30 seconds.

The engine also computes realized log-return dispersion, cancellation/add ratios, bid/ask replenishment, recovery time after best-level damage, depth slope/convexity/asymmetry, liquidity gaps, multi-level sweep state, flow efficiency, delta impulse and acceleration.

Rolling cumulative sums plus binary time lookup bound calculation cost without candle aggregation.
