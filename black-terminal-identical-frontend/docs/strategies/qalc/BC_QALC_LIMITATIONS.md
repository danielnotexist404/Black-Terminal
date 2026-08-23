# BC-QALC Limitations

- Initial deployment captures BTCUSDT only; ETHUSDT is staged.
- The current Research worker owns one public Bybit socket for its symbol because the audited platform has no lossless cross-process raw-event bus. Platform-wide BCLIF/DOM/QALC socket unification remains pending before Shadow/Live certification.
- Direction/fill/toxicity coefficients are interpretable priors, not calibrated production probabilities.
- The Research worker uses an explicitly versioned conservative fee assumption to record research candidates. Paper activation still requires an authenticated owned-account fee schedule; no live order route exists.
- The chart timeline begins at deployment and advertises bounded `RECORDED_QALC_EVENT_TIME` coverage. Older candles do not receive synthetic or backfilled markers unless archived raw events are explicitly replayed through the same engine.
- Funding/ticker context, markout reports, Parquet/Arrow export and checkpoint restore remain incomplete.
- Queue priority is estimated from public market-by-price data and cannot know private order priority or hidden liquidity.
- Node passed the local Standard VPS internal benchmark; live VPS soak and event-loop lag evidence are pending.
- MMWS/SBE is unavailable unless separately entitled and certified.
- Live submission and group fanout are deliberately not implemented.
