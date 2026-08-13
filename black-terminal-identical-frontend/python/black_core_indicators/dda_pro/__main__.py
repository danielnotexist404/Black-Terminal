"""JSON-lines-free command entry for deterministic DDA reference checks."""

from __future__ import annotations

import json
import sys

from .engine import DDASettings, calculate_dda


def main() -> None:
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    settings = DDASettings(**payload.get("settings", {}))
    json.dump(calculate_dda(payload.get("values", []), settings), sys.stdout, separators=(",", ":"), allow_nan=False)


if __name__ == "__main__":
    main()
