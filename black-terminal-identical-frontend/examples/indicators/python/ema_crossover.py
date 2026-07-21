def _ema(values, period):
    if period <= 0:
        raise ValueError("period must be greater than zero")

    alpha = 2 / (period + 1)
    out = []
    current = None

    for value in values:
        current = value if current is None else value * alpha + current * (1 - alpha)
        out.append(current)

    return out


def compute(ctx):
    candles = ctx["candles"]
    params = ctx.get("params", {})
    fast_period = int(params.get("fast", 20))
    slow_period = int(params.get("slow", 50))

    closes = [candle["close"] for candle in candles]
    fast = _ema(closes, fast_period)
    slow = _ema(closes, slow_period)

    signals = []
    for index in range(1, len(candles)):
        crossed_up = fast[index - 1] <= slow[index - 1] and fast[index] > slow[index]
        crossed_down = fast[index - 1] >= slow[index - 1] and fast[index] < slow[index]

        if crossed_up or crossed_down:
            signals.append(
                {
                    "time": candles[index]["time"],
                    "name": "EMA crossover",
                    "direction": "bullish" if crossed_up else "bearish",
                    "price": candles[index]["close"],
                }
            )

    return {
        "plots": [
            {
                "id": "ema_fast",
                "name": f"EMA {fast_period}",
                "kind": "line",
                "color": "#d2d6dd",
                "points": [
                    {"time": candle["time"], "value": value}
                    for candle, value in zip(candles, fast)
                ],
            },
            {
                "id": "ema_slow",
                "name": f"EMA {slow_period}",
                "kind": "line",
                "color": "#d62839",
                "points": [
                    {"time": candle["time"], "value": value}
                    for candle, value in zip(candles, slow)
                ],
            },
        ],
        "signals": signals,
        "diagnostics": [],
    }
