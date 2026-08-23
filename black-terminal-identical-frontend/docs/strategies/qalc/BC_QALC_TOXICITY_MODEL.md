# BC-QALC Toxicity Model

Toxicity is a 0–100 interpretable score with five capped 0–20 components:

- spread dislocation: `spreadTicks / 5`;
- short-horizon realized volatility: `volatilityBps / 8`;
- cancellation pressure: `cancelToAdd / 2`;
- flow shock: `abs(tradeOFI) / (0.2 × topDepth)`;
- sweep impact: `priceImpactTicks / 5`.

States are Safe (<25), Caution (<45), Elevated (<65), Toxic (<85) and Emergency. The configurable quote gate defaults to 44. Toxicity invalidates working quotes and forces short-lived Paper inventory toward a taker-mode safety exit.

These baseline thresholds require calibration and sensitivity testing before Paper certification.
