# DDA Pro Native mathematics

For positive source value `V_t` and causal peak `P_t`, raw drawdown is `DD_t = min(0, (V_t/P_t - 1) × 100)` and positive depth is `D_t = -DD_t`. `P_t` is either the maximum of all loaded history through `t`, or the maximum of the selected rolling window. Only raw drawdown/depth feed professional risk metrics; smoothing is a visual wave.

Velocity is `D_t-D_(t-1)` and acceleration is its first difference. VADD is drawdown depth divided by rolling annualized log-return volatility in percent, bounded below by the configurable volatility floor. Every rolling input uses only data at or before `t`.
