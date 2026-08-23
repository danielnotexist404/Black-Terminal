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
9. Bybit Demo Account
10. Activate Strategy & Save Configuration

Only one step is rendered at a time. The left stepper supports direct review; the main form contains the current step; the right summary keeps the selected indicator, market, timeframe, Paper allocation and three version states visible.

The strategy name is entered once. The indicator, currency pair and independent strategy timeframe are the first primary choices in step 2. Spot exposes Buy/Sell mappings; Futures exposes Long/Short mappings and leverage. Advanced parameters are collapsed. Inline validation runs before forward navigation and again at review.

Actions have narrow meanings. “Publish” remains an internal versioning term only; it does not make a strategy public or visible to other users:

- `SAVE DRAFT` persists editable server state only.
- `SAVE DRAFT ONLY` persists editable server state without activation.
- `ACTIVATE STRATEGY & SAVE CONFIGURATION` creates the private immutable version, starts its VPS runtime, and arms an authenticated Bybit Demo target after reconciliation.

Bybit Demo execution uses simulated funds on `api-demo.bybit.com` and Mainnet public market data. Testnet is not selectable, and this wizard cannot arm a real-funds Mainnet account.

Escape cancels the editor. Browser storage may hold no authoritative strategy definition.
