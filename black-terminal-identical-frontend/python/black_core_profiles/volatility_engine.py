from __future__ import annotations

import math

from .models import OHLCVBar
from .price_grid import PriceGrid


def realized_variance(bar: OHLCVBar, previous_close: float | None = None) -> float:
    anchor = previous_close or bar.open
    return math.log(bar.close / anchor) ** 2 if bar.close > 0 and anchor > 0 else 0.0


def garman_klass_variance(bar: OHLCVBar) -> float:
    if min(bar.open, bar.high, bar.low, bar.close) <= 0:
        return 0.0
    high_low = math.log(bar.high / bar.low)
    close_open = math.log(bar.close / bar.open)
    return max(0.0, 0.5 * high_low**2 - (2 * math.log(2) - 1) * close_open**2)


def aggregate_realized_volatility(bars: list[OHLCVBar], grid: PriceGrid) -> list[float]:
    values = [0.0] * grid.row_count
    for offset, bar in enumerate(bars):
        start, end = grid.index(bar.low), grid.index(bar.high)
        divisor = max(1, end - start + 1)
        variance = realized_variance(bar, bars[offset - 1].close if offset else None) / divisor
        for index in range(start, end + 1):
            values[index] += variance
    return values
