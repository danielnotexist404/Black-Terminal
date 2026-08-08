# BCLIF Event Storage

Canonical events retain exchange time, receive time, source sequence, source version, certainty, deterministic event ID, and deduplication key. Supported kinds are trade, liquidation, OI, funding, mark/index, account ratio, instrument, risk tier, reconstructed book frame, and source gap.

High-rate trades are sealed into compressed immutable chunks rather than unlimited Postgres rows. Confirmed liquidation events remain independently queryable and always carry `OBSERVED`; estimated exposure never enters that archive. Book deltas build an exact bounded local book, while only reconstructed frames are persisted at controlled cadence.

Deduplication keys survive reconnect and restart. Trades use venue, symbol, and trade ID. Liquidations use a canonical hash of timestamp, side, decimal price/size, source batch timestamp, and duplicate ordinal. OI and context records use their venue interval identity; book frames use timestamp and accepted sequence. A short exact hash sidecar accompanies each event chunk.

Object writes are two phase: encode and hash, upload to a private server-generated path, read back and verify, then insert metadata. Clients never submit or receive object paths.
