from __future__ import annotations

import hashlib
import json

from .cvd_engine import aggregate_cvd
from .models import AuctionProfileSnapshot, CanonicalTrade, OHLCVBar, ProfileDataQuality, ProfileRequest
from .node_detection import detect_nodes
from .parkinson_engine import aggregate_parkinson
from .price_grid import build_grid
from .tpo_engine import aggregate_tpo
from .value_area import value_area
from .volatility_engine import aggregate_realized_volatility
from .volume_engine import aggregate_volume


def _quality(trades: list[CanonicalTrade], bars: list[OHLCVBar]) -> ProfileDataQuality:
    total = sum(trade.quantity for trade in trades)
    exact = sum(trade.quantity for trade in trades if trade.source in {"EXCHANGE_AGGRESSOR_FLAG", "MAKER_SIDE_INVERSION"})
    unknown = sum(trade.quantity for trade in trades if trade.aggressor_side == "UNKNOWN")
    percent = exact / total * 100 if total else 0.0
    quality = "EXACT" if percent >= 99 else "HIGH" if percent >= 80 else "MIXED" if percent else "APPROXIMATE" if bars else "INSUFFICIENT"
    return ProfileDataQuality(percent, 0.0, max(0.0, 100 - percent) if bars else 0.0, unknown / total * 100 if total else 0.0, quality, ["HISTORICAL_TRADE_ARCHIVE"] if trades else ["CHART_BARS"])


def build_profile(request: ProfileRequest, trades: list[CanonicalTrade], bars: list[OHLCVBar]) -> AuctionProfileSnapshot:
    scoped_trades = [trade for trade in trades if request.start_ms <= trade.timestamp_ms <= request.end_ms]
    scoped_bars = [bar for bar in bars if request.start_ms <= bar.timestamp_ms <= request.end_ms]
    prices = [trade.price for trade in scoped_trades] or [price for bar in scoped_bars for price in (bar.low, bar.high)]
    grid = build_grid(prices, request.row_size, request.target_rows)
    cvd, buy, sell, unknown = aggregate_cvd(scoped_trades, grid)
    total = [left + right + other for left, right, other in zip(buy, sell, unknown)]
    if request.engine == "VOLUME":
        values = aggregate_volume(scoped_trades, grid)
    elif request.engine == "USD_VOLUME":
        values = aggregate_volume(scoped_trades, grid, usd_notional=True)
    elif request.engine == "TPO":
        values = aggregate_tpo(scoped_bars, grid)
    elif request.engine == "REALIZED_VOLATILITY":
        values = aggregate_realized_volatility(scoped_bars, grid)
    elif request.engine == "PARKINSON_VOLATILITY":
        values = aggregate_parkinson(scoped_bars, grid)
    else:
        values = cvd
    poc, vah, val = value_area(values, request.value_area_fraction)
    lvns, hvns = detect_nodes(values, grid)
    identity = {
        "request": request.__dict__,
        "grid": grid.__dict__,
        "trades": [(trade.trade_id, trade.timestamp_ms, trade.price, trade.quantity, trade.aggressor_side) for trade in scoped_trades],
        "bars": [(bar.timestamp_ms, bar.open, bar.high, bar.low, bar.close, bar.volume) for bar in scoped_bars],
    }
    version = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
    return AuctionProfileSnapshot(
        profile_id=f"{request.venue}:{request.symbol}:{request.start_ms}:{request.end_ms}",
        profile_version=f"bc-meap-{version}",
        engine=request.engine,
        scope=request.scope,
        start_ms=request.start_ms,
        end_ms=request.end_ms,
        row_low=grid.lows,
        row_high=grid.highs,
        values=values,
        buy_values=buy,
        sell_values=sell,
        total_values=total,
        poc_index=poc,
        vah_index=vah,
        val_index=val,
        lvn_zones=lvns,
        hvn_zones=hvns,
        quality=_quality(scoped_trades, scoped_bars),
    )
