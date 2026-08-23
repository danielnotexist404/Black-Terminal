# Black Core Consolidated Liquidity Fabric

## Phase I boundary

Phase I creates the deterministic, venue-provenanced calculation core required before Black Terminal can present a multi-exchange book. It is deliberately not connected to DOM Pro, IMM, PostgreSQL, broker execution or the VPS runtime yet.

The existing chart adapters cannot be treated as certified composite sources. Some legacy REST snapshot paths obtain Binance data and relabel the response as Coinbase, Kraken, Hyperliquid or Bitfinex. Several WebSocket paths are direct, but their snapshots, sequence handling, depth limits and recovery behavior differ. The existing market-depth collector also forwards some incremental messages into snapshot-oriented persistence without maintaining a complete per-venue reconstructed book. Combining those paths would manufacture misleading cross-venue walls.

Phase I therefore enforces these invariants:

1. Every update carries a canonical instrument identity and direct venue provenance.
2. Relabelled or proxy depth is rejected before reconstruction.
3. A delta cannot be accepted before an authoritative snapshot.
4. Duplicate updates are idempotent.
5. Sequence gaps quarantine the venue book until a new snapshot recovers it.
6. Crossed, empty or stale books are excluded from composite output.
7. Spot, linear contracts, inverse contracts and quote-denominated quantities use explicit conversion formulas.
8. Composite rows retain every venue contribution; the total is never an anonymous sum.
9. Executable and global-informational views are different products.
10. Hidden, RPI, inferred IMM and synthetic liquidity are excluded unless a future layer explicitly and visibly adds them.
11. Spot and derivative books remain separate instrument families; a future cross-market view must opt in with explicit semantics.
12. A checksum-bearing update from a venue that supports checksum validation is quarantined until its checksum is verified.

## Official public-feed capability matrix

The initial policies encode public capabilities rather than promising infinite depth:

- Binance: bounded snapshot plus incremental depth reconstruction. <https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams>
- Bybit: bounded public L2 order book. <https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook>
- Coinbase: complete aggregated L2 with guaranteed updates; its full/L3 channel is a separate future source. <https://docs.cdp.coinbase.com/exchange/websocket-feed/channels>
- Kraken: bounded L2 with checksum support. <https://docs.kraken.com/api/docs/websocket-v2/book/>
- OKX: public books with deeper/faster tiers governed by venue policy. <https://www.okx.com/docs-v5/trick_en/>
- Bitget: pair-dependent public full-book limits and sequence continuity. <https://www.bitget.com/api-doc/uta/websocket/public/Order-Book-Channel>
- Hyperliquid: at most 20 L2 levels per side and block-cadenced snapshots. <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>

CoinGecko and CoinMarketCap may later provide metadata and reference context. They are not raw L2/L3 reconstruction sources.

## Composite semantics

Each accepted level is normalized to base quantity and USD quote notional using an explicit quantity model:

- `BASE`: `base = nativeQuantity`; `notionalUsd = base * priceUsd`
- `QUOTE`: `notionalUsd = nativeQuantity * quoteFx`; `base = notionalUsd / priceUsd`
- `CONTRACTS_LINEAR`: `base = contracts * multiplier`; `notionalUsd = base * priceUsd`
- `CONTRACTS_INVERSE`: `notionalUsd = contracts * multiplier * quoteFx`; `base = notionalUsd / priceUsd`

Price levels are projected into basis-point bins around a quality-weighted median reference price. Every row exposes raw observed notional, freshness/latency/coverage-weighted notional and named per-venue contributions. Missing FX conversion excludes a book rather than assuming stablecoin parity.

## Next certification phases

1. Implement direct server-side adapters with venue-native snapshot/delta/checksum recovery.
2. Run live public-data certification for each venue independently and retain replay fixtures.
3. Add a bounded event log, checkpoints and retention tiers on the VPS.
4. Expose authenticated read-only composite snapshots and deltas through the private backplane.
5. Add DOM Pro views for `VENUE`, `GLOBAL INFORMATIONAL` and `EXECUTABLE` books.
6. Add IMM as a separate inferred-confluence channel, never as observed order size.
7. Move the renderer to adaptive 60/30/15 FPS while ingestion continues at each venue's genuine cadence.

No deployment should occur until the direct-adapter and replay certifications prove reconstruction parity, gap recovery, staleness exclusion and stable resource bounds.
