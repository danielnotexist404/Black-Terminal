from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class PriceGrid:
    origin: float
    row_size: float
    row_count: int

    def index(self, price: float) -> int:
        return min(self.row_count - 1, max(0, int(math.floor((price - self.origin) / self.row_size))))

    @property
    def lows(self) -> list[float]:
        return [self.origin + index * self.row_size for index in range(self.row_count)]

    @property
    def highs(self) -> list[float]:
        return [value + self.row_size for value in self.lows]


def build_grid(prices: Iterable[float], row_size: float | None, target_rows: int, maximum_rows: int = 4096) -> PriceGrid:
    values = list(prices)
    if not values:
        raise ValueError("Cannot build a profile grid without prices")
    low, high = min(values), max(values)
    span = max(1e-12, high - low)
    size = row_size if row_size and row_size > 0 else span / max(1, target_rows)
    count = min(maximum_rows, max(1, math.ceil(span / size) + 1))
    return PriceGrid(math.floor(low / size) * size, size, count)
