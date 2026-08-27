"""Authoritative causal reference for BC-MSO.

The formula preserves the supplied Pine script's eleven weighted component
scores. It is analytics-only: no broker or execution code exists here.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Any, Sequence


@dataclass(frozen=True)
class MarketSentimentSettings:
    lookback: int = 5000
    candle_transform: int = 4
    heikin_ashi: bool = True
    smoothing_enabled: bool = False
    smoothing_length: int = 4
    overbought: float = 8.0
    oversold: float = 3.0


def _sma(values: Sequence[float], length: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    total = 0.0
    for index, value in enumerate(values):
        total += value
        if index >= length:
            total -= values[index - length]
        if index >= length - 1:
            output[index] = total / length
    return output


def _nullable_sma(values: Sequence[float | None], length: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    for index in range(length - 1, len(values)):
        window = values[index - length + 1:index + 1]
        if all(value is not None for value in window):
            output[index] = sum(float(value) for value in window) / length
    return output


def _ema(values: Sequence[float], length: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (length + 1.0)
    output = [values[0]]
    for value in values[1:]:
        output.append(alpha * value + (1.0 - alpha) * output[-1])
    return output


def _wma(values: Sequence[float | None], length: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    denominator = length * (length + 1) / 2
    for index in range(length - 1, len(values)):
        window = values[index - length + 1:index + 1]
        if all(value is not None for value in window):
            output[index] = sum(float(value) * weight for value, weight in zip(window, range(1, length + 1))) / denominator
    return output


def _rma(values: Sequence[float], length: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    if len(values) < length:
        return output
    output[length - 1] = sum(values[:length]) / length
    for index in range(length, len(values)):
        output[index] = (float(output[index - 1]) * (length - 1) + values[index]) / length
    return output


def _rsi(values: Sequence[float], length: int) -> list[float | None]:
    gains = [0.0] * len(values)
    losses = [0.0] * len(values)
    for index in range(1, len(values)):
        change = values[index] - values[index - 1]
        gains[index] = max(change, 0.0)
        losses[index] = max(-change, 0.0)
    average_gain = _rma(gains, length)
    average_loss = _rma(losses, length)
    output: list[float | None] = [None] * len(values)
    for index in range(len(values)):
        if average_gain[index] is None or average_loss[index] is None:
            continue
        output[index] = 100.0 if average_loss[index] == 0 else 0.0 if average_gain[index] == 0 else 100.0 - 100.0 / (1.0 + float(average_gain[index]) / float(average_loss[index]))
    return output


def _threshold(value: float | None, low: float, high: float) -> float | None:
    return None if value is None else 0.0 if value < low else 1.0 if value > high else 0.5


def calculate_market_sentiment(raw_candles: Sequence[dict[str, Any]], settings: MarketSentimentSettings = MarketSentimentSettings(), last_bar_confirmed: bool = True) -> dict[str, Any]:
    candles = list(raw_candles)[-max(250, min(20_000, int(settings.lookback))):]
    for candle in candles:
        if any(not isfinite(float(candle[key])) for key in ("open", "high", "low", "close", "volume")):
            raise ValueError("BC_MSO_SOURCE_INVALID")
    closes = [float(candle["close"]) for candle in candles]
    count = len(candles)
    ha_close = [sum(float(candle[key]) for key in ("open", "high", "low", "close")) / 4.0 for candle in candles]
    ha_open: list[float] = []
    for index, candle in enumerate(candles):
        ha_open.append((float(candle["open"]) + float(candle["close"])) / 2.0 if index == 0 else (ha_open[-1] + ha_close[index - 1]) / 2.0)
    ha_score = [1.0 if ha_open[index] < ha_close[index] else 0.0 for index in range(count)]

    ema20 = _ema(closes, 20)
    oc_difference = [0.0 if index == 0 else ema20[index] - ema20[index - 1] for index in range(count)]
    oc_trend = _sma(oc_difference, 2)
    oc_score = [None if value is None else 1.0 if value > 0 else 0.0 for value in oc_trend]
    ema9, ema21 = _ema(closes, 9), _ema(closes, 21)
    ema_score = [1.0 if ema9[index] > ema21[index] else 0.0 for index in range(count)]
    sma13, sma48 = _sma(closes, 13), _sma(closes, 48)
    sma_score = [None if sma13[index] is None or sma48[index] is None else 1.0 if sma13[index] > sma48[index] else 0.0 for index in range(count)]
    rsi_value = _rsi(closes, 14)
    rsi_score = [_threshold(value, 30, 70) for value in rsi_value]

    ema12, ema26 = _ema(closes, 12), _ema(closes, 26)
    macd_line = [ema12[index] - ema26[index] for index in range(count)]
    signal_line = _ema(macd_line, 9)
    histogram = [macd_line[index] - signal_line[index] for index in range(count)]
    macd_score = [0.5 if macd_line[index] > signal_line[index] else 0.0 for index in range(count)]
    histogram_score: list[float | None] = [None]
    for index in range(1, count):
        rising = histogram[index - 1] < histogram[index]
        histogram_score.append(0.5 if histogram[index] >= 0 and rising else 0.25 if histogram[index] >= 0 or rising else 0.0)

    stochastic_raw: list[float | None] = [None] * count
    for index in range(13, count):
        window = candles[index - 13:index + 1]
        highest = max(float(candle["high"]) for candle in window)
        lowest = min(float(candle["low"]) for candle in window)
        stochastic_raw[index] = 50.0 if highest == lowest else (closes[index] - lowest) / (highest - lowest) * 100.0
    stochastic_value = _nullable_sma(stochastic_raw, 2)
    stochastic_score = [_threshold(value, 20, 80) for value in stochastic_value]
    sma200 = _sma(closes, 200)
    ma200_score = [None if sma200[index] is None else 1.0 if closes[index] > sma200[index] else 0.0 for index in range(count)]

    positive, negative = [0.0] * count, [0.0] * count
    for index in range(1, count):
        flow = closes[index] * max(0.0, float(candles[index]["volume"]))
        if closes[index] > closes[index - 1]: positive[index] = flow
        elif closes[index] < closes[index - 1]: negative[index] = flow
    mfi_value: list[float | None] = [None] * count
    for index in range(14, count):
        up = sum(positive[index - 13:index + 1])
        down = sum(negative[index - 13:index + 1])
        mfi_value[index] = 100.0 if down == 0 else 0.0 if up == 0 else 100.0 - 100.0 / (1.0 + up / down)
    mfi_score = [_threshold(value, 20, 80) for value in mfi_value]

    cci_basis = _sma(closes, 20)
    cci_value: list[float | None] = [None] * count
    for index in range(19, count):
        deviation = sum(abs(value - float(cci_basis[index])) for value in closes[index - 19:index + 1]) / 20
        cci_value[index] = 0.0 if deviation == 0 else (closes[index] - float(cci_basis[index])) / (0.015 * deviation)
    cci_score = [_threshold(value, -100, 100) for value in cci_value]

    component_series = [ema_score, sma_score, rsi_score, macd_score, histogram_score, stochastic_score, ma200_score, mfi_score, cci_score, oc_score, ha_score]
    raw_sentiment: list[float | None] = []
    for index in range(count):
        values = [series[index] for series in component_series]
        raw_sentiment.append(sum(float(value) for value in values) if all(value is not None for value in values) else None)
    sentiment = _wma(raw_sentiment, max(1, int(settings.smoothing_length))) if settings.smoothing_enabled and settings.smoothing_length > 1 else raw_sentiment.copy()

    events = []
    last_event_index = count - 1 if last_bar_confirmed else count - 2
    for index in range(1, last_event_index + 1):
        previous, current = sentiment[index - 1], sentiment[index]
        if previous is None or current is None:
            continue
        kind = None
        if previous < settings.overbought <= current: kind = "ENTER_OVERBOUGHT"
        elif previous >= settings.overbought > current: kind = "EXIT_OVERBOUGHT"
        elif previous > settings.oversold >= current: kind = "ENTER_OVERSOLD"
        elif previous <= settings.oversold < current: kind = "EXIT_OVERSOLD"
        if kind:
            events.append({"index": index, "time": candles[index]["time"], "score": current, "kind": kind})

    latest = sentiment[-1] if sentiment else None
    latest_zone = "INSUFFICIENT" if latest is None else "OVERBOUGHT" if latest >= settings.overbought else "OVERSOLD" if latest <= settings.oversold else "NEUTRAL"
    return {
        "schemaVersion": 1,
        "modelVersion": "BC-MSO-PYTHON-V1",
        "authority": "CAUSAL_OHLCV_COMPOSITE",
        "inputSize": count,
        "series": {"rawSentiment": raw_sentiment, "sentiment": sentiment},
        "events": events,
        "latest": {"score": latest, "zone": latest_zone},
        "integrity": {"causal": True, "finalizedBarEventsOnly": True, "futureBarsConsumed": 0},
    }
