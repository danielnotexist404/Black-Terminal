from __future__ import annotations

import json
import sys

from .engine import MarketSentimentSettings, calculate_market_sentiment


def main() -> None:
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    settings_payload = payload.get("settings", {})
    aliases = {
        "candleTransform": "candle_transform",
        "heikinAshi": "heikin_ashi",
        "smoothingEnabled": "smoothing_enabled",
        "smoothingLength": "smoothing_length",
        "lastBarConfirmed": "last_bar_confirmed",
    }
    for source, target in aliases.items():
        if source in settings_payload:
            settings_payload[target] = settings_payload.pop(source)
    settings = MarketSentimentSettings(**{
        key: value for key, value in settings_payload.items()
        if key in MarketSentimentSettings.__dataclass_fields__
    })
    json.dump(
        calculate_market_sentiment(payload.get("candles", []), settings, payload.get("lastBarConfirmed", True)),
        sys.stdout,
        separators=(",", ":"),
        allow_nan=False,
    )


if __name__ == "__main__":
    main()
