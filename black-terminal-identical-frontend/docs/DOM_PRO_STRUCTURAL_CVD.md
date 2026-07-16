# DOM Pro Structural CVD

## Purpose

DOM Pro Structural CVD is a slow order-flow structure panel. It is not a tick chart and it does not claim that historical candle volume is classified aggressor flow.

The primary source is venue OHLCV history at a user-selected structural timeframe. When historical candles are unavailable, the panel explicitly falls back to the bounded classified live trade tape.

## Model

For each historical candle, volume is split into estimated buy and sell pressure from body and wick proportions. The dominant candle direction receives the body plus half of total wick participation; the opposite direction receives the remaining wick participation. Flat or zero-range candles split volume evenly.

The panel then computes rolling buy and sell structure using one of:

- rolling sum
- normalized EMA
- normalized SMA

The default is a 14-bar rolling sum over 4-hour venue candles. The default camera displays 120 bars from a 240-bar history, providing roughly 20 days of visible 4-hour structure and 40 days available for navigation.

The display contains:

- a fixed zero line
- rolling delta histogram centered on zero
- positive rolling buy-pressure envelope
- negative rolling sell-pressure envelope
- stable time labels and compact source diagnostics

The model is adapted mathematically from the MPL-2.0 SVD+CVD reference supplied with the project. No Pine runtime or parallel Python indicator engine is introduced.

## Stability

Live ticks do not append visual candles when historical OHLCV is available. The active venue candle is refreshed at a bounded interval and updates in place. Therefore:

- the X camera does not reset every second
- visible history does not collapse to a short session tape
- the Y domain is symmetric around zero
- panning and wheel zoom remain user-controlled
- double-click restores the broad live camera

The outlier percentile bounds isolated delta spikes without changing cumulative buy/sell calculations.

## Settings

All controls live in the Structural CVD panel settings:

- Structure Timeframe
- Historical Bars
- Cumulation
- Cumulation Length
- Normalize EMA / SMA
- Cumulative Scale
- Visible Structure Bars
- Delta Outlier Percentile
- Panel Cadence
- Show Delta Histogram
- Show Buy / Sell Structure

Presets are Fast, Intraday, Structural and Macro. Structural is the institutional default.

## Data Truth

`ESTIMATED OHLCV` means direction was inferred from venue candle anatomy. `LIVE TAPE` means the fallback uses exchange-classified trade sides. These sources are not silently blended because their coverage and semantics differ.

## Performance

The calculation is bounded to at most 1,000 historical bars, runs as a pure memoized projection, and does not create an additional websocket or market-data subscription. Historical refresh is bounded to at least 60 seconds. Existing DOM aggregation, heatmap, depth and execution paths are unchanged.

## Persistence

Panel settings schema version 6 migrates earlier short-window CVD settings to the Structural defaults. Preferences remain browser/workspace scoped. No Supabase migration is required.
