# BCLIF local browser checkpoint

The checkpoint is public market-state convenience, not a persistent collector.

## Scope and compatibility

The IndexedDB database black-terminal-bclif-public-v1 stores Browser Fallback snapshots only. Keys include model version, renderer schema version, venue, normalized symbol, horizon and presentation family. Restore verifies record and snapshot identity, authority, checksum, measured byte size and time bounds.

No credentials, account state, authentication tokens, broker orders, Black Cloud secrets or private user data are stored.

## Hard limits

- maximum age: 24 hours;
- maximum record size: 64 MiB;
- maximum total size: 128 MiB;
- maximum entries: 3;
- retention: newest compatible entries first.

Actual typed-array and sidecar bytes are measured before save and again on restore. Corrupt or incompatible records are deleted. If reconciliation is temporarily unavailable, a verified checkpoint remains visible with truthful stale/source status. Browser closure still stops collection and creates unavoidable history gaps.
