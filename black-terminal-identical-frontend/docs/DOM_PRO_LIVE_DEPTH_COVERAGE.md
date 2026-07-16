# DOM Pro Live Depth Coverage

## Truth Model

Current venue depth and historical IMM liquidity are different datasets.

- The ladder numeric bid/ask columns contain only the latest normalized venue order book.
- IMM walls may add a confluence marker, never a fabricated live quantity.
- The profile and heatmap may cover a much wider historical domain than the current venue snapshot.

Every ladder row has one coverage state:

| State | Meaning | Quantity display |
|---|---|---|
| `live` | Price bucket intersects current venue coverage | Aggregated live quantity, including truthful `0.000` |
| `unavailable` | Camera includes the price but the venue snapshot does not | `--` and a dimmed row |
| `stale` | A prior book exists but exceeds freshness limits | `STALE` |
| `offline` | No current venue book exists | `OFF` |

The coverage band is derived from the lowest live bid through the highest live ask. Metadata records subscribed depth, venue sequence, timestamp and age. This prevents distant Macro rows from being presented as zero-liquidity claims.

## Reconnect

A reconnect replaces the source snapshot and sequence while preserving the user's price camera. The next model rebuild repairs quantities in place. No camera snap, secondary stream or historical-depth substitution occurs.

## Live Certification

The certification runner reads Bybit's public 200-level BTCUSDT linear book, constructs a wide shared camera, independently sums raw venue levels for a sampled bucket, and compares that sum with the rendered ladder model. It also checks unavailable rows and camera preservation across a second snapshot.

