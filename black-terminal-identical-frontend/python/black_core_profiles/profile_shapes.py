from __future__ import annotations


def classify_shape(values: list[float]) -> str:
    if len(values) < 5 or sum(abs(value) for value in values) == 0:
        return "THIN"
    size = max(1, len(values) // 3)
    lower = sum(abs(value) for value in values[:size])
    middle = sum(abs(value) for value in values[size : size * 2])
    upper = sum(abs(value) for value in values[size * 2 :])
    if middle > lower * 1.25 and middle > upper * 1.25:
        return "D_SHAPE"
    if upper > lower * 1.6:
        return "P_SHAPE"
    if lower > upper * 1.6:
        return "B_SHAPE"
    return "UNCLASSIFIED"
