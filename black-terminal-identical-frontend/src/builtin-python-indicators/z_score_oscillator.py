from __future__ import annotations

from math import sqrt
from typing import Any


DEFAULT_PARAMS = {
    "length": 50,
    "scale": 24,
}


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data["candles"]
    params = {**DEFAULT_PARAMS, **input_data.get("params", {})}
    length = max(2, int(params["length"]))
    scale = float(params["scale"])
    closes = [float(candle["close"]) for candle in candles]
    values: list[float] = []

    for index, close in enumerate(closes):
        window = closes[max(0, index - length + 1): index + 1]
        mean = sum(window) / max(1, len(window))
        variance = sum((value - mean) ** 2 for value in window) / max(1, len(window))
        deviation = sqrt(variance)
        z_score = (close - mean) / deviation if deviation > 0 else 0.0
        values.append(max(-5.0, min(5.0, z_score)) * scale)

    return {
        "plots": [
            {
                "id": "z_score_oscillator",
                "name": "Z-Score Oscillator",
                "kind": "line",
                "color": "#f1f2f4",
                "points": [
                    {"time": candle["time"], "value": values[index]}
                    for index, candle in enumerate(candles)
                ],
            }
        ]
    }
