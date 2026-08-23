# Python Indicators

> The durable `volatilityHeatmap` feature is no longer a Python-runtime indicator. It now hosts the
> worker-based Kioseff Stop Loss Clustering implementation. The legacy Python VAE source remains
> unreferenced only until TradingView golden certification authorizes retirement; it is not a
> fallback. See `indicators/KIOSEFF_STOP_LOSS_CLUSTER_IMPLEMENTATION.md`.

## Kioseff Production Boundary (2026-08-01)

Kioseff Stop Loss Clustering executes in a dedicated TypeScript Web Worker. The production data path
is authoritative venue history/realtime data -> ordered lower-timeframe reconstruction -> TypeScript
compatibility engine -> immutable canonical snapshot -> Pixi/React projection. Python may be used
offline for independent fixture inspection or validation only; it is neither the production engine
nor a runtime fallback. Pine Compatibility remains `parity-pending`, and Black Core Enhanced Mode is
disabled until approved TradingView golden fixtures pass.

Python indicators are a first-class product goal. The core rule: scripts should be powerful for
analysis but limited in what they can touch.

## Draft Function Contract

```python
def compute(ctx):
    candles = ctx["candles"]
    params = ctx.get("params", {})

    return {
        "plots": [
            {
                "id": "ema_20",
                "name": "EMA 20",
                "kind": "line",
                "color": "#d2d6dd",
                "points": [{"time": candle["time"], "value": 0.0} for candle in candles],
            }
        ],
        "signals": [],
        "diagnostics": [],
    }
```

## Input Shape

```json
{
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "candles": [
    {
      "time": 1716812100,
      "open": 66600.0,
      "high": 66720.0,
      "low": 66520.0,
      "close": 66678.1,
      "volume": 2380.0
    }
  ],
  "params": {
    "period": 20
  }
}
```

## Output Rules

- `plots` are visual overlays or pane series.
- `signals` are optional events used by alerts, strategy tools, or markers.
- `diagnostics` are user-visible messages for warnings and runtime notes.
- Missing values should be returned as `null`.
- Scripts should not mutate input candles.

## Sandbox Policy

Community indicators should run with:

- No filesystem access by default.
- No network access by default.
- A wall-clock timeout.
- Memory limits.
- Version-pinned dependencies.
- Clear permission prompts for any future elevated capability.

## Runtime Milestones

1. Define and validate the JSON protocol in TypeScript.
2. Add a desktop-only Python sidecar proof of concept.
3. Add cancellation, timeout, diagnostics, and error surfaces.
4. Render returned plots through the chart engine.
5. Add signed indicator packages and metadata.
6. Validate the iPad/iPhone packaging strategy before expanding library support.

## Black Core Auction Profiles

The optional `python/black_core_profiles` package covers historical composite rebuilds, exact trade aggregation, price-grid research, TPO, realized/Parkinson volatility, value area, CVD LVN/HVN experiments, compact float64 serialization, and golden fixture validation. It is deliberately not required by the live chart.

Validation: `python3 scripts/auction-profile-python-tests.py`.


## BC-RDA

BC-RDA adds an auditable Python reference and a production browser TypeScript worker mirror. Run `npm run test:dda-pro-python-parity` to verify the core raw, smoothed, depth, and distribution outputs. The Python package is not claimed as a deployed sidecar.

The Python reference does not certify historical dots or automation. The old dot projection is now `BC_RDA_LEGACY_REPAINTING`; the separate `BC_RDA_CAUSAL_V2` closed-bar signal machine lives in TypeScript and is tested with `npm run test:dda-pro-no-repaint`. Alerts and all strategy runtimes remain blocked until a separately implemented headless runtime passes the same timestamp/checkpoint contract.
