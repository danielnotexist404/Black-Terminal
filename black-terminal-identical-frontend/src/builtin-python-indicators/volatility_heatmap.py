from __future__ import annotations

from math import sqrt
from statistics import median
from typing import Any


DEFAULT_PARAMS = {
    "length": 34,
    "max_zones": 1800,
}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def ema(values: list[float], length: int) -> list[float]:
    alpha = 2 / (max(1, length) + 1)
    out: list[float] = []
    value = values[0] if values else 0.0
    for index, item in enumerate(values):
        value = item if index == 0 else item * alpha + value * (1 - alpha)
        out.append(value)
    return out


def overlap(low_a: float, high_a: float, low_b: float, high_b: float) -> bool:
    return max(low_a, low_b) <= min(high_a, high_b)


def find_start(candles: list[dict[str, Any]], origin_index: int, price_low: float, price_high: float, length: int) -> int:
    lookback = min(origin_index, max(420, length * 28))
    for index in range(origin_index - 1, origin_index - lookback - 1, -1):
        candle = candles[index]
        if overlap(float(candle["low"]), float(candle["high"]), price_low, price_high):
            return index
    return max(0, origin_index - max(80, length * 8))


def find_end(candles: list[dict[str, Any]], origin_index: int, price: float, price_low: float, price_high: float, length: int) -> int:
    origin = candles[origin_index]
    origin_close = float(origin["close"])
    min_hold = min(10, max(3, round(length * 0.18)))
    max_forward = min(len(candles) - 1, origin_index + max(240, length * 36))
    above_origin = price > origin_close
    below_origin = price < origin_close

    for index in range(origin_index + min_hold, max_forward + 1):
        candle = candles[index]
        high = float(candle["high"])
        low = float(candle["low"])
        if above_origin and high >= price_low:
            return index
        if below_origin and low <= price_high:
            return index
        if not above_origin and not below_origin and overlap(low, high, price_low, price_high):
            return index
    return len(candles) - 1


def make_zone(
    candles: list[dict[str, Any]],
    origin_index: int,
    price: float,
    half_range: float,
    strength: float,
    side: str,
    length: int,
) -> dict[str, Any]:
    price_low = price - half_range
    price_high = price + half_range
    start_index = find_start(candles, origin_index, price_low, price_high, length)
    end_index = find_end(candles, origin_index, price, price_low, price_high, length)

    return {
        "id": f"volatility_heatmap_{origin_index}_{round(price, 4)}",
        "startTime": candles[start_index]["time"],
        "endTime": candles[end_index]["time"],
        "priceLow": price_low,
        "priceHigh": price_high,
        "strength": strength,
        "side": side,
        "color": "#050607" if side == "support" else "#ff303d",
    }


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data["candles"][-12000:]
    params = {**DEFAULT_PARAMS, **input_data.get("params", {})}
    length = max(5, min(300, int(params["length"])))
    max_zones = max(100, int(params["max_zones"]))

    if len(candles) < length + 8:
        return {"plots": [], "zones": [], "diagnostics": ["Not enough candles for Volatility Heatmap."]}

    steps = [
        int(candles[index]["time"]) - int(candles[index - 1]["time"])
        for index in range(1, len(candles))
        if int(candles[index]["time"]) > int(candles[index - 1]["time"])
    ]
    bar_seconds = max(60, median(steps) if steps else 60)
    time_scale = clamp(sqrt(bar_seconds / 60), 0.85, 3.4)
    true_ranges: list[float] = []
    volumes: list[float] = []

    for index, candle in enumerate(candles):
        high = float(candle["high"])
        low = float(candle["low"])
        close = float(candle["close"])
        previous_close = float(candles[index - 1]["close"]) if index > 0 else close
        true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close), close * 0.00001, 1e-8))
        volumes.append(max(0.0, float(candle["volume"])))

    atr = ema(true_ranges, max(5, round(length * 0.62)))
    volume_basis = ema(volumes, length)
    running_score = 1.75
    ranked: list[tuple[float, dict[str, Any]]] = []

    for index in range(length, len(candles)):
        candle = candles[index]
        previous = candles[index - 1]
        open_ = float(candle["open"])
        high = float(candle["high"])
        low = float(candle["low"])
        close = float(candle["close"])
        previous_close = float(previous["close"])
        candle_range = max(high - low, close * 0.00001, 1e-8)
        atr_value = max(atr[index], close * 0.00008, 1e-8)
        body_pressure = abs(close - open_) / candle_range
        expansion = candle_range / atr_value
        move_pressure = abs(close - previous_close) / atr_value
        close_location = (close - low) / candle_range if close >= open_ else (high - close) / candle_range
        volume_pressure = sqrt(max(0.08, float(candle["volume"]) / max(1.0, volume_basis[index])))
        impulse = expansion * 0.56 + move_pressure * 0.25 + body_pressure * 0.34 + close_location * 0.18
        score = impulse * volume_pressure
        score_basis = max(1.75, running_score)
        running_score = max(running_score * 0.996, score)

        if score < 1.48 and not (expansion > 1.65 and volume_pressure > 0.86):
            continue

        bullish = close >= open_
        strength = clamp((score / score_basis) ** 0.68, 0.16, 1.0)
        entry = min(open_, close) if bullish else max(open_, close)
        entry_half = max(atr_value * (0.035 + strength * 0.045) * time_scale, candle_range * 0.07)
        stop_distance = atr_value * (0.18 + strength * 0.34) * time_scale
        stop = low - stop_distance if bullish else high + stop_distance
        stop_half = max(atr_value * (0.032 + strength * 0.038) * time_scale, candle_range * 0.052)
        side = "support" if bullish else "resistance"

        ranked.append((score, make_zone(candles, index, entry, entry_half, strength, side, length)))
        ranked.append((score * 0.82, make_zone(candles, index, stop, stop_half, strength * 0.82, side, length)))

    zones = [
        zone
        for _score, zone in sorted(ranked, key=lambda item: item[0], reverse=True)[:max_zones]
    ]

    return {
        "plots": [],
        "zones": zones,
        "diagnostics": [
            "Premium Volatility Heatmap: deterministic volatility-at-entry zones; oscillator output intentionally omitted."
        ],
    }
