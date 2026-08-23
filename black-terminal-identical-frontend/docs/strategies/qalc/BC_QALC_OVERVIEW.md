# BC-QALC Overview

BC-QALC (`black-core-qalc`) is a native event-time Queue-Aware Liquidity Capture research engine for Bybit linear perpetuals. It is not a candle strategy or an indicator-alert wrapper.

The baseline consumes exact order-book snapshots/deltas and exchange-labelled aggressor trades, produces separate direction, fill and adverse-selection estimates, rejects edge that does not exceed all-in costs, and simulates one-sided PostOnly quotes with conservative queue-ahead.

Current boundary: Research/Event Capture candidate. Real order submission, Investment Group fanout, withdrawals, martingale, averaging down and two-sided market making are absent.

The Strategy Lab path is `My Strategy → Start From Template → Microstructure → BC-QALC`.
