from __future__ import annotations

from typing import Any


DEFAULT_PARAMS = {
    "channel_length": 10,
    "average_length_multiplier": 2.1,
    "signal_length": 4,
}


def ema(values: list[float], length: int) -> list[float]:
    alpha = 2 / (max(1, length) + 1)
    out: list[float] = []
    value = values[0] if values else 0.0
    for index, item in enumerate(values):
        value = item if index == 0 else item * alpha + value * (1 - alpha)
        out.append(value)
    return out


def sma(values: list[float], length: int) -> list[float]:
    out: list[float] = []
    total = 0.0
    for index, item in enumerate(values):
        total += item
        if index - length >= 0:
            total -= values[index - length]
        out.append(total / min(index + 1, length))
    return out


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data["candles"]
    params = {**DEFAULT_PARAMS, **input_data.get("params", {})}
    channel_length = max(2, int(params["channel_length"]))
    average_length = max(3, round(channel_length * float(params["average_length_multiplier"])))
    signal_length = max(2, int(params["signal_length"]))

    hlc3 = [
        (float(candle["high"]) + float(candle["low"]) + float(candle["close"])) / 3
        for candle in candles
    ]
    esa = ema(hlc3, channel_length)
    deviation = ema([abs(value - esa[index]) for index, value in enumerate(hlc3)], channel_length)
    ci = [
        (value - esa[index]) / max(0.015 * deviation[index], 1e-8)
        for index, value in enumerate(hlc3)
    ]
    wt_main = [max(-140.0, min(140.0, value)) for value in ema(ci, average_length)]
    wt_signal = [max(-140.0, min(140.0, value)) for value in sma(wt_main, signal_length)]

    return {
        "plots": [
            {
                "id": "wavetrend_main",
                "name": "WaveTrend",
                "kind": "line",
                "color": "#d9dce1",
                "points": [
                    {"time": candle["time"], "value": wt_main[index]}
                    for index, candle in enumerate(candles)
                ],
            },
            {
                "id": "wavetrend_signal",
                "name": "WaveTrend Signal",
                "kind": "line",
                "color": "#8d929a",
                "points": [
                    {"time": candle["time"], "value": wt_signal[index]}
                    for index, candle in enumerate(candles)
                ],
            },
        ]
    }
