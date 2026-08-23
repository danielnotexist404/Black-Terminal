# BC-QALC Limitations

- Initial deployment captures BTCUSDT only; ETHUSDT is staged.
- The current Research worker owns one public Bybit socket for its symbol because the audited platform has no lossless cross-process raw-event bus. Platform-wide BCLIF/DOM/QALC socket unification remains pending before Shadow/Live certification.
- Direction/fill/toxicity coefficients are interpretable priors, not calibrated production probabilities.
- Fee provider support exists, but the research worker is not yet bound to an owned account schedule; therefore it cannot quote.
- Funding/ticker context, markout reports, Parquet/Arrow export and checkpoint restore remain incomplete.
- Queue priority is estimated from public market-by-price data and cannot know private order priority or hidden liquidity.
- Node passed the local Standard VPS internal benchmark; live VPS soak and event-loop lag evidence are pending.
- MMWS/SBE is unavailable unless separately entitled and certified.
- Live submission and group fanout are deliberately not implemented.
