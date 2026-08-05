# BCLIF Exchange Liquidation Math

The Bybit linear adapter uses entry price, side, selected-leverage initial margin (`position value / leverage`), public risk-tier maintenance margin, maintenance deduction, funding reserve and fee reserve. The tier IM rate is treated only as the minimum rate implied by that tier's maximum permitted leverage; it does not replace the selected leverage. Long distributions lie below entry and short distributions above entry. Each public-data cohort carries a visible mixed-margin prior: a narrow isolated estimate core plus a lower-weight broad cross-margin uncertainty halo because wallet collateral and other positions are private.

`BCLIF_BYBIT_LINEAR_LIQ_V2` introduced the selected-leverage correction and mixed-margin topology. It supersedes V1 without rewriting stored V1 model outputs.

Fallback risk tiers are marked `ESTIMATED_MEDIUM`; successfully fetched venue tiers are `OBSERVED`. This is a distributional estimate, not an exact account liquidation-price calculator.
