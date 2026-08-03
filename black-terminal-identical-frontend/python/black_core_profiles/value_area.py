from __future__ import annotations


def value_area(values: list[float], fraction: float = 0.70) -> tuple[int | None, int | None, int | None]:
    if not values:
        return None, None, None
    weights = [abs(value) for value in values]
    poc = max(range(len(weights)), key=weights.__getitem__)
    target = sum(weights) * min(1.0, max(0.0, fraction))
    low = high = poc
    accumulated = weights[poc]
    while accumulated < target and (low > 0 or high < len(weights) - 1):
        below = weights[low - 1] if low else -1
        above = weights[high + 1] if high < len(weights) - 1 else -1
        if above > below:
            high += 1
            accumulated += above
        else:
            low -= 1
            accumulated += below
    return poc, high, low
