from __future__ import annotations

from typing import Any


DEFAULT_PARAMS = {
    "length": 34,
    "fast_multiplier": 1,
    "slow_multiplier": 3,
}


def ema(values: list[float], length: int) -> list[float]:
    alpha = 2 / (max(1, length) + 1)
    out: list[float] = []
    value = values[0] if values else 0.0
    for index, item in enumerate(values):
        value = item if index == 0 else item * alpha + value * (1 - alpha)
        out.append(value)
    return out


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data["candles"]
    params = {**DEFAULT_PARAMS, **input_data.get("params", {})}
    length = int(params["length"])

    signed_flow: list[float] = []
    for candle in candles:
        high = float(candle["high"])
        low = float(candle["low"])
        close = float(candle["close"])
        open_ = float(candle["open"])
        volume = float(candle["volume"])
        span = max(high - low, close * 0.00001, 1e-8)
        body_pressure = max(-1.0, min(1.0, (close - open_) / span))
        signed_flow.append(volume * body_pressure)

    fast = ema(signed_flow, length * int(params["fast_multiplier"]))
    slow = ema(signed_flow, length * int(params["slow_multiplier"]))
    basis = ema([abs(value) for value in signed_flow], length * int(params["slow_multiplier"]))
    values = [
        max(-120.0, min(120.0, ((fast[index] - slow[index]) / max(basis[index], 1e-8)) * 100))
        for index in range(len(signed_flow))
    ]

    return {
        "plots": [
            {
                "id": "open_interest_oscillator",
                "name": "Open Interest Oscillator",
                "kind": "histogram",
                "color": "#ff303d",
                "points": [
                    {"time": candle["time"], "value": values[index]}
                    for index, candle in enumerate(candles)
                ],
            }
        ],
        "diagnostics": ["Uses candle volume as OI-pressure proxy until native exchange OI history is connected."],
    }
