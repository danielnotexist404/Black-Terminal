from __future__ import annotations

from .models import CanonicalTrade
from .price_grid import PriceGrid


def aggregate_cvd(trades: list[CanonicalTrade], grid: PriceGrid) -> tuple[list[float], list[float], list[float], list[float]]:
    buy = [0.0] * grid.row_count
    sell = [0.0] * grid.row_count
    unknown = [0.0] * grid.row_count
    for trade in trades:
        index = grid.index(trade.price)
        if trade.aggressor_side == "BUY":
            buy[index] += trade.quantity
        elif trade.aggressor_side == "SELL":
            sell[index] += trade.quantity
        else:
            unknown[index] += trade.quantity
    return [left - right for left, right in zip(buy, sell)], buy, sell, unknown


def cvd_efficiency(buy: list[float], sell: list[float]) -> list[float]:
    return [(left - right) / max(left + right, 1e-12) for left, right in zip(buy, sell)]
