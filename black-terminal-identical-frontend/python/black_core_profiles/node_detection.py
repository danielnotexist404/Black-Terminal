from __future__ import annotations

from .models import NodeZone
from .price_grid import PriceGrid


def _percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    index = round((len(ordered) - 1) * percent / 100)
    return ordered[max(0, min(len(ordered) - 1, index))]


def detect_nodes(values: list[float], grid: PriceGrid, sensitivity_percentile: float = 20.0) -> tuple[list[NodeZone], list[NodeZone]]:
    if len(values) < 3:
        return [], []
    magnitudes = [abs(value) for value in values]
    low_threshold = _percentile(magnitudes, sensitivity_percentile)
    high_threshold = _percentile(magnitudes, 100 - sensitivity_percentile)
    lvns: list[NodeZone] = []
    hvns: list[NodeZone] = []
    for index in range(1, len(values) - 1):
        current = magnitudes[index]
        neighbors = (magnitudes[index - 1], magnitudes[index + 1])
        low = grid.origin + index * grid.row_size
        high = low + grid.row_size
        if current <= low_threshold and current <= min(neighbors):
            prominence = (sum(neighbors) / 2 - current) / max(sum(neighbors) / 2, 1e-12)
            lvns.append(NodeZone("LVN", low, high, (low + high) / 2, current, prominence))
        if current >= high_threshold and current >= max(neighbors):
            prominence = (current - sum(neighbors) / 2) / max(current, 1e-12)
            hvns.append(NodeZone("HVN", low, high, (low + high) / 2, current, prominence))
    return lvns, hvns
