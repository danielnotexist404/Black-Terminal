"""Authoritative deterministic reference for BC-RDA.

This module contains no broker, order, portfolio, mandate, or execution code.
It consumes an already-authorized positive value series and returns read-only
risk analytics. Pine compatibility intentionally retains the supplied script's
running peak, EMA, nearest-rank distribution, and reversed risk-state mapping.
"""

from __future__ import annotations

from bisect import bisect_left, insort_right
from dataclasses import asdict, dataclass
from math import ceil, isfinite, log, sqrt
from statistics import fmean, median
from typing import Iterable, Literal, Sequence

EngineMode = Literal["pine-compatibility", "black-core-native"]
QuantileMethod = Literal["type7", "nearest-rank"]


@dataclass(frozen=True)
class DDASettings:
    engine_mode: EngineMode = "black-core-native"
    lookback: int = 500
    peak_mode: Literal["all-history", "rolling"] = "all-history"
    smoothing_length: int = 14
    smoothing_method: Literal["none", "ema", "sma", "rma"] = "ema"
    quantile_method: QuantileMethod = "type7"
    robust_zscore: bool = False
    episode_threshold_percent: float = 1.0
    periods_per_year: int = 365
    risk_free_rate_percent: float = 4.0
    hysteresis_percent: float = 2.0
    depth_weight: float = 0.45
    duration_weight: float = 0.20
    velocity_weight: float = 0.15
    volatility_weight: float = 0.10
    tail_weight: float = 0.10


def _quantile(sorted_values: Sequence[float], probability: float, method: QuantileMethod) -> float:
    if not sorted_values:
        return 0.0
    p = max(0.0, min(1.0, probability))
    if method == "nearest-rank":
        return sorted_values[min(len(sorted_values) - 1, max(0, ceil(p * len(sorted_values)) - 1))]
    if len(sorted_values) == 1:
        return sorted_values[0]
    point = (len(sorted_values) - 1) * p
    lower = int(point)
    upper = min(len(sorted_values) - 1, lower + 1)
    weight = point - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def _smooth(values: Sequence[float], method: str, length: int) -> list[float]:
    if method == "none" or length <= 1:
        return list(values)
    period = max(1, int(length))
    if method == "sma":
        result: list[float] = []
        running = 0.0
        for index, value in enumerate(values):
            running += value
            if index >= period:
                running -= values[index - period]
            result.append(running / min(period, index + 1))
        return result
    alpha = 1.0 / period if method == "rma" else 2.0 / (period + 1.0)
    result = [values[0] if values else 0.0]
    for value in values[1:]:
        result.append(alpha * value + (1.0 - alpha) * result[-1])
    return result


def _rolling_distribution(values: Sequence[float], lookback: int, method: QuantileMethod, robust: bool):
    window: list[float] = []
    output: list[dict[str, float]] = []
    running = 0.0
    squares = 0.0
    for index, value in enumerate(values):
        insort_right(window, value)
        running += value
        squares += value * value
        if index >= lookback:
            removed = values[index - lookback]
            window.pop(bisect_left(window, removed))
            running -= removed
            squares -= removed * removed
        center = median(window) if robust else running / len(window)
        deviation = median([abs(candidate - center) for candidate in window]) * 1.4826 if robust else sqrt(max(0.0, squares / len(window) - center * center))
        rank = sum(candidate <= value for candidate in window) / len(window) * 100.0
        output.append({
            "mean": center,
            "deviation": deviation,
            "rank": rank,
            **{f"p{int(p * 100):02d}": _quantile(window, p, method) for p in (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99)},
        })
    return output


def _all_history_peak(values: Sequence[float]) -> list[float]:
    result: list[float] = []
    peak = 0.0
    for value in values:
        peak = max(peak, value)
        result.append(peak)
    return result


def _rolling_peak(values: Sequence[float], lookback: int) -> list[float]:
    # Reference clarity is preferred over runtime cleverness; the browser mirror
    # uses a monotonic deque for this same causal operation.
    return [max(values[max(0, index - lookback + 1):index + 1]) for index in range(len(values))]


def _risk_state(score: float, previous: str, hysteresis: float) -> str:
    if previous == "EXTREME" and score >= 90.0 - hysteresis:
        return previous
    if previous == "HIGH" and 75.0 - hysteresis <= score < 90.0 + hysteresis:
        return previous
    if previous == "MODERATE" and 50.0 - hysteresis <= score < 75.0 + hysteresis:
        return previous
    return "EXTREME" if score >= 90 else "HIGH" if score >= 75 else "MODERATE" if score >= 50 else "LOW"


def calculate_dda(values: Iterable[float], settings: DDASettings = DDASettings()) -> dict:
    source = [float(value) for value in values]
    if any(not isfinite(value) or value <= 0 for value in source):
        raise ValueError("DDA_SOURCE_INVALID")
    source = source[-20_000:]
    lookback = max(2, min(20_000, int(settings.lookback)))
    peak = _all_history_peak(source) if settings.engine_mode == "pine-compatibility" or settings.peak_mode == "all-history" else _rolling_peak(source, lookback)
    raw = [min(0.0, (value / max(anchor, 1e-300) - 1.0) * 100.0) for value, anchor in zip(source, peak)]
    depth = [-value for value in raw]

    if settings.engine_mode == "pine-compatibility":
        smoothed = _smooth(raw, "ema", settings.smoothing_length)
        distribution = _rolling_distribution(smoothed, lookback, "nearest-rank", False)
        risk_scores = [max(0.0, min(100.0, 100.0 - point["rank"])) for point in distribution]
        risk_states = ["LOW" if point["rank"] >= 50 else "MODERATE" if point["rank"] >= 25 else "HIGH" if point["rank"] >= 10 else "EXTREME" for point in distribution]
    else:
        smoothed = _smooth(raw, settings.smoothing_method, settings.smoothing_length)
        distribution = _rolling_distribution(depth, lookback, settings.quantile_method, settings.robust_zscore)
        duration: list[float] = []
        velocity: list[float] = []
        active_duration = 0
        for index, value in enumerate(depth):
            active_duration = active_duration + 1 if value >= settings.episode_threshold_percent else 0
            duration.append(float(active_duration))
            velocity.append(max(0.0, value - (depth[index - 1] if index else 0.0)))
        duration_distribution = _rolling_distribution(duration, lookback, settings.quantile_method, False)
        velocity_distribution = _rolling_distribution(velocity, lookback, settings.quantile_method, False)
        # VADD/tail inputs are represented independently in the production TS
        # engine. The reference combines their causal percentile/tail terms here.
        total_weight = max(1e-12, settings.depth_weight + settings.duration_weight + settings.velocity_weight + settings.volatility_weight + settings.tail_weight)
        risk_scores = []
        for index, point in enumerate(distribution):
            tail = max(point["p95"], 0.25)
            tail_score = min(100.0, depth[index] / tail * 100.0) if depth[index] else 0.0
            vadd_score = point["rank"] if depth[index] else 0.0
            risk_scores.append(max(0.0, min(100.0, (
                point["rank"] * settings.depth_weight
                + duration_distribution[index]["rank"] * settings.duration_weight
                + velocity_distribution[index]["rank"] * settings.velocity_weight
                + vadd_score * settings.volatility_weight
                + tail_score * settings.tail_weight
            ) / total_weight)))
        risk_states = []
        state = "INSUFFICIENT"
        for index, score in enumerate(risk_scores):
            state = _risk_state(score, state, settings.hysteresis_percent)
            risk_states.append(state if index >= min(100, lookback) - 1 else "INSUFFICIENT")

    returns = [log(source[index] / source[index - 1]) for index in range(1, len(source))]
    average_return = fmean(returns) if returns else 0.0
    volatility = sqrt(fmean([(value - average_return) ** 2 for value in returns])) if returns else 0.0
    annual_return = average_return * settings.periods_per_year * 100.0
    annual_volatility = volatility * sqrt(settings.periods_per_year) * 100.0
    latest = len(source) - 1
    return {
        "schema_version": 1,
        "engine_mode": settings.engine_mode,
        "settings": asdict(settings),
        "series": {
            "raw_drawdown": raw,
            "smoothed_drawdown": smoothed,
            "depth": depth,
            "percentile_rank": [point["rank"] for point in distribution],
            "p95": [point["p95"] for point in distribution],
            "risk_score": risk_scores,
        },
        "latest": {
            "drawdown_percent": raw[latest] if latest >= 0 else 0.0,
            "max_drawdown_percent": max(depth[-lookback:], default=0.0),
            "risk_state": risk_states[latest] if latest >= 0 else "INSUFFICIENT",
            "risk_score": risk_scores[latest] if latest >= 0 else 0.0,
            "annualized_return_percent": annual_return,
            "annualized_volatility_percent": annual_volatility,
            "sharpe": (annual_return - settings.risk_free_rate_percent) / annual_volatility if annual_volatility else 0.0,
            "confidence": min(100.0, len(source) / max(100, lookback) * 100.0),
        },
    }
