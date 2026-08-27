"""Authoritative causal reference for BC-MSO.

The formula preserves the supplied Pine script's eleven weighted component
scores. It is analytics-only: no broker or execution code exists here.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import exp, isfinite, sqrt, tanh
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
    calculation_mode: str = "ORIGINAL_COMPOSITE"
    adaptive_window: int = 1000
    minimum_calibration_samples: int = 120
    tail_confidence: float = 97.5
    evt_threshold_percentile: float = 90.0
    evt_minimum_tail_samples: int = 24
    atr_length: int = 21
    regime_length: int = 144
    regime_slope_length: int = 13
    regime_threshold: float = 0.35
    trend_expansion: float = 1.5
    minimum_tail_dwell: int = 2
    structure_length: int = 8
    require_structure_confirmation: bool = True
    signal_cooldown_bars: int = 24


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


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _squash(value: float) -> float:
    return 0.5 + 0.5 * tanh(value)


def _atr(candles: Sequence[dict[str, Any]], length: int) -> list[float | None]:
    true_range: list[float] = []
    for index, candle in enumerate(candles):
        high, low = float(candle["high"]), float(candle["low"])
        if index == 0:
            true_range.append(high - low)
        else:
            previous_close = float(candles[index - 1]["close"])
            true_range.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    return _rma(true_range, length)


def _quantile(sorted_values: Sequence[float], probability: float) -> float:
    if not sorted_values:
        return float("nan")
    position = _clamp(probability, 0.0, 1.0) * (len(sorted_values) - 1)
    lower, upper = int(position), int(position) if position.is_integer() else int(position) + 1
    if lower == upper:
        return sorted_values[lower]
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


def _midrank_percentile(sorted_values: Sequence[float], value: float) -> float:
    below = sum(1 for sample in sorted_values if sample < value)
    equal = sum(1 for sample in sorted_values if sample == value)
    return _clamp((below + 0.5 * equal) / len(sorted_values), 0.0, 1.0)


def _fit_gpd(exceedances: Sequence[float]) -> tuple[float, float] | None:
    if len(exceedances) < 2:
        return None
    mean = sum(exceedances) / len(exceedances)
    if not mean > 1e-12:
        return None
    variance = sum((value - mean) ** 2 for value in exceedances) / max(1, len(exceedances) - 1)
    if not variance > 1e-18:
        return None
    shape = _clamp(0.5 * (1.0 - mean * mean / variance), -0.35, 0.45)
    scale = mean * (1.0 - shape)
    return (shape, scale) if scale > 1e-12 and isfinite(scale) else None


def _gpd_survival(exceedance: float, fit: tuple[float, float]) -> float:
    shape, scale = fit
    if exceedance <= 0:
        return 1.0
    if abs(shape) < 1e-7:
        return exp(-exceedance / scale)
    base = 1.0 + shape * exceedance / scale
    return 0.0 if base <= 0 else _clamp(base ** (-1.0 / shape), 0.0, 1.0)


def _evt_adjusted_percentile(sorted_values: Sequence[float], value: float, empirical: float, settings: MarketSentimentSettings) -> tuple[float, float, bool]:
    threshold_probability = settings.evt_threshold_percentile / 100.0
    if empirical >= threshold_probability:
        threshold = _quantile(sorted_values, threshold_probability)
        exceedances = [sample - threshold for sample in sorted_values if sample > threshold]
        if len(exceedances) >= settings.evt_minimum_tail_samples:
            fit = _fit_gpd(exceedances)
            if fit:
                probability = _clamp(len(exceedances) / len(sorted_values) * _gpd_survival(max(0.0, value - threshold), fit), 1e-6, 0.5)
                return 1.0 - probability, probability, True
    if empirical <= 1.0 - threshold_probability:
        threshold = _quantile(sorted_values, 1.0 - threshold_probability)
        exceedances = [threshold - sample for sample in sorted_values if sample < threshold]
        if len(exceedances) >= settings.evt_minimum_tail_samples:
            fit = _fit_gpd(exceedances)
            if fit:
                probability = _clamp(len(exceedances) / len(sorted_values) * _gpd_survival(max(0.0, threshold - value), fit), 1e-6, 0.5)
                return probability, probability, True
    return empirical, min(empirical, 1.0 - empirical), False


def _calculate_regimes(candles: Sequence[dict[str, Any]], settings: MarketSentimentSettings) -> tuple[list[str], list[float]]:
    closes = [float(candle["close"]) for candle in candles]
    macro = _ema(closes, settings.regime_length)
    volatility = _atr(candles, settings.atr_length)
    regimes = ["INSUFFICIENT"] * len(candles)
    strengths = [0.0] * len(candles)
    active = "ROTATION"
    for index in range(settings.regime_slope_length, len(candles)):
        current_atr = volatility[index]
        if current_atr is None or current_atr <= 1e-12:
            continue
        velocity = (macro[index] - macro[index - settings.regime_slope_length]) / (current_atr * sqrt(settings.regime_slope_length))
        enter, exit_level = settings.regime_threshold, settings.regime_threshold * 0.65
        if active == "UPTREND":
            active = "DOWNTREND" if velocity <= -enter else "ROTATION" if velocity < exit_level else "UPTREND"
        elif active == "DOWNTREND":
            active = "UPTREND" if velocity >= enter else "ROTATION" if velocity > -exit_level else "DOWNTREND"
        else:
            active = "UPTREND" if velocity >= enter else "DOWNTREND" if velocity <= -enter else "ROTATION"
        regimes[index] = active
        strengths[index] = 0.0 if active == "ROTATION" else _clamp((abs(velocity) - enter) / max(0.25, 2.5 - enter), 0.0, 1.0)
    return regimes, strengths


def _calculate_adaptive(candles: Sequence[dict[str, Any]], latent: Sequence[float | None], settings: MarketSentimentSettings) -> dict[str, Any]:
    regimes, strengths = _calculate_regimes(candles, settings)
    count = len(candles)
    empirical: list[float | None] = [None] * count
    scores: list[float | None] = [None] * count
    upper: list[float | None] = [None] * count
    lower: list[float | None] = [None] * count
    tail_probability: list[float | None] = [None] * count
    samples = [0] * count
    evt_active = [False] * count
    for index, value in enumerate(latent):
        if value is None or regimes[index] == "INSUFFICIENT":
            continue
        start = max(0, index - settings.adaptive_window)
        global_values = [float(latent[cursor]) for cursor in range(start, index) if latent[cursor] is not None and regimes[cursor] != "INSUFFICIENT"]
        regime_values = [float(latent[cursor]) for cursor in range(start, index) if latent[cursor] is not None and regimes[cursor] == regimes[index]]
        selected = sorted(regime_values if len(regime_values) >= settings.minimum_calibration_samples else global_values)
        samples[index] = len(selected)
        if len(selected) < settings.minimum_calibration_samples:
            continue
        percentile = _midrank_percentile(selected, float(value))
        empirical[index] = percentile
        if settings.calculation_mode == "ADAPTIVE_EVT":
            percentile, tail_probability[index], evt_active[index] = _evt_adjusted_percentile(selected, float(value), percentile, settings)
        else:
            tail_probability[index] = min(percentile, 1.0 - percentile)
        scores[index] = _clamp(percentile * 10.0, 0.0, 10.0)
        expansion = settings.trend_expansion * strengths[index]
        upper[index] = _clamp((settings.tail_confidence + (expansion if regimes[index] == "UPTREND" else 0.0)) / 10.0, 5.05, 9.99)
        lower[index] = _clamp((100.0 - settings.tail_confidence - (expansion if regimes[index] == "DOWNTREND" else 0.0)) / 10.0, 0.01, 4.95)
    return {"empirical": empirical, "scores": scores, "upper": upper, "lower": lower, "tailProbability": tail_probability, "samples": samples, "evtActive": evt_active, "regimes": regimes, "strengths": strengths}


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
    original_sentiment = _wma(raw_sentiment, max(1, int(settings.smoothing_length))) if settings.smoothing_enabled and settings.smoothing_length > 1 else raw_sentiment.copy()

    atr_value = _atr(candles, settings.atr_length)
    latent_raw: list[float | None] = [None] * count
    for index, close in enumerate(closes):
        current_atr = atr_value[index]
        required = (current_atr, oc_trend[index], sma13[index], sma48[index], rsi_value[index], stochastic_value[index], sma200[index], mfi_value[index], cci_value[index])
        if index == 0 or any(value is None for value in required) or float(current_atr) <= 1e-12:
            continue
        histogram_velocity = histogram[index] - histogram[index - 1]
        latent_raw[index] = (
            _squash((ha_close[index] - ha_open[index]) / float(current_atr) * 2.0)
            + _squash(float(oc_trend[index]) / float(current_atr) * 18.0)
            + _squash((ema9[index] - ema21[index]) / float(current_atr) * 0.8)
            + _squash((float(sma13[index]) - float(sma48[index])) / float(current_atr) * 0.35)
            + _squash((float(rsi_value[index]) - 50.0) / 18.0)
            + 0.5 * _squash((macd_line[index] - signal_line[index]) / float(current_atr) * 5.0)
            + 0.5 * _squash(histogram[index] / float(current_atr) * 5.0 + histogram_velocity / float(current_atr) * 8.0)
            + _squash((float(stochastic_value[index]) - 50.0) / 22.0)
            + _squash((close - float(sma200[index])) / float(current_atr) / 8.0)
            + _squash((float(mfi_value[index]) - 50.0) / 22.0)
            + _squash(float(cci_value[index]) / 120.0)
        )
    latent = _wma(latent_raw, max(1, int(settings.smoothing_length))) if settings.smoothing_enabled and settings.smoothing_length > 1 else latent_raw.copy()
    adaptive = None if settings.calculation_mode == "ORIGINAL_COMPOSITE" else _calculate_adaptive(candles, latent, settings)
    sentiment = original_sentiment if adaptive is None else adaptive["scores"]
    dynamic_upper = [settings.overbought if value is not None else None for value in sentiment] if adaptive is None else adaptive["upper"]
    dynamic_lower = [settings.oversold if value is not None else None for value in sentiment] if adaptive is None else adaptive["lower"]
    empirical = [None if value is None else value / 10.0 for value in sentiment] if adaptive is None else adaptive["empirical"]
    tail_probability = [None if value is None else min(value / 10.0, 1.0 - value / 10.0) for value in sentiment] if adaptive is None else adaptive["tailProbability"]
    samples = [0] * count if adaptive is None else adaptive["samples"]
    evt_active = [False] * count if adaptive is None else adaptive["evtActive"]
    regimes = ["INSUFFICIENT"] * count if adaptive is None else adaptive["regimes"]
    strengths = [0.0] * count if adaptive is None else adaptive["strengths"]

    events: list[dict[str, Any]] = []
    def push_event(index: int, kind: str, threshold: float) -> None:
        events.append({"index": index, "time": candles[index]["time"], "score": sentiment[index], "kind": kind, "threshold": threshold, "regime": regimes[index], "tailProbability": tail_probability[index]})

    last_event_index = count - 1 if last_bar_confirmed else count - 2
    for index in range(1, last_event_index + 1):
        previous, current = sentiment[index - 1], sentiment[index]
        previous_upper, current_upper = dynamic_upper[index - 1], dynamic_upper[index]
        previous_lower, current_lower = dynamic_lower[index - 1], dynamic_lower[index]
        if any(value is None for value in (previous, current, previous_upper, current_upper, previous_lower, current_lower)):
            continue
        if previous < previous_upper and current >= current_upper: push_event(index, "ENTER_OVERBOUGHT", current_upper)
        if previous >= previous_upper and current < current_upper: push_event(index, "EXIT_OVERBOUGHT", current_upper)
        if previous > previous_lower and current <= current_lower: push_event(index, "ENTER_OVERSOLD", current_lower)
        if previous <= previous_lower and current > current_lower: push_event(index, "EXIT_OVERSOLD", current_lower)

    if adaptive is not None:
        confirmation_line = _ema(closes, settings.structure_length)
        maximum_confirmation_bars = max(12, settings.structure_length * 3)
        upper_dwell = lower_dwell = 0
        short_armed_at = long_armed_at = -1
        short_locked = long_locked = False
        last_short_signal = last_long_signal = float("-inf")
        for index in range(2, last_event_index + 1):
            current, previous, prior = sentiment[index], sentiment[index - 1], sentiment[index - 2]
            upper, lower = dynamic_upper[index], dynamic_lower[index]
            if any(value is None for value in (current, previous, prior, upper, lower)):
                continue
            if current <= 5.0: short_locked = False
            if current >= 5.0: long_locked = False
            upper_dwell = upper_dwell + 1 if current >= upper else 0
            lower_dwell = lower_dwell + 1 if current <= lower else 0
            if not short_locked and short_armed_at < 0 and upper_dwell >= settings.minimum_tail_dwell: short_armed_at = index
            if not long_locked and long_armed_at < 0 and lower_dwell >= settings.minimum_tail_dwell: long_armed_at = index
            if short_armed_at >= 0 and index - short_armed_at > maximum_confirmation_bars: short_armed_at, short_locked = -1, True
            if long_armed_at >= 0 and index - long_armed_at > maximum_confirmation_bars: long_armed_at, long_locked = -1, True
            velocity, previous_velocity = current - previous, previous - prior
            short_turn = velocity < 0 and (previous >= (dynamic_upper[index - 1] if dynamic_upper[index - 1] is not None else upper) or velocity < previous_velocity)
            long_turn = velocity > 0 and (previous <= (dynamic_lower[index - 1] if dynamic_lower[index - 1] is not None else lower) or velocity > previous_velocity)
            short_structure = not settings.require_structure_confirmation or (
                closes[index] < confirmation_line[index]
                and (closes[index - 1] >= confirmation_line[index - 1] or closes[index] < float(candles[index - 1]["low"]))
            )
            long_structure = not settings.require_structure_confirmation or (
                closes[index] > confirmation_line[index]
                and (closes[index - 1] <= confirmation_line[index - 1] or closes[index] > float(candles[index - 1]["high"]))
            )
            if short_armed_at >= 0 and current < upper and short_turn and short_structure and index - last_short_signal >= settings.signal_cooldown_bars:
                push_event(index, "CONFIRMED_ADAPTIVE_SHORT", upper)
                last_short_signal, short_armed_at, short_locked = index, -1, True
            if long_armed_at >= 0 and current > lower and long_turn and long_structure and index - last_long_signal >= settings.signal_cooldown_bars:
                push_event(index, "CONFIRMED_ADAPTIVE_LONG", lower)
                last_long_signal, long_armed_at, long_locked = index, -1, True

    events.sort(key=lambda event: (event["index"], event["kind"]))

    latest = sentiment[-1] if sentiment else None
    latest_upper = dynamic_upper[-1] if dynamic_upper else None
    latest_lower = dynamic_lower[-1] if dynamic_lower else None
    latest_zone = "INSUFFICIENT" if latest is None else "OVERBOUGHT" if latest_upper is not None and latest >= latest_upper else "OVERSOLD" if latest_lower is not None and latest <= latest_lower else "NEUTRAL"
    return {
        "schemaVersion": 2,
        "modelVersion": "BC-MSO-PYTHON-V2",
        "authority": "CAUSAL_REGIME_EVT" if settings.calculation_mode == "ADAPTIVE_EVT" else "CAUSAL_REGIME_PERCENTILE" if settings.calculation_mode == "REGIME_PERCENTILE" else "CAUSAL_OHLCV_COMPOSITE",
        "inputSize": count,
        "series": {"rawSentiment": raw_sentiment, "latentSentiment": latent, "empiricalPercentile": empirical, "sentiment": sentiment, "dynamicUpper": dynamic_upper, "dynamicLower": dynamic_lower, "tailProbability": tail_probability, "calibrationSamples": samples, "evtActive": evt_active, "regime": regimes, "regimeStrength": strengths},
        "events": events,
        "latest": {"score": latest, "rawScore": raw_sentiment[-1] if raw_sentiment else None, "latentScore": latent[-1] if latent else None, "zone": latest_zone, "regime": regimes[-1] if regimes else "INSUFFICIENT", "regimeStrength": strengths[-1] if strengths else 0.0, "dynamicUpper": latest_upper, "dynamicLower": latest_lower, "tailProbability": tail_probability[-1] if tail_probability else None, "calibrationSamples": samples[-1] if samples else 0, "evtActive": evt_active[-1] if evt_active else False},
        "integrity": {"causal": True, "finalizedBarEventsOnly": True, "futureBarsConsumed": 0, "priorBarsOnlyCalibration": True, "historicalValuesFrozen": True},
    }
