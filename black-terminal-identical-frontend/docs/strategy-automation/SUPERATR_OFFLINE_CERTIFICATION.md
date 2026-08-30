# SuperATR 7-Step Offline Audit (Partial Certification)

Date: 2026-08-30

Scope: supplied PresentTrading Pine v5 source, the saved Black Script v3/Python
conversion, Strategy Lab's certified closed-candle adapter, durable strategy
commands, Investment Group intents, and the Bybit request builders. No Demo or
Mainnet broker order was submitted by this certification.

Result: the setup formulas and control path below are certified offline. Exact
live TradingView strategy equivalence is **not** certified because the ATR-exit
timing/repricing gaps listed below remain open.

## Source authority

- Supplied Pine source:
  `/home/tony/.codex/attachments/7bb11a5c-ca69-4c10-af5f-d841f8cca0c3/pasted-text.txt`
- Saved conversion:
  `scripts/examples/superatr-seven-step-black-terminal.py`
- Headless signal adapter:
  `src/modules/strategy-lab/adapters/signalAdapter.ts`

## Deterministically verified

- Pine true range, biased `ta.stdev`, SMA adaptive ATR, trend strength,
  confirmation, and long/short setup formulas match an independent causal
  transcription on 1,400 deterministic candles.
- Appending future candles does not change any finalized historical signal.
- The worker accepts only Bybit-server-confirmed closed candles and persists
  the last processed close.
- `pyramiding=1` suppresses repeated same-direction setup bars while preserving
  actual long/short reversals.
- The saved Python conversion and the certified adapter produce identical
  next-bar-open entry/reversal timestamps on the certification fixture.
- TP1-TP7 identities and partial percentages are preserved; cumulative venue
  reservations are capped at the original position quantity in Pine source
  order.
- Entry and reversal actions both create a target plan for the newly opened
  side.
- Every target names its immutable parent entry/direction intent. It waits for
  that entry command and its terminal venue fill, so concurrent queue claims
  cannot bind a reversal target to the old close leg.
- Late TP retries size from the parent entry's final cumulative fill, not from
  a position remainder already reduced by earlier targets.
- Live target formulas anchor to Bybit's authoritative `averagePrice` instead
  of the signal candle close, including next-open gaps.
- Bybit entry requests are non-reduce market orders. Partial targets are
  opposite-side GTC limit orders with `reduceOnly=true` and the reconciled
  `positionIdx`.
- Directional leverage is risk-capped, sent to `/v5/position/set-leverage`, and
  configured before the non-reduce entry order.
- Investment Group `TAKE_PROFIT` intents are admitted by an explicit database
  constraint; arbitrary strategy actions remain rejected.
- Deterministic client IDs, command idempotency, connection leases, fencing,
  position ownership checks, environment isolation, and ambiguous-response
  reconciliation remain in the execution path.

## Defects corrected by this audit

1. Direct broker reversal commands previously did not queue TP1-TP7 for the
   newly reversed position.
2. Direct and group target prices were anchored to the signal candle close,
   not the authoritative Bybit average fill.
3. Seven independently queued exits could cumulatively reserve more than 100%
   when user percentages exceeded the position.
4. The database rejected every Investment Group `TAKE_PROFIT` intent even
   though the strategy worker generated them.
5. Bybit order and leverage request construction had no pure, network-free
   contract test.
6. Direct and group target commands had no parent-entry dependency barrier;
   concurrent claims could race the reversal entry.
7. Late target retries derived their percentage from the reduced remaining
   position instead of the original entry fill.
8. Group reversal close and entry legs shared one persisted OMS client ID;
   they now use deterministic `-c` and `-e` identities.

## Remaining certification gaps

These gaps prohibit a claim of exact live TradingView equivalence today:

1. Pine recreates/updates ATR-based `strategy.exit` prices on every strategy
   calculation after the entry fill. Direct and follower Bybit targets still
   use the ATR value carried by the confirmed signal command; the new code
   correctly re-anchors that distance to the venue fill, but it does not amend
   working TP1-TP4 after every later closed candle.
2. Pine first sees `strategy.position_avg_price` on the calculation following
   the default next-tick fill. Broker targets are queued with the entry command
   and retry until the position is reconciled. This is safe and idempotent, but
   activation timing is not yet a tick-for-tick TradingView emulator.
3. The adapter reconstructs position direction from a rolling 1,000-candle
   window. It preserves the persisted last direction, but a complete durable
   Pine state checkpoint is still needed for same-direction re-entry after a
   user config closes 100% through partial exits without an opposite setup.
4. Script certification is structural/token-based, not an immutable source
   hash or signed compiler artifact. A lookalike edited script can still be
   mapped to the built-in adapter even when its private source is no longer
   semantically identical.
5. TradingView bar magnifier/intrabar fill ordering cannot be certified from
   OHLC candles alone. Same-bar target ordering uses the documented local
   conservative model, not TradingView's unavailable proprietary emulator
   state.
6. A real authenticated Demo canary is still required to prove venue
   acknowledgement, fill, reconciliation, seven working reduce-only orders,
   partial fills, reversal, and post-restart recovery. Mainnet should remain
   paused until the Demo canary and deployment-version checks pass.

## Test commands

```text
npm run test:superatr-certification
npm run test:execution-desk
npm run test:bybit-demo-strategy
npm run test:bybit-certification
node scripts/strategy-automation-postgres-tests.js
npm run typecheck
```
