# BCLIF Exchange Liquidation Math

The Bybit linear adapter uses entry price, side, leverage-derived initial margin, public maintenance-margin tier, maintenance deduction, funding reserve and fee reserve. Long distributions lie below entry and short distributions above entry. Isolated hypotheses are narrow. Cross and unknown margin hypotheses add deliberately broad uncertainty because wallet collateral and other positions are private.

Fallback risk tiers are marked `ESTIMATED_MEDIUM`; successfully fetched venue tiers are `OBSERVED`. This is a distributional estimate, not an exact account liquidation-price calculator.
