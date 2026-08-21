# BC-TERA Architecture

Status: Phase I research indicator. Live execution is locked.

## Boundary

BC-TERA is a separate native Black Core module under `src/modules/bc-tera`. It does not import or modify BC-RDA, RADAP, HDLX, BCLIF, strategy execution, broker connectivity, positions, orders, or Black Cloud.

```text
authoritative collectors (Phase II)
             |
             v
versioned normalized HTF feature bars
             |
             v
bounded BC-TERA worker (maximum 2,000 bars)
             |
             +--> causal feature scores
             +--> directional CUSUM
             +--> separate top/bottom hazards
             +--> hysteretic state machine
             +--> evidence ledger + deterministic events
             |
             v
Black Chart pane / diagnostics / research alerts
             |
             X  no strategy or order connection
```

Phase I has one deliberately narrow adapter: confirmed chart candles become `VERIFIED_PARTIAL` market features. It does not infer trade aggressors, order-book replenishment, on-chain valuation, derivatives, liquidations, options, or stablecoin conditions. Those families remain `null` and `UNAVAILABLE`, reducing confidence and causing the live shell to fail closed as `DATA_DEGRADED`.

## Contracts

Every normalized feature bar includes model schema, symbol, exchange scope, asset profile, decision timeframe, bar timestamp, confirmed/provisional state, source cutoff, received timestamp, revision ID, quality, and per-source provenance records.

Supported decision timeframes are 4H, 12H, 1D, 3D, and 1W. Only closed decision bars may create events. Provisional calculations may be displayed but cannot create confirmed reversal states or alerts.

Missing evidence is represented by `null` blocks and an explicit unavailable-family list. It is never converted to zero. Duplicate timestamps are resolved deterministically by received timestamp and revision ID. Input is sorted causally and bounded before evaluation.

## Models

The engine publishes independent top and bottom hazards, buyer and seller exhaustion, leverage fragility/reset, valuation extremity, spot absorption, distribution, capitulation, change-point probability/direction/run length, data confidence, and the required state machine.

The production-default change detector is directional CUSUM. The Bayesian online option is visible but disabled until Phase II validation. Hazard outputs are fixed, interpretable Phase-I research priors; they are not empirically calibrated probabilities yet.

Top and bottom state progressions are intentionally asymmetric:

```text
NORMAL_EXPANSION -> MATURE_EXPANSION -> TOP_EXTREMITY
-> TOP_EXHAUSTION -> TOP_REVERSAL_CONFIRMED

NORMAL_CONTRACTION -> MATURE_CONTRACTION -> BOTTOM_EXTREMITY
-> BOTTOM_CAPITULATION -> BOTTOM_ABSORPTION
-> BOTTOM_REVERSAL_CONFIRMED
```

Confirmation requires sufficient data confidence, causal change-point direction/probability, structure break/recovery, a closed bar, state duration, hazard threshold, and complementary evidence. A high valuation, low valuation, positive funding, or liquidation cascade alone cannot confirm a reversal.

## Identity and parity

Event identity includes model version, profile, exchange scope, symbol, decision timeframe, event type, confirmed candle timestamp, and terminal episode ID. A plotted marker and its research alert derive from the same `BCTERAEvent` object. UI alert arming starts at the most recent known event to prevent historical replay.

## Performance

Raw multi-venue tick, book, derivatives, options, or on-chain history is not calculated in the browser. The worker accepts no more than 2,000 already-normalized bars, discards stale generations, and has an inline computation fallback only if Web Workers are unavailable. The frontend owns no high-frequency polling or extra WebSocket subscription for BC-TERA.

