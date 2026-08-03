from __future__ import annotations

from .models import CanonicalTrade


def classify_trade(
    *,
    venue: str,
    symbol: str,
    timestamp_ms: int,
    trade_id: str,
    price: float,
    quantity: float,
    side: str | None = None,
    buyer_is_maker: bool | None = None,
) -> CanonicalTrade:
    if buyer_is_maker is not None:
        aggressor = "SELL" if buyer_is_maker else "BUY"
        source = "MAKER_SIDE_INVERSION"
    elif side and side.upper() in {"BUY", "SELL"}:
        aggressor = side.upper()
        source = "EXCHANGE_AGGRESSOR_FLAG"
    else:
        aggressor = "UNKNOWN"
        source = "INFERRED"
    return CanonicalTrade(venue, symbol, timestamp_ms, trade_id, price, quantity, aggressor, source)
