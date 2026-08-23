# BC-QALC Chart Integration

## Product contract

The chart and Strategy Lab are two views over one engine identity: `black-core-qalc` / `BC-QALC-BASELINE-1`.

The worker projects immutable canonical event records for:

- long and short candidates;
- working passive bid and ask quotes;
- quote cancellation and expiry;
- partial queue fills;
- actual Paper inventory entries;
- actual Paper inventory exits.

Each record carries exchange event time, receive time, symbol, run, model, reason, price, quantity, decision/order/fill identity, position-cycle identity and the decision evidence available at that instant. IDs are deterministic under exact replay.

Research setups are emitted after causal directional confirmation even when the toxicity, fill-probability or fee-adjusted edge gate correctly blocks a quote. They are labelled `RESEARCH LONG` / `RESEARCH SHORT`, carry the rejection reason, and are never promoted to an entry. Previously recorded direction-confirmed rejections can be deterministically projected into the same setup markers without using future events or candles.

## Rendering rules

`QalcIndicatorOverlay` maps `eventTime / 1000` through `BlackChartEngine.getScreenXForTimestamp` and maps the recorded price through `getScreenYForPrice`. Changing timeframe, zoom or pan changes only projection coordinates. It does not rerun, relocate or rewrite a finalized event.

White/silver denotes long-side semantics, blood red denotes short-side semantics, gray denotes neutral/terminal state. Candidate markers are not fills. A setup may carry a recorded `MODEL TP` and `INVALIDATION` projection, both explicitly marked as research projections rather than orders. Entry markers require a conservative Paper execution record; exits require a Paper inventory close execution.

The overlay clusters research markers only at the current screen-pixel density so a millisecond strategy remains readable on higher-timeframe charts. Clustering never changes the event record. A diagnostic strip reports research setups, actual Paper entries and the dominant execution gate so a flat engine cannot look like a rendering failure.

The optional microstructure pane displays the latest canonical queue imbalance, OFI, real notional CVD, flow efficiency, toxicity and fill estimate. It does not infer missing event history from OHLCV candles.

## Persistence and coverage

`QalcTimelineStore` atomically persists a bounded, idempotent event timeline beside worker state. The authenticated `GET /api/qalc/timeline` endpoint filters it by symbol, event-time range and optional run. Its coverage is explicitly incomplete and sourced as `RECORDED_QALC_EVENT_TIME`.

No candle-derived fallback exists. When the worker timeline is unavailable or predates the visible chart range, the UI says so.

## Strategy Lab handoff

The chart settings use schema version 1. Opening the configuration in Strategy Lab stores an integrity-checked local handoff containing symbol, model controls, display controls and a stable configuration hash. The saved private strategy preserves the hash and schema version in its JSON configuration.

This handoff does not publish a strategy, connect a broker, activate Paper trading, enable Investment Group fanout or create a live order.
