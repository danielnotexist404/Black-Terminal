from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from black_core_profiles import CanonicalTrade, OHLCVBar, ProfileRequest, build_profile
from black_core_profiles.serialization import compact_arrays, to_json
from black_core_profiles.validation import validate_snapshot

start = 1_720_000_000_000
bars = [
    OHLCVBar(start + index * 3_600_000, 100 + index, 102 + index, 99 + index, 101 + index, 1000)
    for index in range(10)
]
trades = [
    CanonicalTrade(
        "bybit",
        "BTCUSDT",
        bar.timestamp_ms + 1000,
        f"t-{index}",
        bar.close,
        2.0,
        "BUY" if index % 2 else "SELL",
        "EXCHANGE_AGGRESSOR_FLAG",
    )
    for index, bar in enumerate(bars)
]
request = ProfileRequest(
    "BTCUSDT",
    "bybit",
    start,
    start + 10 * 3_600_000,
    "CVD_REAL_TRADES",
    "MACRO_COMPOSITE",
    None,
    64,
    0.70,
    "fixture-v1",
)
snapshot = build_profile(request, trades, bars)
assert not validate_snapshot(snapshot)
assert snapshot.quality.quality == "EXACT"
assert abs(sum(snapshot.total_values) - sum(trade.quantity for trade in trades)) < 1e-9
assert snapshot.poc_index is not None
assert snapshot.profile_version.startswith("bc-meap-")
assert len(compact_arrays(snapshot)["values"]) == len(snapshot.values) * 8
assert json.loads(to_json(snapshot))["profile_version"] == snapshot.profile_version
print("Python Auction Profile validation passed", snapshot.profile_version, len(snapshot.values))
