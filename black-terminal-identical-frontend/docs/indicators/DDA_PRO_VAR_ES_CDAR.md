# DDA Pro VaR, ES, DaR, and CDaR

Native return VaR95 is the non-negative loss at the 5th percentile of log returns. Expected Shortfall95 is the non-negative mean loss of returns at or below that threshold. Drawdown-at-Risk95 is P95 of positive raw drawdown depth. Conditional Drawdown-at-Risk95 is the mean depth at or beyond DaR95.

Thus ES and CDaR describe different domains. In Compatibility mode the source’s smoothed-drawdown P5 and P1…P5 approximation remain legacy semantics and are explicitly not promoted as mathematically corrected return VaR/ES.
