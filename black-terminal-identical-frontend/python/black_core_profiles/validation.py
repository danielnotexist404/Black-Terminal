from __future__ import annotations

import math

from .models import AuctionProfileSnapshot, CanonicalTrade, ProfileRequest


def validate_request(request: ProfileRequest) -> list[str]:
    errors: list[str] = []
    if request.start_ms >= request.end_ms:
        errors.append("start_ms must precede end_ms")
    if not 1 <= request.target_rows <= 4096:
        errors.append("target_rows must be between 1 and 4096")
    if not 0 < request.value_area_fraction <= 1:
        errors.append("value_area_fraction must be in (0, 1]")
    return errors


def validate_trades(trades: list[CanonicalTrade]) -> list[str]:
    return [trade.trade_id for trade in trades if not (math.isfinite(trade.price) and trade.price > 0 and math.isfinite(trade.quantity) and trade.quantity >= 0)]


def validate_snapshot(snapshot: AuctionProfileSnapshot) -> list[str]:
    errors: list[str] = []
    length = len(snapshot.row_low)
    for name in ("row_high", "values", "buy_values", "sell_values", "total_values"):
        if len(getattr(snapshot, name)) != length:
            errors.append(f"{name} length differs from row_low")
    if snapshot.poc_index is not None and not 0 <= snapshot.poc_index < length:
        errors.append("POC index outside grid")
    return errors
