# Group analytics

Latest member snapshots roll into a group aggregate, with historical data retained at a coarser cadence rather than per market tick.

- Gross PnL = realized PnL + unrealized PnL before fees and funding.
- Net PnL = gross PnL - fees - funding costs.
- Gross exposure = sum of absolute long and short notionals.
- Net exposure = signed long exposure minus short exposure.
- Weighted leverage = allocated-equity-weighted effective leverage.
- Margin utilization = total used margin divided by connected equity.
- Group drawdown = maximum current/maximum member drawdown available in the authorized snapshot set.

Missing drawdown stays unavailable rather than becoming zero. Stale and degraded member counts remain visible and are never presented as live.

Synthetic aggregate-calculation results (local Node runtime, 2,000 iterations): 10 members p50 0.0071 ms/p95 0.0149 ms/p99 0.0619 ms; 100 members 0.0386/0.0579/0.1078 ms; 500 members 0.1853/0.2538/0.3343 ms. These numbers measure calculation only, not network, database, browser rendering or production capacity.
