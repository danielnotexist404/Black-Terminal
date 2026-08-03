from __future__ import annotations

import math

from .models import OHLCVBar
from .price_grid import PriceGrid


def parkinson_variance(bar: OHLCVBar) -> float:
    if bar.high <= 0 or bar.low <= 0:
        return 0.0
    return math.log(bar.high / bar.low) ** 2 / (4 * math.log(2))


def aggregate_parkinson(bars: list[OHLCVBar], grid: PriceGrid) -> list[float]:
    values = [0.0] * grid.row_count
    for bar in bars:
        start, end = grid.index(bar.low), grid.index(bar.high)
        variance = parkinson_variance(bar) / max(1, end - start + 1)
        for index in range(start, end + 1):
            values[index] += variance
    return values
