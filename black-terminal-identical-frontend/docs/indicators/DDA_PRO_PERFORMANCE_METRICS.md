# DDA Pro performance metrics

Native metrics use causal log returns over the analysis window. Annual return is geometric: `expm1(meanLogReturn × barsPerYear)`. Population volatility is annualized by `sqrt(barsPerYear)`. The annual risk-free percentage is converted to a per-bar log rate before Sharpe and Sortino are calculated, keeping numerator and denominator in consistent units. Sortino uses only negative excess returns for downside semideviation. Calmar uses annual return divided by raw maximum drawdown depth. Ulcer Index is RMS depth; Pain Index is mean depth; recovery factor is net window return divided by MDD; Omega is gross positive returns divided by absolute gross negative returns.

Zero denominators return finite zero, never NaN or infinity.
