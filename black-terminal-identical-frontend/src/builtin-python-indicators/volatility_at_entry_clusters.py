from __future__ import annotations

from dataclasses import dataclass, field
from math import floor, isfinite, sqrt
from typing import Any


DEFAULT_PARAMS = {
    "atr_length": 14,
    "sma_length": 50,
    "base_tf_minutes": 1.0,
    "projection_timeframes": [1, 5, 15, 30, 60, 240],
    "projection_multipliers": [1.0, 1.5, 2.0],
    "tick_size": 0.01,
    "grid_mode": "atr_quarter",
    "use_bid_ask_enhancement": True,
    "min_delta_percentile": 80,
    "strong_delta_percentile": 90,
    "min_delta_ratio": 0.20,
    "strong_delta_ratio": 0.35,
    "min_volume_percentile": 70,
    "strong_volume_percentile": 85,
    "max_spread_atr_fraction": 0.10,
    "merge_distance_ticks": 3,
    "merge_distance_atr_fraction": 0.025,
    "signal_cooldown_bars": 3,
    "max_active_clusters": 2500,
    "max_removed_clusters": 1000,
    "max_zones_per_side": 5,
    "min_strength_to_draw": 70,
    "min_strength_to_alert": 75,
    "show_active_zones": True,
    "show_trigger_markers": True,
    "show_panel": True,
    "show_debug_series": False,
    "scanner_min_strength": 75,
    "required_lookback_bars": 20,
    "require_intrabar_for_strong": True,
}


BUY_CLUSTER_COLOR = "#1de9b6"
SELL_CLUSTER_COLOR = "#ff4df3"
BUY_ZONE_COLOR = "#0fbf9b"
SELL_ZONE_COLOR = "#d946ef"
EPSILON = 1e-12


@dataclass
class ClusterBucket:
    price: float
    volume: float
    created_at: int | float
    updated_at: int | float
    last_touched_at: int | float | None
    source_count: int
    aggressive_buy_volume: float = 0.0
    aggressive_sell_volume: float = 0.0
    delta: float = 0.0
    zone_low: float | None = None
    zone_high: float | None = None


@dataclass
class TriggeredCluster:
    side: str
    price: float
    volume: float
    timestamp: int | float
    strength_score: float
    delta: float
    delta_ratio: float
    zone_low: float
    zone_high: float


@dataclass
class IndicatorState:
    active_clusters: dict[int, ClusterBucket] = field(default_factory=dict)
    removed_clusters: list[TriggeredCluster] = field(default_factory=list)
    buy_stops_history: list[float] = field(default_factory=list)
    sell_stops_history: list[float] = field(default_factory=list)
    trigger_abs_history: list[float] = field(default_factory=list)
    volume_history: list[float] = field(default_factory=list)
    abs_delta_history: list[float] = field(default_factory=list)
    delta_ratio_history: list[float] = field(default_factory=list)
    true_range_history: list[float] = field(default_factory=list)
    atr_history: list[float] = field(default_factory=list)
    previous_close: float | None = None
    previous_high: float | None = None
    previous_low: float | None = None
    previous_ltf_close: float | None = None
    atr_14: float | None = None
    last_buy_signal_bar: int = -100000
    last_sell_signal_bar: int = -100000
    last_buy_signal_strength: float = 0.0
    last_sell_signal_strength: float = 0.0
    bar_index: int = -1


@dataclass
class IndicatorConfig:
    atr_length: int = 14
    sma_length: int = 50
    base_tf_minutes: float = 1.0
    projection_timeframes: tuple[float, ...] = (1, 5, 15, 30, 60, 240)
    projection_multipliers: tuple[float, ...] = (1.0, 1.5, 2.0)
    tick_size: float = 0.01
    grid_mode: str = "atr_quarter"
    use_bid_ask_enhancement: bool = True
    min_delta_percentile: float = 80.0
    strong_delta_percentile: float = 90.0
    min_delta_ratio: float = 0.20
    strong_delta_ratio: float = 0.35
    min_volume_percentile: float = 70.0
    strong_volume_percentile: float = 85.0
    max_spread_atr_fraction: float = 0.10
    merge_distance_ticks: int = 3
    merge_distance_atr_fraction: float = 0.025
    signal_cooldown_bars: int = 3
    max_active_clusters: int = 2500
    max_removed_clusters: int = 1000
    max_zones_per_side: int = 5
    min_strength_to_draw: float = 70.0
    min_strength_to_alert: float = 75.0
    show_active_zones: bool = True
    show_trigger_markers: bool = True
    show_panel: bool = True
    show_debug_series: bool = False
    scanner_min_strength: float = 75.0
    required_lookback_bars: int = 20
    require_intrabar_for_strong: bool = True


ALERT_CONDITIONS = [
    {
        "id": "strong_buy_stop_cluster_triggered",
        "name": "Strong Buy-Stop Cluster Triggered",
        "enabledByDefault": True,
        "message": (
            "{{symbol}} {{timeframe}} strong buy-stop cluster triggered at {{price}} "
            "volume={{cluster_volume}} delta={{delta}} delta_ratio={{delta_ratio}} score={{strength_score}}"
        ),
    },
    {
        "id": "strong_sell_stop_cluster_triggered",
        "name": "Strong Sell-Stop Cluster Triggered",
        "enabledByDefault": True,
        "message": (
            "{{symbol}} {{timeframe}} strong sell-stop cluster triggered at {{price}} "
            "volume={{cluster_volume}} delta={{delta}} delta_ratio={{delta_ratio}} score={{strength_score}}"
        ),
    },
    {
        "id": "monster_buy_liquidity_sweep",
        "name": "Monster Buy Liquidity Sweep",
        "enabledByDefault": True,
        "message": "{{symbol}} {{timeframe}} monster buy liquidity sweep score={{strength_score}} price={{price}}",
    },
    {
        "id": "monster_sell_liquidity_sweep",
        "name": "Monster Sell Liquidity Sweep",
        "enabledByDefault": True,
        "message": "{{symbol}} {{timeframe}} monster sell liquidity sweep score={{strength_score}} price={{price}}",
    },
    {
        "id": "price_near_strong_buy_cluster",
        "name": "Price Near Strong Buy Cluster",
        "enabledByDefault": False,
        "message": "{{symbol}} {{timeframe}} price near buy-stop cluster {{price}} volume={{cluster_volume}}",
    },
    {
        "id": "price_near_strong_sell_cluster",
        "name": "Price Near Strong Sell Cluster",
        "enabledByDefault": False,
        "message": "{{symbol}} {{timeframe}} price near sell-stop cluster {{price}} volume={{cluster_volume}}",
    },
]


SCANNER_FIELDS = [
    "symbol",
    "timeframe",
    "side",
    "trigger_type",
    "cluster_price",
    "cluster_volume",
    "strength_score",
    "active_liquidity_ratio",
    "bid_ask_delta",
    "delta_ratio",
    "distance_ticks",
    "distance_percent",
    "timestamp",
]


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def sign(value: float) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if isfinite(number) else default


def as_int_time(value: Any) -> int | float:
    number = as_float(value, 0.0)
    if abs(number - int(number)) < EPSILON:
        return int(number)
    return number


def sma(values: list[float], length: int) -> float:
    if not values:
        return 0.0
    window = values[-max(1, length):]
    return sum(window) / len(window)


def percentile_nearest_rank(values: list[float], percentile: float) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    pct = clamp(percentile, 0.0, 100.0)
    rank = max(1, int((pct / 100.0) * len(clean) + 0.999999))
    return clean[min(len(clean) - 1, rank - 1)]


def percentile_rank(value: float, values: list[float]) -> float:
    clean = sorted(item for item in values if isfinite(item))
    if not clean:
        return 0.0
    count = sum(1 for item in clean if item <= value)
    return count / len(clean)


def pine_signed_volume(volume: float, close: float, previous_close: float) -> float:
    return volume * sign(close - previous_close) * -1


def projection_factors(
    base_tf_minutes: float = 1.0,
    projection_timeframes: list[float] | tuple[float, ...] | None = None,
    projection_multipliers: list[float] | tuple[float, ...] | None = None,
) -> list[float]:
    base = max(EPSILON, float(base_tf_minutes))
    timeframes = projection_timeframes or (1, 5, 15, 30, 60, 240)
    multipliers = projection_multipliers or (1.0, 1.5, 2.0)
    return [sqrt(float(tf_minutes) / base) * float(multiplier) for tf_minutes in timeframes for multiplier in multipliers]


def projected_level(dom_point: float, atr_14: float, factor: float, signed_volume: float) -> float:
    return dom_point + atr_14 * factor * sign(signed_volume)


def config_from_params(params: dict[str, Any] | None) -> IndicatorConfig:
    merged = {**DEFAULT_PARAMS, **(params or {})}
    return IndicatorConfig(
        atr_length=max(1, int(merged["atr_length"])),
        sma_length=max(1, int(merged["sma_length"])),
        base_tf_minutes=max(EPSILON, as_float(merged["base_tf_minutes"], 1.0)),
        projection_timeframes=tuple(float(item) for item in merged["projection_timeframes"]),
        projection_multipliers=tuple(float(item) for item in merged["projection_multipliers"]),
        tick_size=max(EPSILON, as_float(merged["tick_size"], 0.01)),
        grid_mode=str(merged["grid_mode"]),
        use_bid_ask_enhancement=bool(merged["use_bid_ask_enhancement"]),
        min_delta_percentile=as_float(merged["min_delta_percentile"], 80.0),
        strong_delta_percentile=as_float(merged["strong_delta_percentile"], 90.0),
        min_delta_ratio=as_float(merged["min_delta_ratio"], 0.20),
        strong_delta_ratio=as_float(merged["strong_delta_ratio"], 0.35),
        min_volume_percentile=as_float(merged["min_volume_percentile"], 70.0),
        strong_volume_percentile=as_float(merged["strong_volume_percentile"], 85.0),
        max_spread_atr_fraction=as_float(merged["max_spread_atr_fraction"], 0.10),
        merge_distance_ticks=max(0, int(merged["merge_distance_ticks"])),
        merge_distance_atr_fraction=max(0.0, as_float(merged["merge_distance_atr_fraction"], 0.025)),
        signal_cooldown_bars=max(0, int(merged["signal_cooldown_bars"])),
        max_active_clusters=max(50, int(merged["max_active_clusters"])),
        max_removed_clusters=max(10, int(merged["max_removed_clusters"])),
        max_zones_per_side=max(1, int(merged["max_zones_per_side"])),
        min_strength_to_draw=as_float(merged["min_strength_to_draw"], 70.0),
        min_strength_to_alert=as_float(merged["min_strength_to_alert"], 75.0),
        show_active_zones=bool(merged["show_active_zones"]),
        show_trigger_markers=bool(merged["show_trigger_markers"]),
        show_panel=bool(merged["show_panel"]),
        show_debug_series=bool(merged["show_debug_series"]),
        scanner_min_strength=as_float(merged["scanner_min_strength"], 75.0),
        required_lookback_bars=max(0, int(merged["required_lookback_bars"])),
        require_intrabar_for_strong=bool(merged["require_intrabar_for_strong"]),
    )


class VolatilityAtEntryClusters:
    def __init__(self, config: IndicatorConfig | None = None):
        self.config = config or IndicatorConfig()
        self.state = IndicatorState()
        self.factors = projection_factors(
            self.config.base_tf_minutes,
            self.config.projection_timeframes,
            self.config.projection_multipliers,
        )

    def update(self, bar: dict[str, Any], intrabars: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        cfg = self.config
        st = self.state
        st.bar_index += 1

        timestamp = as_int_time(bar.get("time", st.bar_index))
        open_price = as_float(bar.get("open"), as_float(bar.get("close")))
        high = as_float(bar.get("high"), open_price)
        low = as_float(bar.get("low"), open_price)
        close = as_float(bar.get("close"), open_price)
        volume = max(0.0, as_float(bar.get("volume")))
        previous_close = st.previous_close if st.previous_close is not None else close
        atr_value = self._update_atr(bar, high, low, close, previous_close)
        grid_size = self._grid_size(atr_value)
        merge_distance = max(cfg.tick_size * cfg.merge_distance_ticks, atr_value * cfg.merge_distance_atr_fraction)
        spread = extract_spread(bar)
        had_intrabar_data = bool(intrabars)
        ltf_bars = intrabars if intrabars else [bar]

        buy_stops_hit = 0.0
        sell_stops_hit = 0.0
        removed_buy_stop_liquidity = 0.0
        removed_sell_stop_liquidity = 0.0
        triggered_this_bar: list[TriggeredCluster] = []
        aggressive_buy_volume = 0.0
        aggressive_sell_volume = 0.0
        bar_delta = 0.0
        max_delta_ratio = 0.0

        gap_low_high = self._gap_through_range(open_price)
        if gap_low_high:
            gap_triggered = self._remove_crossed_clusters(gap_low_high[0], gap_low_high[1], timestamp, merge_distance)
            triggered_this_bar.extend(gap_triggered)
            buy_stops_hit, sell_stops_hit, removed_buy_stop_liquidity, removed_sell_stop_liquidity = self._sum_triggered(
                gap_triggered,
                buy_stops_hit,
                sell_stops_hit,
                removed_buy_stop_liquidity,
                removed_sell_stop_liquidity,
            )

        for ltf in ltf_bars:
            ltf_time = as_int_time(ltf.get("time", timestamp))
            ltf_high = as_float(ltf.get("high"), high)
            ltf_low = as_float(ltf.get("low"), low)
            ltf_close = as_float(ltf.get("close"), close)
            ltf_volume = max(0.0, as_float(ltf.get("volume"), volume))
            ltf_atr = max(EPSILON, as_float(ltf.get("atr_14", ltf.get("atr", atr_value)), atr_value))
            ltf_dom_point = as_float(
                ltf.get("hlc3"),
                (as_float(ltf.get("high"), high) + as_float(ltf.get("low"), low) + ltf_close) / 3.0,
            )

            crossed = self._remove_crossed_clusters(ltf_low, ltf_high, ltf_time, merge_distance)
            triggered_this_bar.extend(crossed)
            buy_stops_hit, sell_stops_hit, removed_buy_stop_liquidity, removed_sell_stop_liquidity = self._sum_triggered(
                crossed,
                buy_stops_hit,
                sell_stops_hit,
                removed_buy_stop_liquidity,
                removed_sell_stop_liquidity,
            )

            prev_ltf_close = st.previous_ltf_close if st.previous_ltf_close is not None else previous_close
            signed_volume, bid_ask = self._signed_volume(ltf, ltf_volume, ltf_close, prev_ltf_close)
            st.previous_ltf_close = ltf_close
            aggressive_buy_volume += bid_ask["aggressive_buy_volume"]
            aggressive_sell_volume += bid_ask["aggressive_sell_volume"]
            bar_delta += bid_ask["delta"]
            max_delta_ratio = max(max_delta_ratio, bid_ask["delta_ratio"])

            if sign(signed_volume) == 0 or ltf_atr <= 0:
                continue

            volume_per_level = signed_volume / max(1, len(self.factors))
            for factor in self.factors:
                level = projected_level(ltf_dom_point, ltf_atr, factor, signed_volume)
                self._add_cluster(
                    level,
                    volume_per_level,
                    grid_size,
                    ltf_time,
                    bid_ask["aggressive_buy_volume"] / max(1, len(self.factors)),
                    bid_ask["aggressive_sell_volume"] / max(1, len(self.factors)),
                    bid_ask["delta"] / max(1, len(self.factors)),
                )

        st.volume_history.append(volume)
        st.abs_delta_history.append(abs(bar_delta))
        st.delta_ratio_history.append(max_delta_ratio)
        st.buy_stops_history.append(buy_stops_hit)
        st.sell_stops_history.append(sell_stops_hit)
        if triggered_this_bar:
            st.trigger_abs_history.extend(abs(item.volume) for item in triggered_this_bar)

        self._prune_active_clusters(close)
        buy_stops_avg_50 = sma(st.buy_stops_history, cfg.sma_length)
        sell_stops_avg_50 = sma(st.sell_stops_history, cfg.sma_length)
        buy_cluster_trigger_raw = buy_stops_hit <= buy_stops_avg_50
        sell_cluster_trigger_raw = sell_stops_hit >= sell_stops_avg_50

        zones = self._merged_active_zones(close, merge_distance)
        strong_zones = self._strong_active_zones(zones)
        nearest_buy = nearest_zone(strong_zones, close, "buy")
        nearest_sell = nearest_zone(strong_zones, close, "sell")
        active_buy_stop_liquidity = sum(abs(zone["volume"]) for zone in zones if zone["price"] < close)
        active_sell_stop_liquidity = sum(abs(zone["volume"]) for zone in zones if zone["price"] >= close)

        strongest_buy_trigger = strongest_trigger(triggered_this_bar, "buy")
        strongest_sell_trigger = strongest_trigger(triggered_this_bar, "sell")
        buy_strength_score = self._score_trigger(
            strongest_buy_trigger,
            bar,
            close,
            high,
            low,
            volume,
            atr_value,
            max_delta_ratio,
            abs(bar_delta),
            had_intrabar_data,
        )
        sell_strength_score = self._score_trigger(
            strongest_sell_trigger,
            bar,
            close,
            high,
            low,
            volume,
            atr_value,
            max_delta_ratio,
            abs(bar_delta),
            had_intrabar_data,
        )

        strong_buy_cluster_trigger = (
            strongest_buy_trigger is not None
            and buy_cluster_trigger_raw
            and self._passes_strong_filters(
                strongest_buy_trigger,
                "buy",
                buy_strength_score,
                bar,
                high,
                low,
                close,
                volume,
                atr_value,
                max_delta_ratio,
                abs(bar_delta),
                spread,
                had_intrabar_data,
            )
        )
        strong_sell_cluster_trigger = (
            strongest_sell_trigger is not None
            and sell_cluster_trigger_raw
            and self._passes_strong_filters(
                strongest_sell_trigger,
                "sell",
                sell_strength_score,
                bar,
                high,
                low,
                close,
                volume,
                atr_value,
                max_delta_ratio,
                abs(bar_delta),
                spread,
                had_intrabar_data,
            )
        )

        if strong_buy_cluster_trigger:
            strong_buy_cluster_trigger = self._passes_cooldown("buy", buy_strength_score)
        if strong_sell_cluster_trigger:
            strong_sell_cluster_trigger = self._passes_cooldown("sell", sell_strength_score)

        buy_liquidity_sweep = bool(
            strong_buy_cluster_trigger
            and strongest_buy_trigger
            and low <= strongest_buy_trigger.zone_high
            and close > (strongest_buy_trigger.zone_low + strongest_buy_trigger.zone_high) / 2.0
        )
        sell_liquidity_sweep = bool(
            strong_sell_cluster_trigger
            and strongest_sell_trigger
            and high >= strongest_sell_trigger.zone_low
            and close < (strongest_sell_trigger.zone_low + strongest_sell_trigger.zone_high) / 2.0
        )

        st.previous_close = close
        st.previous_high = high
        st.previous_low = low

        output = {
            "time": timestamp,
            "buy_stops_hit": buy_stops_hit,
            "sell_stops_hit": sell_stops_hit,
            "buy_stops_avg_50": buy_stops_avg_50,
            "sell_stops_avg_50": sell_stops_avg_50,
            "active_buy_stop_liquidity": active_buy_stop_liquidity,
            "active_sell_stop_liquidity": active_sell_stop_liquidity,
            "removed_buy_stop_liquidity": removed_buy_stop_liquidity,
            "removed_sell_stop_liquidity": removed_sell_stop_liquidity,
            "nearest_buy_stop_cluster_price": nearest_buy["price"] if nearest_buy else None,
            "nearest_sell_stop_cluster_price": nearest_sell["price"] if nearest_sell else None,
            "nearest_buy_stop_cluster_volume": abs(nearest_buy["volume"]) if nearest_buy else None,
            "nearest_sell_stop_cluster_volume": abs(nearest_sell["volume"]) if nearest_sell else None,
            "buy_cluster_strength_score": buy_strength_score,
            "sell_cluster_strength_score": sell_strength_score,
            "delta_ratio": max_delta_ratio,
            "aggressive_buy_volume": aggressive_buy_volume,
            "aggressive_sell_volume": aggressive_sell_volume,
            "bid_ask_delta": bar_delta,
            "buy_cluster_trigger_raw": buy_cluster_trigger_raw,
            "sell_cluster_trigger_raw": sell_cluster_trigger_raw,
            "strong_buy_cluster_trigger": strong_buy_cluster_trigger,
            "strong_sell_cluster_trigger": strong_sell_cluster_trigger,
            "buy_liquidity_sweep": buy_liquidity_sweep,
            "sell_liquidity_sweep": sell_liquidity_sweep,
            "strong_buy_liquidity_sweep": buy_liquidity_sweep and buy_strength_score >= cfg.min_strength_to_alert,
            "strong_sell_liquidity_sweep": sell_liquidity_sweep and sell_strength_score >= cfg.min_strength_to_alert,
            "aggressive_bid_cluster": strong_buy_cluster_trigger and bar_delta < 0,
            "aggressive_ask_cluster": strong_sell_cluster_trigger and bar_delta > 0,
            "active_zones": drawable_zones(strong_zones, close, cfg),
            "triggered_clusters": [trigger_to_dict(item) for item in triggered_this_bar],
            "scanner": self._scanner_record(
                timestamp,
                bar,
                close,
                active_buy_stop_liquidity,
                active_sell_stop_liquidity,
                nearest_buy,
                nearest_sell,
                strongest_buy_trigger,
                strongest_sell_trigger,
                buy_strength_score,
                sell_strength_score,
                strong_buy_cluster_trigger,
                strong_sell_cluster_trigger,
                max_delta_ratio,
                bar_delta,
            ),
        }
        return output

    def _signed_volume(self, bar: dict[str, Any], volume: float, close: float, previous_close: float) -> tuple[float, dict[str, float]]:
        bid_ask = extract_executed_bid_ask(bar)
        if self.config.use_bid_ask_enhancement and bid_ask is not None:
            aggressive_buy_volume, aggressive_sell_volume = bid_ask
            delta = aggressive_buy_volume - aggressive_sell_volume
            total_exec_volume = aggressive_buy_volume + aggressive_sell_volume
            delta_ratio = abs(delta) / max(total_exec_volume, EPSILON)
            return -delta, {
                "aggressive_buy_volume": aggressive_buy_volume,
                "aggressive_sell_volume": aggressive_sell_volume,
                "delta": delta,
                "delta_ratio": delta_ratio,
                "bid_ask_available": 1.0,
            }

        signed = pine_signed_volume(volume, close, previous_close)
        return signed, {
            "aggressive_buy_volume": 0.0,
            "aggressive_sell_volume": 0.0,
            "delta": -signed,
            "delta_ratio": 0.0,
            "bid_ask_available": 0.0,
        }

    def _update_atr(self, bar: dict[str, Any], high: float, low: float, close: float, previous_close: float) -> float:
        explicit = bar.get("atr_14", bar.get("atr"))
        true_range = max(high - low, abs(high - previous_close), abs(low - previous_close), close * 0.00001, EPSILON)
        self.state.true_range_history.append(true_range)
        if explicit is not None:
            atr_value = max(EPSILON, as_float(explicit, true_range))
            self.state.atr_14 = atr_value
            self.state.atr_history.append(atr_value)
            return atr_value

        length = self.config.atr_length
        if self.state.atr_14 is None:
            atr_value = sma(self.state.true_range_history, length)
        else:
            atr_value = (self.state.atr_14 * (length - 1) + true_range) / length
        self.state.atr_14 = max(EPSILON, atr_value)
        self.state.atr_history.append(self.state.atr_14)
        return self.state.atr_14

    def _grid_size(self, atr_value: float) -> float:
        cfg = self.config
        if cfg.grid_mode == "tick":
            return cfg.tick_size
        atr_quarter = max(cfg.tick_size, sma(self.state.atr_history, 50) / 4.0)
        if cfg.grid_mode == "auto":
            return max(cfg.tick_size, atr_quarter)
        return atr_quarter

    def _add_cluster(
        self,
        projected_price: float,
        volume: float,
        grid_size: float,
        timestamp: int | float,
        aggressive_buy_volume: float,
        aggressive_sell_volume: float,
        delta: float,
    ) -> None:
        key = int(floor(projected_price / max(grid_size, EPSILON)))
        bucket_price = key * grid_size
        existing = self.state.active_clusters.get(key)
        half = grid_size / 2.0
        if existing is None:
            self.state.active_clusters[key] = ClusterBucket(
                price=bucket_price,
                volume=volume,
                created_at=timestamp,
                updated_at=timestamp,
                last_touched_at=None,
                source_count=1,
                aggressive_buy_volume=aggressive_buy_volume,
                aggressive_sell_volume=aggressive_sell_volume,
                delta=delta,
                zone_low=bucket_price - half,
                zone_high=bucket_price + half,
            )
            return

        previous_weight = abs(existing.volume)
        next_weight = abs(volume)
        total_weight = previous_weight + next_weight
        if total_weight > EPSILON:
            existing.price = (existing.price * previous_weight + bucket_price * next_weight) / total_weight
        existing.volume += volume
        existing.updated_at = timestamp
        existing.source_count += 1
        existing.aggressive_buy_volume += aggressive_buy_volume
        existing.aggressive_sell_volume += aggressive_sell_volume
        existing.delta += delta
        existing.zone_low = min(existing.zone_low if existing.zone_low is not None else bucket_price, bucket_price - half)
        existing.zone_high = max(existing.zone_high if existing.zone_high is not None else bucket_price, bucket_price + half)

    def _remove_crossed_clusters(
        self,
        low: float,
        high: float,
        timestamp: int | float,
        merge_distance: float,
    ) -> list[TriggeredCluster]:
        lower = min(low, high)
        upper = max(low, high)
        removed: list[TriggeredCluster] = []
        for key, cluster in list(self.state.active_clusters.items()):
            zone_low = cluster.zone_low if cluster.zone_low is not None else cluster.price - merge_distance
            zone_high = cluster.zone_high if cluster.zone_high is not None else cluster.price + merge_distance
            if max(lower, zone_low) <= min(upper, zone_high):
                side = "buy" if sign(cluster.volume) == -1 else "sell" if sign(cluster.volume) == 1 else "neutral"
                triggered = TriggeredCluster(
                    side=side,
                    price=cluster.price,
                    volume=cluster.volume,
                    timestamp=timestamp,
                    strength_score=0.0,
                    delta=cluster.delta,
                    delta_ratio=abs(cluster.delta) / max(
                        cluster.aggressive_buy_volume + cluster.aggressive_sell_volume,
                        EPSILON,
                    ),
                    zone_low=zone_low,
                    zone_high=zone_high,
                )
                removed.append(triggered)
                self.state.removed_clusters.append(triggered)
                del self.state.active_clusters[key]

        if len(self.state.removed_clusters) > self.config.max_removed_clusters:
            self.state.removed_clusters = self.state.removed_clusters[-self.config.max_removed_clusters:]
        return removed

    def _sum_triggered(
        self,
        triggered: list[TriggeredCluster],
        buy_stops_hit: float,
        sell_stops_hit: float,
        removed_buy_stop_liquidity: float,
        removed_sell_stop_liquidity: float,
    ) -> tuple[float, float, float, float]:
        for item in triggered:
            direction = sign(item.volume)
            if direction == -1:
                buy_stops_hit += item.volume
                removed_buy_stop_liquidity += item.volume
            elif direction == 1:
                sell_stops_hit += item.volume
                removed_sell_stop_liquidity += item.volume
        return buy_stops_hit, sell_stops_hit, removed_buy_stop_liquidity, removed_sell_stop_liquidity

    def _gap_through_range(self, open_price: float) -> tuple[float, float] | None:
        if self.state.previous_high is None or self.state.previous_low is None:
            return None
        if open_price > self.state.previous_high:
            return self.state.previous_high, open_price
        if open_price < self.state.previous_low:
            return open_price, self.state.previous_low
        return None

    def _prune_active_clusters(self, current_price: float) -> None:
        max_active = self.config.max_active_clusters
        clusters = self.state.active_clusters
        if len(clusters) <= max_active:
            return

        strongest_keys = {
            key
            for key, _cluster in sorted(clusters.items(), key=lambda item: abs(item[1].volume), reverse=True)[:40]
        }
        removable = [
            (abs(cluster.price - current_price), key)
            for key, cluster in clusters.items()
            if key not in strongest_keys
        ]
        removable.sort(reverse=True)
        for _distance, key in removable[: max(0, len(clusters) - max_active)]:
            clusters.pop(key, None)

    def _merged_active_zones(self, current_price: float, merge_distance: float) -> list[dict[str, Any]]:
        clusters = sorted(self.state.active_clusters.values(), key=lambda item: item.price)
        zones: list[dict[str, Any]] = []
        for cluster in clusters:
            if abs(cluster.volume) <= EPSILON:
                continue
            zone_low = cluster.zone_low if cluster.zone_low is not None else cluster.price - merge_distance
            zone_high = cluster.zone_high if cluster.zone_high is not None else cluster.price + merge_distance
            if zones and zone_low <= zones[-1]["high"] + merge_distance:
                zone = zones[-1]
                old_weight = abs(zone["volume"])
                new_weight = abs(cluster.volume)
                total_weight = old_weight + new_weight
                if total_weight > EPSILON:
                    zone["price"] = (zone["price"] * old_weight + cluster.price * new_weight) / total_weight
                zone["volume"] += cluster.volume
                zone["low"] = min(zone["low"], zone_low)
                zone["high"] = max(zone["high"], zone_high)
                zone["source_count"] += cluster.source_count
                zone["delta"] += cluster.delta
                zone["aggressive_buy_volume"] += cluster.aggressive_buy_volume
                zone["aggressive_sell_volume"] += cluster.aggressive_sell_volume
            else:
                zones.append(
                    {
                        "price": cluster.price,
                        "low": zone_low,
                        "high": zone_high,
                        "volume": cluster.volume,
                        "side": "buy" if cluster.price < current_price else "sell",
                        "source_count": cluster.source_count,
                        "created_at": cluster.created_at,
                        "updated_at": cluster.updated_at,
                        "delta": cluster.delta,
                        "aggressive_buy_volume": cluster.aggressive_buy_volume,
                        "aggressive_sell_volume": cluster.aggressive_sell_volume,
                    }
                )

        for zone in zones:
            zone["side"] = "buy" if zone["price"] < current_price else "sell"
        return zones

    def _strong_active_zones(self, zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not zones:
            return []
        volumes = [abs(zone["volume"]) for zone in zones]
        p95_active_volume = percentile_nearest_rank(volumes, 95)
        top_n = sorted(volumes, reverse=True)[: self.config.max_zones_per_side]
        hot_threshold = min(top_n) if top_n else p95_active_volume
        strong: list[dict[str, Any]] = []
        for zone in zones:
            abs_volume = abs(zone["volume"])
            if abs_volume >= hot_threshold and abs_volume >= p95_active_volume:
                next_zone = {**zone}
                next_zone["strength"] = clamp(percentile_rank(abs_volume, volumes), 0.0, 1.0)
                strong.append(next_zone)
        return strong

    def _score_trigger(
        self,
        trigger: TriggeredCluster | None,
        bar: dict[str, Any],
        close: float,
        high: float,
        low: float,
        volume: float,
        atr_value: float,
        delta_ratio: float,
        abs_delta: float,
        had_intrabar_data: bool,
    ) -> float:
        if trigger is None:
            return 0.0

        trigger_abs = abs(trigger.volume)
        trigger_history = self.state.trigger_abs_history or [trigger_abs]
        cluster_size_score = 30.0 * percentile_rank(trigger_abs, trigger_history + [trigger_abs])
        delta_percentile_score = percentile_rank(abs_delta, self.state.abs_delta_history + [abs_delta])
        delta_ratio_score = clamp(delta_ratio / max(self.config.strong_delta_ratio, EPSILON), 0.0, 1.0)
        delta_score = 25.0 * (delta_percentile_score * 0.58 + delta_ratio_score * 0.42)
        distance = abs(close - trigger.price)
        proximity_score = 15.0 * (1.0 - clamp(distance / max(atr_value * 3.0, EPSILON), 0.0, 1.0))
        bar_range = max(high - low, EPSILON)
        atr_expansion = atr_value / max(sma(self.state.atr_history[:-1], 50) or atr_value, EPSILON)
        volatility_score = 15.0 * clamp((bar_range / max(atr_value, EPSILON)) * 0.55 + atr_expansion * 0.30, 0.0, 1.0)
        confirmations = self._confirmation_count(trigger, bar, high, low, close, volume, atr_value, delta_ratio, abs_delta)
        confirmation_score = min(15.0, confirmations * 7.5)

        if self.config.require_intrabar_for_strong and not had_intrabar_data:
            confirmation_score *= 0.35

        return clamp(cluster_size_score + delta_score + proximity_score + volatility_score + confirmation_score, 0.0, 100.0)

    def _confirmation_count(
        self,
        trigger: TriggeredCluster,
        _bar: dict[str, Any],
        high: float,
        low: float,
        close: float,
        volume: float,
        atr_value: float,
        delta_ratio: float,
        abs_delta: float,
    ) -> int:
        confirmations = 0
        trigger_abs = abs(trigger.volume)
        if trigger_abs >= percentile_nearest_rank(self.state.trigger_abs_history + [trigger_abs], 90):
            confirmations += 1
        if delta_ratio >= self.config.strong_delta_ratio:
            confirmations += 1
        if high - low >= atr_value * 0.8:
            confirmations += 1
        if volume >= percentile_nearest_rank(self.state.volume_history + [volume], self.config.strong_volume_percentile):
            confirmations += 1
        midpoint = (trigger.zone_low + trigger.zone_high) / 2.0
        if trigger.side == "sell" and high >= trigger.zone_low and close < midpoint:
            confirmations += 1
        if trigger.side == "buy" and low <= trigger.zone_high and close > midpoint:
            confirmations += 1
        if abs_delta >= percentile_nearest_rank(self.state.abs_delta_history + [abs_delta], self.config.strong_delta_percentile):
            confirmations += 1
        return confirmations

    def _passes_strong_filters(
        self,
        trigger: TriggeredCluster,
        side: str,
        strength_score: float,
        _bar: dict[str, Any],
        high: float,
        low: float,
        close: float,
        volume: float,
        atr_value: float,
        delta_ratio: float,
        abs_delta: float,
        spread: float | None,
        had_intrabar_data: bool,
    ) -> bool:
        cfg = self.config
        if strength_score < cfg.min_strength_to_draw:
            return False
        if cfg.require_intrabar_for_strong and not had_intrabar_data:
            return False
        if st_len(self.state.buy_stops_history) < cfg.required_lookback_bars:
            return False
        if len(self.state.active_clusters) < 1:
            return False
        if spread is not None and spread > atr_value * cfg.max_spread_atr_fraction:
            return False

        volume_floor = percentile_nearest_rank(self.state.volume_history + [volume], cfg.min_volume_percentile)
        if len(self.state.volume_history) >= cfg.required_lookback_bars and volume < volume_floor * 0.10:
            return False

        trigger_abs = abs(trigger.volume)
        strong_trigger_threshold = percentile_nearest_rank(self.state.trigger_abs_history + [trigger_abs], 85)
        strong_delta_threshold = percentile_nearest_rank(self.state.abs_delta_history + [abs_delta], cfg.strong_delta_percentile)
        if trigger_abs < strong_trigger_threshold and abs_delta < strong_delta_threshold:
            return False

        if delta_ratio < cfg.min_delta_ratio and abs_delta > EPSILON:
            return False

        confirmations = self._confirmation_count(trigger, {}, high, low, close, volume, atr_value, delta_ratio, abs_delta)
        if confirmations < 2:
            return False
        return trigger.side == side

    def _passes_cooldown(self, side: str, strength_score: float) -> bool:
        cfg = self.config
        st = self.state
        if side == "buy":
            bars_since = st.bar_index - st.last_buy_signal_bar
            if bars_since <= cfg.signal_cooldown_bars and strength_score < st.last_buy_signal_strength * 1.5:
                return False
            st.last_buy_signal_bar = st.bar_index
            st.last_buy_signal_strength = strength_score
            return True

        bars_since = st.bar_index - st.last_sell_signal_bar
        if bars_since <= cfg.signal_cooldown_bars and strength_score < st.last_sell_signal_strength * 1.5:
            return False
        st.last_sell_signal_bar = st.bar_index
        st.last_sell_signal_strength = strength_score
        return True

    def _scanner_record(
        self,
        timestamp: int | float,
        bar: dict[str, Any],
        close: float,
        active_buy_liquidity: float,
        active_sell_liquidity: float,
        nearest_buy: dict[str, Any] | None,
        nearest_sell: dict[str, Any] | None,
        strongest_buy_trigger: TriggeredCluster | None,
        strongest_sell_trigger: TriggeredCluster | None,
        buy_strength_score: float,
        sell_strength_score: float,
        strong_buy_cluster_trigger: bool,
        strong_sell_cluster_trigger: bool,
        delta_ratio: float,
        delta: float,
    ) -> dict[str, Any] | None:
        symbol = str(bar.get("symbol", ""))
        timeframe = str(bar.get("timeframe", ""))
        total_active = active_buy_liquidity + active_sell_liquidity
        active_ratio = active_buy_liquidity / max(total_active, EPSILON)

        if strong_buy_cluster_trigger and strongest_buy_trigger and buy_strength_score >= self.config.scanner_min_strength:
            return scanner_record(
                symbol,
                timeframe,
                "buy",
                "strong_buy_cluster_trigger",
                strongest_buy_trigger.price,
                strongest_buy_trigger.volume,
                buy_strength_score,
                active_ratio,
                delta,
                delta_ratio,
                close,
                self.config.tick_size,
                timestamp,
            )
        if strong_sell_cluster_trigger and strongest_sell_trigger and sell_strength_score >= self.config.scanner_min_strength:
            return scanner_record(
                symbol,
                timeframe,
                "sell",
                "strong_sell_cluster_trigger",
                strongest_sell_trigger.price,
                strongest_sell_trigger.volume,
                sell_strength_score,
                active_ratio,
                delta,
                delta_ratio,
                close,
                self.config.tick_size,
                timestamp,
            )

        near_buy = nearest_buy and abs(nearest_buy["price"] - close) <= self.config.tick_size * 20
        near_sell = nearest_sell and abs(nearest_sell["price"] - close) <= self.config.tick_size * 20
        if near_buy:
            return scanner_record(
                symbol,
                timeframe,
                "buy",
                "price_near_strong_buy_cluster",
                nearest_buy["price"],
                nearest_buy["volume"],
                nearest_buy.get("strength", 0.0) * 100.0,
                active_ratio,
                delta,
                delta_ratio,
                close,
                self.config.tick_size,
                timestamp,
            )
        if near_sell:
            return scanner_record(
                symbol,
                timeframe,
                "sell",
                "price_near_strong_sell_cluster",
                nearest_sell["price"],
                nearest_sell["volume"],
                nearest_sell.get("strength", 0.0) * 100.0,
                active_ratio,
                delta,
                delta_ratio,
                close,
                self.config.tick_size,
                timestamp,
            )
        return None


def st_len(values: list[Any]) -> int:
    return len(values)


def extract_executed_bid_ask(bar: dict[str, Any]) -> tuple[float, float] | None:
    ask_aliases = (
        "ask_traded_volume",
        "askTradedVolume",
        "aggressive_buy_volume",
        "aggressiveBuyVolume",
        "buy_volume_at_ask",
        "buyVolumeAtAsk",
        "volume_at_ask",
        "volumeAtAsk",
        "taker_buy_volume",
        "takerBuyVolume",
    )
    bid_aliases = (
        "bid_traded_volume",
        "bidTradedVolume",
        "aggressive_sell_volume",
        "aggressiveSellVolume",
        "sell_volume_at_bid",
        "sellVolumeAtBid",
        "volume_at_bid",
        "volumeAtBid",
        "taker_sell_volume",
        "takerSellVolume",
    )
    ask_volume = first_present_float(bar, ask_aliases)
    bid_volume = first_present_float(bar, bid_aliases)
    if ask_volume is None or bid_volume is None:
        return None
    return max(0.0, ask_volume), max(0.0, bid_volume)


def first_present_float(data: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        if key in data:
            return as_float(data[key])
    return None


def extract_spread(bar: dict[str, Any]) -> float | None:
    if "spread" in bar:
        return max(0.0, as_float(bar["spread"]))
    bid_price = first_present_float(bar, ("bid_price", "bidPrice", "best_bid", "bestBid"))
    ask_price = first_present_float(bar, ("ask_price", "askPrice", "best_ask", "bestAsk"))
    if bid_price is None or ask_price is None:
        return None
    return max(0.0, ask_price - bid_price)


def strongest_trigger(triggers: list[TriggeredCluster], side: str) -> TriggeredCluster | None:
    filtered = [item for item in triggers if item.side == side]
    if not filtered:
        return None
    return max(filtered, key=lambda item: abs(item.volume))


def nearest_zone(zones: list[dict[str, Any]], close: float, side: str) -> dict[str, Any] | None:
    if side == "buy":
        below = [zone for zone in zones if zone["price"] < close]
        return max(below, key=lambda item: item["price"]) if below else None
    above = [zone for zone in zones if zone["price"] >= close]
    return min(above, key=lambda item: item["price"]) if above else None


def drawable_zones(zones: list[dict[str, Any]], close: float, cfg: IndicatorConfig) -> list[dict[str, Any]]:
    if not cfg.show_active_zones:
        return []
    below = sorted((zone for zone in zones if zone["price"] < close), key=lambda item: item["price"], reverse=True)
    above = sorted((zone for zone in zones if zone["price"] >= close), key=lambda item: item["price"])
    selected = below[: cfg.max_zones_per_side] + above[: cfg.max_zones_per_side]
    out: list[dict[str, Any]] = []
    for zone in selected:
        strength_100 = clamp(zone.get("strength", 0.0) * 100.0, 0.0, 100.0)
        if strength_100 < cfg.min_strength_to_draw:
            continue
        side = "support" if zone["price"] < close else "resistance"
        out.append(
            {
                "id": f"vae_cluster_{side}_{round(zone['price'], 8)}",
                "startTime": zone.get("created_at", 0),
                "endTime": zone.get("updated_at", 0),
                "priceLow": zone["low"],
                "priceHigh": zone["high"],
                "strength": strength_100 / 100.0,
                "side": side,
                "color": BUY_ZONE_COLOR if side == "support" else SELL_ZONE_COLOR,
                "volume": zone["volume"],
            }
        )
    return out


def trigger_to_dict(trigger: TriggeredCluster) -> dict[str, Any]:
    return {
        "side": trigger.side,
        "price": trigger.price,
        "volume": trigger.volume,
        "timestamp": trigger.timestamp,
        "strength_score": trigger.strength_score,
        "delta": trigger.delta,
        "delta_ratio": trigger.delta_ratio,
        "zone_low": trigger.zone_low,
        "zone_high": trigger.zone_high,
    }


def scanner_record(
    symbol: str,
    timeframe: str,
    side: str,
    trigger_type: str,
    cluster_price: float,
    cluster_volume: float,
    strength_score: float,
    active_liquidity_ratio: float,
    delta: float,
    delta_ratio: float,
    close: float,
    tick_size: float,
    timestamp: int | float,
) -> dict[str, Any]:
    distance = abs(close - cluster_price)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "side": side,
        "trigger_type": trigger_type,
        "cluster_price": cluster_price,
        "cluster_volume": cluster_volume,
        "strength_score": strength_score,
        "active_liquidity_ratio": active_liquidity_ratio,
        "bid_ask_delta": delta,
        "delta_ratio": delta_ratio,
        "distance_ticks": distance / max(tick_size, EPSILON),
        "distance_percent": distance / max(abs(close), EPSILON) * 100.0,
        "timestamp": timestamp,
    }


def resolve_intrabars(input_data: dict[str, Any], candle: dict[str, Any], index: int) -> list[dict[str, Any]] | None:
    if isinstance(candle.get("intrabars"), list):
        return candle["intrabars"]

    candidates = (
        input_data.get("lower_timeframe_bars"),
        input_data.get("lowerTimeframeBars"),
        input_data.get("intrabars"),
        input_data.get("intraBars"),
    )
    for source in candidates:
        if isinstance(source, dict):
            time_key = candle.get("time")
            keyed = source.get(time_key, source.get(str(time_key)))
            if isinstance(keyed, list):
                return keyed
        if isinstance(source, list):
            if len(source) == 0:
                continue
            if index < len(source) and isinstance(source[index], list):
                return source[index]
            if all(isinstance(item, dict) for item in source):
                return source
    return None


def output_point(candle: dict[str, Any], value: float | int | bool | None) -> dict[str, Any]:
    if isinstance(value, bool):
        number: float | None = 1.0 if value else 0.0
    elif value is None:
        number = None
    else:
        number = as_float(value)
    return {"time": candle["time"], "value": number}


def make_plots(candles: list[dict[str, Any]], series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    plot_specs = [
        ("buy_stops_hit", "Buy Stops Hit", "histogram", BUY_CLUSTER_COLOR),
        ("sell_stops_hit", "Sell Stops Hit", "histogram", SELL_CLUSTER_COLOR),
        ("buy_stops_avg_50", "Buy Stops SMA 50", "line", BUY_CLUSTER_COLOR),
        ("sell_stops_avg_50", "Sell Stops SMA 50", "line", SELL_CLUSTER_COLOR),
        ("nearest_buy_stop_cluster_price", "Nearest Buy-Stop Cluster", "line", BUY_CLUSTER_COLOR),
        ("nearest_sell_stop_cluster_price", "Nearest Sell-Stop Cluster", "line", SELL_CLUSTER_COLOR),
        ("buy_cluster_strength_score", "Buy Cluster Strength", "histogram", BUY_CLUSTER_COLOR),
        ("sell_cluster_strength_score", "Sell Cluster Strength", "histogram", SELL_CLUSTER_COLOR),
    ]
    plots = []
    for field, name, kind, color in plot_specs:
        plots.append(
            {
                "id": field,
                "name": name,
                "kind": kind,
                "color": color,
                "points": [output_point(candle, item.get(field)) for candle, item in zip(candles, series)],
            }
        )
    return plots


def build_signals(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []
    for item in series:
        if item["strong_buy_cluster_trigger"]:
            price = item.get("nearest_buy_stop_cluster_price")
            signals.append(
                {
                    "time": item["time"],
                    "name": "Strong Buy-Stop Cluster Triggered",
                    "direction": "bullish",
                    "price": price,
                    "message": f"strength={item['buy_cluster_strength_score']:.1f}",
                }
            )
        if item["strong_sell_cluster_trigger"]:
            price = item.get("nearest_sell_stop_cluster_price")
            signals.append(
                {
                    "time": item["time"],
                    "name": "Strong Sell-Stop Cluster Triggered",
                    "direction": "bearish",
                    "price": price,
                    "message": f"strength={item['sell_cluster_strength_score']:.1f}",
                }
            )
    return signals


def build_alerts(input_data: dict[str, Any], series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    symbol = str(input_data.get("symbol", ""))
    timeframe = str(input_data.get("timeframe", ""))
    alerts: list[dict[str, Any]] = []
    if not series:
        return alerts
    item = series[-1]
    alert_contexts = [
        ("strong_buy_stop_cluster_triggered", item["strong_buy_cluster_trigger"], "buy", item.get("nearest_buy_stop_cluster_price"), item["buy_cluster_strength_score"]),
        ("strong_sell_stop_cluster_triggered", item["strong_sell_cluster_trigger"], "sell", item.get("nearest_sell_stop_cluster_price"), item["sell_cluster_strength_score"]),
        ("monster_buy_liquidity_sweep", item["buy_liquidity_sweep"] and item["buy_cluster_strength_score"] >= 85, "buy", item.get("nearest_buy_stop_cluster_price"), item["buy_cluster_strength_score"]),
        ("monster_sell_liquidity_sweep", item["sell_liquidity_sweep"] and item["sell_cluster_strength_score"] >= 85, "sell", item.get("nearest_sell_stop_cluster_price"), item["sell_cluster_strength_score"]),
    ]
    for alert_id, enabled, side, price, score in alert_contexts:
        if not enabled:
            continue
        alerts.append(
            {
                "id": alert_id,
                "symbol": symbol,
                "timeframe": timeframe,
                "side": side,
                "price": price,
                "cluster_volume": item.get(f"nearest_{side}_stop_cluster_volume"),
                "delta": item["bid_ask_delta"],
                "delta_ratio": item["delta_ratio"],
                "strength_score": score,
                "timestamp": item["time"],
            }
        )
    return alerts


def metadata() -> dict[str, Any]:
    return {
        "id": "volatility_at_entry_clusters",
        "name": "Volatility-At-Entry Clusters",
        "runtime": "python",
        "version": "1.0.0",
        "author": "BLACK-TERMINAL",
        "description": (
            "Pine-compatible Volatility-At-Entry stop-cluster model with optional bid/ask aggression filters, "
            "strong cluster scoring, alerts, and scanner fields."
        ),
        "defaultParams": DEFAULT_PARAMS,
        "alertConditions": ALERT_CONDITIONS,
        "scanner": {
            "preset": "Volatility Entry Beast Clusters",
            "fields": SCANNER_FIELDS,
            "defaultRules": {
                "strength_score": {">=": 75},
                "abs_delta_ratio": {">=": 0.25},
                "volume_percentile": {">=": 70},
                "cooldown_bars": 3,
            },
        },
    }


def run(input_data: dict[str, Any]) -> dict[str, Any]:
    candles = input_data.get("candles", [])[-10000:]
    params = {
        **input_data.get("params", {}),
        "tick_size": input_data.get("tick_size", input_data.get("tickSize", input_data.get("params", {}).get("tick_size", DEFAULT_PARAMS["tick_size"]))),
    }
    config = config_from_params(params)

    if len(candles) < 2:
        return {
            "plots": [],
            "zones": [],
            "signals": [],
            "series": [],
            "alerts": [],
            "alert_conditions": ALERT_CONDITIONS,
            "scanner": {"preset": "Volatility Entry Beast Clusters", "fields": SCANNER_FIELDS, "records": []},
            "diagnostics": ["Not enough candles for Volatility-At-Entry Clusters."],
            "metadata": metadata(),
        }

    engine = VolatilityAtEntryClusters(config)
    series: list[dict[str, Any]] = []
    all_zones: list[dict[str, Any]] = []

    for index, candle in enumerate(candles):
        enriched = {
            **candle,
            "symbol": input_data.get("symbol", candle.get("symbol", "")),
            "timeframe": input_data.get("timeframe", candle.get("timeframe", "")),
        }
        output = engine.update(enriched, resolve_intrabars(input_data, candle, index))
        series.append(output)
        all_zones = output["active_zones"]

    scanner_records = [item["scanner"] for item in series if item.get("scanner")]
    return {
        "plots": make_plots(candles, series),
        "zones": all_zones,
        "signals": build_signals(series),
        "series": series,
        "panel": series[-1] if config.show_panel else None,
        "alerts": build_alerts(input_data, series),
        "alert_conditions": ALERT_CONDITIONS,
        "scanner": {
            "preset": "Volatility Entry Beast Clusters",
            "fields": SCANNER_FIELDS,
            "records": scanner_records,
        },
        "diagnostics": [
            "Volatility-At-Entry Clusters: req()/timeScaled() compatibility mode preserved; "
            "bid/ask enhancement uses executed ask/bid volume when present and falls back to Pine signed volume."
        ],
        "metadata": metadata(),
    }
