from __future__ import annotations

from .models import CanonicalTrade
from .price_grid import PriceGrid


def aggregate_volume(trades: list[CanonicalTrade], grid: PriceGrid, usd_notional: bool = False) -> list[float]:
    rows = [0.0] * grid.row_count
    for trade in trades:
        rows[grid.index(trade.price)] += trade.notional if usd_notional else trade.quantity
    return rows
