# My Strategy Operating Cockpit

Opening a published strategy restores the VPS workspace and Paper data, then presents operations rather than a raw configuration form.

The header distinguishes Paper state, symbol, timeframe, market type, running version, runtime health and heartbeat. Overview contains equity, net PnL, drawdown, win rate, profit factor, positions, Paper state, compact targets and readable runtime events. Raw settings live only in `CONFIGURATION`, grouped by Indicator, Market, Signals, Execution, Risk, Filters, Exits and Targets.

Paper controls are top-up, pause/start and reset. Positions and trades clearly state `Paper`. Tables over 100 rows use a bounded scroll viewport and render a 48-row window. Low-level events are hidden until `SHOW ADVANCED DIAGNOSTICS` is selected.

The cockpit refreshes one strategy-level snapshot every five seconds only while visible. Requests are abortable, concurrent refreshes are suppressed, and transient failures preserve the last authoritative state.
