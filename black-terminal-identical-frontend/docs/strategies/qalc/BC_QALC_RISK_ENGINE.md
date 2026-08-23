# BC-QALC Risk Engine

Size is bounded by Paper equity, risk-per-trade, hard-stop distance, quantity step and a strict 1× notional cap.

The engine tracks daily PnL/drawdown, consecutive losses, toxic exits in ten minutes and recent markouts. Default suspensions are 0.5% daily drawdown, four consecutive losses or three toxic exits in ten minutes.

After any fill the engine stops evaluating entries. Inventory exits on maximum duration, hard price stop or toxicity. There is no martingale, averaging down, pyramiding, reversal-on-loss or Investment Group allocation.

Provider rate-budget orchestration and passive profit exits remain future certification work.
