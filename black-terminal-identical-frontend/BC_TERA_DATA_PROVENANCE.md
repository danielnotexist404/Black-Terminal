# BC-TERA Data Provenance

Status: source inventory complete for Phase I. Historical research ingestion is not connected.

## Connected to BC-TERA now

| Family | Current source | Quality | Use |
|---|---|---:|---|
| Market candles | Existing selected Black Terminal market-data adapter, passed through `chartFeatureAdapter.ts` | `VERIFIED_PARTIAL` | Closed-bar return, realized volatility, causal trend/distance, structure break |
| Spot trades | Not connected to BC-TERA | `UNAVAILABLE` | No score |
| Spot order books | Not connected to BC-TERA | `UNAVAILABLE` | No score |
| Perpetual data | Not connected to BC-TERA | `UNAVAILABLE` | No score |
| Open interest/funding/basis | Not connected to BC-TERA | `UNAVAILABLE` | No score |
| Liquidations | Not connected to BC-TERA | `UNAVAILABLE` | No score |
| Options surface | No provider in the worktree | `UNAVAILABLE` | No score |
| On-chain metrics | No MVRV/SOPR/cost-basis provider in the worktree | `UNAVAILABLE` | No score |
| Stablecoin liquidity | No authoritative provider in the worktree | `UNAVAILABLE` | No score |

Current candle provenance records source name, venue, symbol, market type, event timestamp, source cutoff, received timestamp, sequence when available, revision identifier, and quality. The chart adapter uses seconds to match Black Chart candle timestamps and never labels a developing decision bucket as confirmed.

## Authentic repository sources available for later server-side adapters

The repository contains public market adapters for Binance, Bybit, OKX, Kraken, Coinbase, Hyperliquid, Bitfinex, and other supported venues under `src/market-data`. It also contains genuine aggressor-trade/CVD infrastructure in the auction-profile module and existing Bybit order-book, trades, open-interest, funding, liquidation, mark-price, ratio, and risk-tier collectors under `server/liquidation-intelligence/sources`.

Those sources are candidates for new BC-TERA-specific server normalization in Phase II. They are not silently borrowed from or coupled to RADAP/BCLIF in Phase I. Their existence must not be confused with current BC-TERA coverage.

## Source-quality behavior

- `AUTHORITATIVE`: documented direct/provider source with complete provenance.
- `VERIFIED_PARTIAL`: authentic but incomplete for the requested evidence family.
- `STALE`: beyond its family freshness limit; sharply discounted and normally fails closed.
- `DEGRADED`: authentic but incomplete or conflicting.
- `SYNTHETIC`: test-only; contributes zero live authority.
- `UNAVAILABLE`: absent; represented as `null`, never zero.

Multi-venue disagreement reduces confidence. Book replenishment cannot count as absorption without genuine trade confirmation. Duplicate/out-of-order normalized bars are canonicalized deterministically. A data-quality downgrade during a terminal episode changes state to `DATA_DEGRADED` and prevents a confirmed reversal.

## External method references

- MVRV definition: https://github.com/coinmetrics/docs-website/blob/master/asset-metrics/market/capmvrvcur.md
- Crypto carry: https://www.bis.org/publ/work1087.htm
- Bayesian online change-point detection: https://www.cs.princeton.edu/~rpa/pubs/adams2007changepoint.pdf
- CME crypto volatility: https://www.cmegroup.com/markets/cryptocurrencies/volatility

No claim is made that these external datasets are licensed, subscribed, or ingested by Black Terminal today.

