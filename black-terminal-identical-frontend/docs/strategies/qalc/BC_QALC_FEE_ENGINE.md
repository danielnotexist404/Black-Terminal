# BC-QALC Fee Engine

No retail fee schedule is hard-coded. `getBybitFeeRates` queries the authenticated Bybit `/v5/account/fee-rate` provider endpoint and returns maker rate, taker rate, observation time and a versioned source identity.

The QALC engine starts with fee source `UNAVAILABLE`. Paper quoting is blocked until an `ACCOUNT_API` schedule is injected. Research/event capture can continue without account credentials, but it cannot be called a trade-ready Paper run.

All-in cost is:

`entry fee + expected exit fee + expected slippage + adverse selection + funding estimate + safety buffer`

The baseline assumes a taker exit when estimating costs. Funding capture and daily/account-change refresh orchestration remain required before certification.
