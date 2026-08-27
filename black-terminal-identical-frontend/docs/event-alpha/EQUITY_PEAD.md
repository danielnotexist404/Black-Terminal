# Event Alpha — Equity PEAD

Equity PEAD is a separate engine from Crypto Event Drift. A token unlock,
governance vote or protocol revenue observation is never labelled as an
earnings announcement.

## Required point-in-time evidence

The normalized provider endpoint must return a bounded JSON object with an
`events` array. Each event requires:

- exact announcement and first-actionable timestamps;
- pre-announcement consensus timestamp, EPS, revenue and contributor count;
- verified EPS and revenue actuals;
- historical forecast errors known at the cutoff;
- chronological adjusted stock, broad-market and sector return increments;
- beta, sector beta, costs, confidence and HTTPS provenance URLs.

Optional guidance and margin evidence contributes only when both actual and
consensus values are present. Missing required evidence fails closed.

## Model

`SUE = (actual - consensus) / robust historical forecast-error scale`

`AR[t] = stock_return[t] - beta * market_return[t] - sector_beta * sector_return[t]`

`CAR[a,b] = sum(AR[t], t=a..b)`

The engine maps the weighted standardized surprise to a bounded expected drift,
then subtracts observed CAR and round-trip costs. Output states are
`POSITIVE_DRIFT`, `NEGATIVE_DRIFT`, `FULLY_PRICED`, `OVERREACTION`, and
`NO_TRADE`. These are research classifications and have no direct broker
authority.

## Provider configuration

Configure only on the server:

- `EVENT_ALPHA_EQUITY_PEAD_ENABLED=true`
- `EVENT_ALPHA_PEAD_FEED_URL=https://...`
- `EVENT_ALPHA_PEAD_ALLOWED_HOST=...`
- `EVENT_ALPHA_PEAD_FEED_TOKEN=...`

The host is exact-allowlisted and must be public HTTPS. The token is sent only
by the worker and is never persisted, logged or returned to the browser.

SEC EDGAR is suitable for filing facts and exact filing timestamps, but it does
not provide a point-in-time analyst consensus or the adjusted factor return
path. Therefore an SEC-only event cannot be upgraded into a directional PEAD
signal.
