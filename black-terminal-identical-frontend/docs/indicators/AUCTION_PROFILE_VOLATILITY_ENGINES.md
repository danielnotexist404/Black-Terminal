# Auction Profile Volatility Engines

The native engine includes:

- realized variance from log close returns;
- Parkinson variance from high/low range;
- Garman-Klass variance from open/high/low/close;
- range expansion;
- a hybrid normalized score.

Bar variance is distributed only across rows visited by the bar and remains labeled bar-derived. Annualization is presentation/configuration dependent and does not change raw stored variance. These estimators describe historical dispersion; they are not forecasts.
