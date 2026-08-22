# My Strategy Wizard

The creation workflow has ten ordered steps:

1. Identity
2. Indicator and Market
3. Signal Mapping
4. Execution Behavior
5. Risk Management
6. Filters and Schedule
7. Take Profits and Exits
8. Paper Account
9. Live Targets
10. Review and Publish

Only one step is rendered at a time. The left stepper supports direct review; the main form contains the current step; the right summary keeps the selected indicator, market, timeframe, Paper allocation and three version states visible.

The strategy name is entered once. The indicator, currency pair and independent strategy timeframe are the first primary choices in step 2. Spot exposes Buy/Sell mappings; Futures exposes Long/Short mappings and leverage. Advanced parameters are collapsed. Inline validation runs before forward navigation and again at review.

Actions have narrow meanings:

- `SAVE DRAFT` persists editable server state only.
- `PUBLISH NEW VERSION` creates an immutable version and a paused Paper account.
- `START PUBLISHED VERSION` explicitly transitions the Paper runtime.

Escape cancels the editor. Browser storage may hold no authoritative strategy definition.
