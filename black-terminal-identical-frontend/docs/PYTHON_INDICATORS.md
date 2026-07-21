# Python Indicators

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
