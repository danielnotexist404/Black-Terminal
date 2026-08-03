from __future__ import annotations

from .models import OHLCVBar
from .price_grid import PriceGrid


def aggregate_tpo(bars: list[OHLCVBar], grid: PriceGrid, bracket_ms: int = 1_800_000) -> list[float]:
    brackets: list[set[int]] = [set() for _ in range(grid.row_count)]
    for bar in bars:
        start, end = grid.index(bar.low), grid.index(bar.high)
        bracket = bar.timestamp_ms // max(1, bracket_ms)
        for index in range(start, end + 1):
            brackets[index].add(bracket)
    return [float(len(items)) for items in brackets]
