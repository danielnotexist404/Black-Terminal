# DDA Pro annualization

Native defaults to 365.25 calendar days for Black Terminal’s 24/7 crypto instruments and converts that day count into bars per year from the actual timeframe seconds without integer rounding. Traditional mode resolves 252 days through the timeframe. Custom mode accepts an explicit positive periods-per-year value. The annual risk-free percentage is converted with `log1p(rate) / barsPerYear` before it is compared with per-bar log returns.

Compatibility mode fixes annualization at 252 to retain the Pine assumption. External US10Y acquisition is not claimed in this chapter; fixed annual rate is the active supported source.
