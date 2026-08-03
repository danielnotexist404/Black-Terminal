from __future__ import annotations

import json
import struct

from .models import AuctionProfileSnapshot


def to_json(snapshot: AuctionProfileSnapshot) -> str:
    return json.dumps(snapshot.to_dict(), separators=(",", ":"), sort_keys=True)


def encode_float64(values: list[float]) -> bytes:
    return struct.pack(f"<{len(values)}d", *values)


def compact_arrays(snapshot: AuctionProfileSnapshot) -> dict[str, bytes]:
    return {
        "row_low": encode_float64(snapshot.row_low),
        "row_high": encode_float64(snapshot.row_high),
        "values": encode_float64(snapshot.values),
        "buy_values": encode_float64(snapshot.buy_values),
        "sell_values": encode_float64(snapshot.sell_values),
        "total_values": encode_float64(snapshot.total_values),
    }
