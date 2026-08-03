from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

AggressorSide = Literal["BUY", "SELL", "UNKNOWN"]
AggressorSource = Literal["EXCHANGE_AGGRESSOR_FLAG", "MAKER_SIDE_INVERSION", "QUOTE_RULE", "TICK_RULE", "INFERRED"]


@dataclass(frozen=True)
class ProfileRequest:
    symbol: str
    venue: str
    start_ms: int
    end_ms: int
    engine: str
    scope: str
    row_size: float | None
    target_rows: int
    value_area_fraction: float
    settings_version: str


@dataclass(frozen=True)
class CanonicalTrade:
    venue: str
    symbol: str
    timestamp_ms: int
    trade_id: str
    price: float
    quantity: float
    aggressor_side: AggressorSide
    source: AggressorSource

    @property
    def notional(self) -> float:
        return self.price * self.quantity


@dataclass(frozen=True)
class OHLCVBar:
    timestamp_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class ProfileDataQuality:
    exact_trade_coverage_percent: float
    lower_timeframe_coverage_percent: float
    chart_bar_coverage_percent: float
    unknown_aggressor_percent: float
    quality: str
    source_mix: list[str] = field(default_factory=list)


@dataclass
class NodeZone:
    kind: Literal["LVN", "HVN"]
    low: float
    high: float
    center: float
    score: float
    prominence: float


@dataclass
class AuctionProfileSnapshot:
    profile_id: str
    profile_version: str
    engine: str
    scope: str
    start_ms: int
    end_ms: int
    row_low: list[float]
    row_high: list[float]
    values: list[float]
    buy_values: list[float]
    sell_values: list[float]
    total_values: list[float]
    poc_index: int | None
    vah_index: int | None
    val_index: int | None
    lvn_zones: list[NodeZone]
    hvn_zones: list[NodeZone]
    quality: ProfileDataQuality

    def to_dict(self) -> dict:
        return asdict(self)
