# Black Script v3

Black Script v3 is Black Terminal's deterministic user-indicator and strategy runtime. It runs against the active authoritative OHLCV stream or the causal, append-only Renko stream.

Compiling or adding a script to the chart is simulation-only. The runtime has no broker adapter, credential access, filesystem access, network access, dynamic imports, or process execution capability.

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

Opposite entries close the existing side before opening the new side. Same-side entries respect the pyramiding limit. Filled partial exits reduce the existing lot instead of appending synthetic positions.

## Deterministic fill policy

- Market orders fill at the confirmed close when `process_orders_on_close=True`, otherwise at the next open.
- Resting limit and stop orders become eligible on the bar after placement.
- Gap fills use the available open when it is worse or better than the requested resting price as appropriate.
- When one OHLC candle touches both a stop and target, the simulator applies the conservative stop-first assumption because OHLC data cannot prove the intrabar path.
- Commissions and slippage are applied to every actual fill.
- Entry/exit chart markers and strategy events are created from simulated fills, not from unfilled Boolean intentions.

For exact tick-path sequencing, scripts must run on an authoritative tick or causal Renko feed rather than infer ordering from an OHLC candle.

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

Explicit `alertcondition()` events and simulated strategy fills share the closed-candle delivery guard. Historical events arm silently, Replay never emits live notifications, and a new notification is sent only after a new finalized bar or brick. Strategy-fill notifications do not submit, modify, or cancel broker orders.
