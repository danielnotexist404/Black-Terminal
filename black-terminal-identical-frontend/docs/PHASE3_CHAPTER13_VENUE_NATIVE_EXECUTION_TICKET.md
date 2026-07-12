# Phase III Chapter XIII - Venue-Native Execution Ticket

Date: 2026-07-13

Status: Implemented Bybit venue-native order and strategy execution. Scaled Order remains hidden until a persistent Black Core scheduler exists.

## Architecture

The Unified Execution Ticket is a venue-native shell. It does not contain a hard-coded union of every exchange feature.

```text
Connection Manager
  -> VenueExecutionSchema provider
  -> capability/product/instrument filtered controls
  -> OMS -> EMS -> Risk -> Broker Router
  -> server venue adapter
  -> normalized execution report
```

`src/execution/venueExecutionSchema.ts` normalizes venue/product identity, readiness, supported controls, live account metrics, instrument rules, current account modes and ready execution algorithms.

`src/execution/executionAlgorithmRegistry.ts` is the source of truth for advanced execution visibility. An algorithm appears only when `readiness=true` for the venue and product.

## Bybit Production Ticket

Implemented controls:

- Spot and USDT perpetual product selection
- Market, Limit and Conditional orders
- native Bybit Chase Limit, TWAP, Iceberg and POV strategy orders
- native strategy snapshot synchronization, private-stream normalization and stop action
- Last, Mark and Index conditional trigger sources
- Quantity, notional and equity-percentage sizing
- venue-step-aligned 0/25/50/75/100 allocation slider
- position-aware reduce-only sizing
- account-level Cross/Isolated margin changes with confirmation
- metadata-bounded leverage changes with confirmation
- GTC, IOC, FOK and Post-Only combinations where valid
- attached TP/SL with independent trigger sources
- Reduce-Only and attached TP/SL incompatibility enforcement
- live equity, available margin, margin balance, IM, MM, unrealized PnL and risk ratio
- local balance privacy toggle
- estimated notional, margin, entry/exit fees, available balance and reward/risk

All order submissions continue through OMS, EMS, Risk and Broker Router. The order ticket does not call the Bybit API directly.

## Operational Controls

Certification and mainnet-validation controls are not rendered in Unified Ticket or DOM Pro. They live in the collapsed `Runtime & Certification` section of the Positions connection panel.

The normal ticket receives only normalized execution readiness and a trader-safe blocker. Full technical diagnostics remain in connection administration.

## Native And Synthetic Truth

| Mode | Implementation | Visibility |
| --- | --- | --- |
| Market | Bybit native | ready |
| Limit | Bybit native | ready |
| Conditional | Bybit native | ready |
| Post-Only | Bybit native TIF semantics | ready |
| Attached TP/SL | Bybit native | ready |
| Chase Limit | Bybit V5 native strategy | ready |
| Scaled Order | OMS parent-child scheduler required | hidden |
| TWAP | Bybit V5 native strategy | ready |
| POV | Bybit V5 native strategy; perpetual/futures only | ready |
| Iceberg | Bybit V5 native strategy | ready |

No advanced mode silently falls back to Market or Limit.

## Official Bybit Sources

- V5 Place Order: https://bybit-exchange.github.io/docs/v5/order/create-order
- V5 Instruments Info: https://bybit-exchange.github.io/docs/v5/market/instrument
- V5 Risk Limit: https://bybit-exchange.github.io/docs/v5/market/risk-limit
- V5 Order Price Limit: https://bybit-exchange.github.io/docs/v5/market/order-price-limit
- V5 Wallet Balance: https://bybit-exchange.github.io/docs/v5/account/wallet-balance
- V5 Account Info: https://bybit-exchange.github.io/docs/v5/account/account-info
- V5 Set Margin Mode: https://bybit-exchange.github.io/docs/v5/account/set-margin-mode
- V5 Set Leverage: https://bybit-exchange.github.io/docs/v5/position/leverage
- V5 Position Mode: https://bybit-exchange.github.io/docs/v5/position/position-mode
- V5 Trading Stop: https://bybit-exchange.github.io/docs/v5/position/trading-stop
- V5 Create Strategy: https://bybit-exchange.github.io/docs/v5/strategy/create-strategy
- V5 Strategy List: https://bybit-exchange.github.io/docs/v5/strategy/strategy-list
- V5 Stop Strategy: https://bybit-exchange.github.io/docs/v5/strategy/stop-strategy
- V5 Private Strategy Stream: https://bybit-exchange.github.io/docs/v5/websocket/private/strategy

## Current Limitations

- Production certification still requires recorded tiny-order, modify, cancel, protection and reconnect evidence.
- Persistent private WebSocket processing requires the long-running worker outside Vercel.
- Strategy state is reconciled through Bybit REST snapshots while that persistent worker is unavailable.
- Spot Margin, USDC, inverse, dated futures and options stay hidden until their product schemas and routes are certified.
- Estimated liquidation impact is omitted until venue risk-tier and complete post-fill portfolio state are available.
- Trailing stop remains a Position Manager action and is not misrepresented as an order-create field.

## Verification

```bash
npm run test:venue-execution
npm run test:bybit-certification
npm run build
```

No Supabase schema migration is required for Chapter XIII or its 2026-07-13 readiness hotfix.
