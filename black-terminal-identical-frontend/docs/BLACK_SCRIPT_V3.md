# Black Script v3

Black Script v3 is Black Terminal's deterministic user-indicator and strategy runtime. It runs against the active authoritative OHLCV stream or the causal, append-only Renko stream.

Compiling or adding a script to the chart is simulation-only. The runtime has no broker adapter, credential access, filesystem access, network access, dynamic imports, or process execution capability. When an eligible owned strategy is published, the VPS independently recompiles its immutable source and translates only normalized order intents into the separately fenced Black Cloud OMS.

## Stateful strategy model

The following runtime series are available:

- `strategy.position_size`
- `strategy.position_avg_price`
- `strategy.equity`
- `strategy.openprofit`
- `strategy.netprofit`

Supported order calls:

- `strategy.entry(id, strategy.long|strategy.short, ...)`
- `strategy.order(id, strategy.long|strategy.short, ...)`
- `strategy.exit(id, from_entry, ...)`
- `strategy.close(entry_id, ...)`
- `strategy.close_all(...)`
- `strategy.cancel(order_id, ...)`
- `strategy.cancel_all(...)`

Entries accept `qty`, `qty_percent`, `limit`, `stop`, and `when`. Exits accept `qty`, `qty_percent`, `limit`, `stop`, `profit`, `loss`, `from_entry`, and `when`. Multiple exit IDs remain independent, so a strategy can maintain several partial profit targets and a protective bracket simultaneously.

`strategy(...)` configures:

- `initial_capital`
- `default_qty_type`: `strategy.fixed`, `strategy.cash`, or `strategy.percent_of_equity`
- `default_qty_value`
- `commission_type`: percent, cash per order, or cash per contract
- `commission_value`
- `slippage` in ticks
- `tick_size`
- `pyramiding`
- `process_orders_on_close`
- `use_bar_magnifier`
- `historical_fill_mode`: `"tradingview"` (default) or `"conservative"`

Opposite entries close the existing side before opening the new side. Same-side entries respect the pyramiding limit. Filled partial exits reduce the existing lot instead of appending synthetic positions.

## Deterministic fill policy

- Market orders fill at the confirmed close when `process_orders_on_close=True`, otherwise at the next open.
- Resting limit and stop orders become eligible on the bar after placement.
- Gap fills use the available open when it is worse or better than the requested resting price as appropriate.
- By default, historical OHLC fills follow TradingView's four-tick broker-emulator path. If the open is closer to the high, the path is `open -> high -> low -> close`; otherwise it is `open -> low -> high -> close`.
- `use_bar_magnifier=True` consumes chronological lower-timeframe OHLC candles when the caller supplies them. Each lower-timeframe candle uses the same deterministic four-tick path, and bars without lower-timeframe coverage fall back to the default chart-bar path.
- `historical_fill_mode="conservative"` retains the former stop-first behavior when one OHLC candle touches both a stop and target.
- Commissions and slippage are applied to every actual fill.
- Entry/exit chart markers and strategy events are created from simulated fills, not from unfilled Boolean intentions.

Lower-timeframe magnification materially reduces ambiguity but does not invent trades between the source candles. Exact tick-path sequencing still requires an authoritative tick feed.

## Headless and broker execution contract

The same runtime checkpoint is used by Replay, Backtest and the leased VPS worker. The headless worker executes only finalized chart candles, optionally uses complete Bybit lower-timeframe coverage, and persists the next checkpoint together with every target's idempotent command manifest in one database transaction.

Direct broker execution is currently certified only for Bybit futures with `pyramiding=1`. Each target has independent broker-order handles and uses its own authoritative equity, position, venue precision and leverage limit. Market entries, closes and reversals preserve the script sizing mode. Limit, stop-market and stop-limit orders are durable and restart-safe. Full-position trailing stops use native Bybit position protection. Partial trailing stops, Spot automation and Investment Group fanout remain fail-closed.

No filled strategy transition is allowed to outrun its broker account. Market entries, closes and reversals retain per-target reconciliation handles, and the next shared generation waits for a terminal positive fill plus the matching strategy-owned position state. A legitimate partially-filled terminal IOC entry may continue at its actual target quantity; an underfilled close fails closed instead of silently changing the strategy position. An OHLC-triggered resting fill likewise waits until every armed target confirms the exact broker order as filled. Partial OCO fills resize the sibling reservation; complete fills cancel it. Scheduled reconciliation repeats the same idempotent repair if a private websocket event is missed.

## Language surface

Black Script v3 remains source-compatible with v2 and adds:

- multiline parenthesized expressions and calls;
- trailing commas in calls;
- tuple destructuring and `ta.macd`;
- `input.color` with a native color control;
- exponentiation and floor division;
- additional TA functions: MACD, stochastic, MFI, CCI, and VWMA;
- additional deterministic math functions.

The sandbox intentionally rejects imports, filesystem/network calls, arbitrary object access, classes, recursion, and unbounded code execution. Strategies express historical calculations through vector functions rather than executing unrestricted Python in the browser.

## Alerts

Explicit `alertcondition()` events and simulated strategy fills share the closed-candle delivery guard. Historical events arm silently, Replay never emits live notifications, and a new notification is sent only after a new finalized bar or brick. Browser strategy-fill notifications do not submit, modify, or cancel broker orders. Broker execution exists only in the server-owned published-strategy pipeline described above.
