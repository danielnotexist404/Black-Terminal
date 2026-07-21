from __future__ import annotations

from math import log, sqrt
from typing import Any


DEFAULT_PARAMS = {
    "show_volume_profile": True,
    "show_sentiment_profile": True,
    "show_supply_demand_zones": True,
    "supply_demand_threshold": 15,
    "show_profile_gaps": True,
    "node_detection_percent": 7,
    "poc_mode": "developing",
    "value_area_percent": 68,
    "polarity_method": "barPolarity",
    "range_mode": "fixed",
    "fixed_range_length": 360,
    "rows": 100,
    "hdlx_oscillator": True,
    "hdlx_price_source": "hl2",
    "hdlx_lookback": 360,
    "hdlx_smooth": 5,
    "hdlx_extreme": 2.5,
    "hdlx_clamp": 3.0,
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def source_price(candle: dict[str, Any], source: str) -> float:
    if source == "hl2":
        return (float(candle["high"]) + float(candle["low"])) / 2
    if source == "hlc3":
        return (float(candle["high"]) + float(candle["low"]) + float(candle["close"])) / 3
    if source == "ohlc4":
        return (
            float(candle["open"]) +
            float(candle["high"]) +
            float(candle["low"]) +
            float(candle["close"])
        ) / 4
    return float(candle["close"])


def calculate_hdlx(candles: list[dict[str, Any]], start: int, end: int, params: dict[str, Any]) -> list[dict[str, Any]]:
    lookback = int(clamp(int(params["hdlx_lookback"]), 20, 5000))
    smooth = int(clamp(int(params["hdlx_smooth"]), 1, 50))
    prices = [source_price(candle, params["hdlx_price_source"]) for candle in candles]
    log_deviation: list[float] = []
    alpha = 2 / (smooth + 1)
    price_volume_sum = 0.0
    volume_sum = 0.0
    log_sum = 0.0
    log_square_sum = 0.0
    ema = 0.0
    out: list[dict[str, Any]] = []

    for index in range(0, end + 1):
        weight = max(0.0, float(candles[index]["volume"]))
        price_volume_sum += prices[index] * weight
        volume_sum += weight

        expired_price_index = index - lookback
        if expired_price_index >= 0:
            expired_weight = max(0.0, float(candles[expired_price_index]["volume"]))
            price_volume_sum -= prices[expired_price_index] * expired_weight
            volume_sum -= expired_weight

        vwma = price_volume_sum / volume_sum if volume_sum > 0 else prices[index]
        log_value = log(prices[index] / vwma) if prices[index] > 0 and vwma > 0 else 0.0
        log_deviation.append(log_value)
        log_sum += log_value
        log_square_sum += log_value * log_value

        expired_log_index = index - lookback
        if expired_log_index >= 0:
            expired_log = log_deviation[expired_log_index]
            log_sum -= expired_log
            log_square_sum -= expired_log * expired_log

        window_size = min(index + 1, lookback)
        mean = log_sum / max(1, window_size)
        variance = max(0.0, log_square_sum / max(1, window_size) - mean * mean)
        deviation = sqrt(variance)
        raw_z = log_value / deviation if deviation > 0 else 0.0
        ema = raw_z if index == 0 else raw_z * alpha + ema * (1 - alpha)

        if index >= start:
            out.append({"index": index, "time": candles[index]["time"], "value": ema})
    return out


def calculate_profile(candles: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, Any]:
    end = len(candles) - 1
    if params["range_mode"] == "visible":
        start = max(0, int(params.get("visible_start_index", 0)))
    else:
        start = max(0, end - int(clamp(int(params["fixed_range_length"]), 10, 5000)) + 1)

    profile = candles[start:end + 1]
    profile_high = max(float(candle["high"]) for candle in profile)
    profile_low = min(float(candle["low"]) for candle in profile)
    price_range = max(profile_high - profile_low, profile_high * 0.00001, 1e-8)
    row_count = int(clamp(int(params["rows"]), 10, 150))
    step = price_range / row_count
    rows = []

    for index in range(row_count):
        low = profile_low + step * index
        high = profile_high if index == row_count - 1 else low + step
        rows.append({
            "index": index,
            "price_low": low,
            "price_high": high,
            "price": (low + high) / 2,
            "total_volume": 0.0,
            "buy_volume": 0.0,
            "sell_volume": 0.0,
            "delta": 0.0,
            "value_area": False,
            "supply_demand": None,
            "profile_gap": False,
        })

    developing_poc: list[dict[str, Any]] = []
    running_volume = [0.0 for _ in range(row_count)]

    for offset, candle in enumerate(profile):
        low = min(float(candle["low"]), float(candle["high"]))
        high = max(float(candle["low"]), float(candle["high"]))
        candle_range = max(high - low, step, float(candle["close"]) * 0.00001, 1e-8)
        first_row = int(clamp((low - profile_low) // step, 0, row_count - 1))
        last_row = int(clamp((high - profile_low) // step, 0, row_count - 1))
        if params["polarity_method"] == "pressure":
            is_buying = float(candle["close"]) - float(candle["low"]) > float(candle["high"]) - float(candle["close"])
        else:
            is_buying = float(candle["close"]) > float(candle["open"])

        for row_index in range(first_row, last_row + 1):
            row = rows[row_index]
            overlap = max(0.0, min(high, row["price_high"]) - max(low, row["price_low"]))
            portion = clamp(overlap / candle_range, 0.0001, 1.0)
            volume = float(candle["volume"]) * portion
            row["total_volume"] += volume
            running_volume[row_index] += volume
            if is_buying:
                row["buy_volume"] += volume

        developing_index = max(range(row_count), key=lambda item: running_volume[item])
        developing_poc.append({
            "index": start + offset,
            "time": candle["time"],
            "price": rows[developing_index]["price"],
        })

    total_volume = 0.0
    max_volume = 0.0
    poc_index = 0
    for row in rows:
        row["sell_volume"] = max(0.0, row["total_volume"] - row["buy_volume"])
        row["delta"] = row["buy_volume"] - row["sell_volume"]
        total_volume += row["total_volume"]
        if row["total_volume"] > max_volume:
            max_volume = row["total_volume"]
            poc_index = row["index"]

    target = total_volume * clamp(float(params["value_area_percent"]), 0, 100) / 100
    value_volume = rows[poc_index]["total_volume"]
    low_index = poc_index
    high_index = poc_index
    while value_volume < target and not (low_index <= 0 and high_index >= row_count - 1):
        up = rows[high_index + 1]["total_volume"] if high_index < row_count - 1 else -1
        down = rows[low_index - 1]["total_volume"] if low_index > 0 else -1
        if up >= down:
            high_index += 1
            value_volume += max(0, up)
        else:
            low_index -= 1
            value_volume += max(0, down)

    for index in range(low_index, high_index + 1):
        rows[index]["value_area"] = True

    sd_threshold = clamp(float(params["supply_demand_threshold"]), 0, 41) / 100
    gap_window = max(1, round(row_count * clamp(float(params["node_detection_percent"]), 0, 100) / 100))
    for row in rows:
        if max_volume > 0 and row["total_volume"] / max_volume < sd_threshold:
            row["supply_demand"] = "supply" if row["index"] > poc_index else "demand"

        neighbors = [
            rows[x]["total_volume"]
            for x in range(max(0, row["index"] - gap_window), min(row_count, row["index"] + gap_window + 1))
            if x != row["index"]
        ]
        neighbor_average = sum(neighbors) / len(neighbors) if neighbors else 0
        row["profile_gap"] = neighbor_average > 0 and row["total_volume"] < neighbor_average * 0.42

    return {
        "rows": rows,
        "start_index": start,
        "end_index": end,
        "profile_high": profile_high,
        "profile_low": profile_low,
        "poc_index": poc_index,
        "poc_price": rows[poc_index]["price"],
        "value_area_high": rows[high_index]["price_high"],
        "value_area_low": rows[low_index]["price_low"],
        "total_volume": total_volume,
        "average_volume": total_volume / max(1, len(profile)),
        "developing_poc": developing_poc,
        "hdlx": calculate_hdlx(candles, start, end, params) if params["hdlx_oscillator"] else [],
    }


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data["candles"][-12000:]
    params = {**DEFAULT_PARAMS, **input_data.get("params", {})}
    if len(candles) < 10:
        return {"plots": [], "profile": None, "diagnostics": ["Not enough candles for HDLX Profile."]}

    profile = calculate_profile(candles, params)
    return {
        "plots": [],
        "profile": profile,
        "diagnostics": [
            "HDLX Profile: fixed/visible range volume distribution, POC, value area, sentiment, supply/demand, and HDLX VWPZ."
        ],
    }
