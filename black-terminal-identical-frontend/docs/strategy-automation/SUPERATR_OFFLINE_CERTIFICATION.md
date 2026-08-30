# SuperATR 7-Step Audit (Offline + Bybit Demo Execution Certification)

Date: 2026-08-30

Scope: supplied PresentTrading Pine v5 source, the saved Black Script v3/Python
conversion, Strategy Lab's certified closed-candle adapter, durable strategy
commands, Investment Group intents, the Bybit request builders, and an
authenticated bounded Bybit Demo lifecycle. No Mainnet broker order was
submitted by this certification.

Result: the setup formulas are certified offline and the durable Bybit Demo
execution lifecycle is certified for entry, leverage, seven partial targets,
target amendments, reversal, and final flattening. Exact live TradingView
strategy equivalence is **not** certified because the signed-golden and
intrabar gaps listed below remain open.

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
- Every confirmed closed bar can emit generation-fenced TP1-TP4 repricing
  commands. Working orders are amended by immutable parent identity and the
  command completes only after Bybit exposes the new price.
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
- SQL composite-null leases are rejected; an expired orphaned command enters
  deterministic reconciliation instead of remaining permanently
  `PROCESSING` or being blindly resubmitted.
- Reversal uses bounded deterministic residual close legs (`-c`, `-c2`,
  `-c3`, `-c4`) and never opens the opposite side until Bybit reports flat.

## Authenticated Bybit Demo evidence

- Production runtime: `fdff7af191efe5cfe2d44dbd78e5d73824033bae`
- Certification run: `mtg5ahup`
- Immutable audit event: `104`

- Long entry: 80 XRPUSDT at 5× leverage.
- Seven reduce-only Long targets were accepted.
- TP1 was repriced from a passive price to a marketable price and reduced the
  position from 80 to 72.
- Reversal closed Long first and opened Short 80 only after flat confirmation;
  the reversal command reconciled in two durable attempts.
- Seven reduce-only Short targets were accepted.
- Short TP1 was repriced and reduced the position from 80 to 72.
- Final close completed; direct venue verification reported no position and no
  canary order.
- Every temporary target was disconnected and the temporary strategy was
  archived during cleanup.
- Demo and strategy workers were restarted under `unless-stopped`; the private
  stream reauthenticated without a browser, and the same full certification
  passed after readiness returned.
- An attempt during the brief reconciliation window failed closed before a
  strategy or venue order was created.

This canary drove the real durable execution-command path for a temporary
certified strategy. It proves order lifecycle and restart behavior; it did not
wait for a naturally occurring Super7 signal and therefore is not a golden
TradingView signal-parity result.

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
9. Confirmed-bar ATR targets were not amended after entry; durable TP repricing
   now follows the running generation and reconciles the venue update.
10. A Bybit amendment timestamp was persisted as ISO text into a bigint column;
    it now stores the venue millisecond epoch.
11. Strategy slippage ticks were incorrectly converted to a percentage;
    market entries now use Bybit's integer `TickSize` contract.
12. `allowed_symbols=["*"]` was interpreted as a literal symbol rather than an
    allow-all mandate.
13. After a restart, a PostgreSQL composite null could become fencing token
    zero and leave a timed-out command permanently `PROCESSING`; invalid leases
    are rejected and orphaned work is recovered through reconciliation.

## Remaining certification gaps

These gaps prohibit a claim of exact live TradingView equivalence today:

1. Pine first sees `strategy.position_avg_price` on the calculation following
   the default next-tick fill. Broker targets are queued with the entry command
   and retry until the position is reconciled. This is safe and idempotent, but
   activation timing is not yet a tick-for-tick TradingView emulator.
2. The adapter reconstructs position direction from a rolling 1,000-candle
   window. It preserves the persisted last direction, but a complete durable
   Pine state checkpoint is still needed for same-direction re-entry after a
   user config closes 100% through partial exits without an opposite setup.
3. Script certification is structural/token-based, not an immutable source
   hash or signed compiler artifact. A lookalike edited script can still be
   mapped to the built-in adapter even when its private source is no longer
   semantically identical.
4. TradingView bar magnifier/intrabar fill ordering cannot be certified from
   OHLC candles alone. Same-bar target ordering uses the documented local
   conservative model, not TradingView's unavailable proprietary emulator
   state.
5. No signed TradingView export has yet been replayed as the golden authority
   for every closed-bar signal and target amendment across multiple symbols and
   timeframes.
6. Mainnet order mutation has not been certified. A tiny Mainnet canary needs a
   separate explicit authorization at execution time; Demo authorization does
   not extend to real funds.
7. A several-day naturally occurring Demo signal soak is still required to
   compare chart labels, evaluator signals, durable commands, private fills,
   and TradingView in one timeline.

## Test commands

```text
npm run test:superatr-certification
npm run test:execution-desk
npm run test:bybit-demo-strategy
npm run test:bybit-certification
node scripts/strategy-automation-postgres-tests.js
npm run test:black-cloud
npm run test:strategy-lab-release
npm run typecheck
```
