# Project Obsidian Phase III - Chapter IV

Chapter IV introduces the Position Lifecycle Engine.

## Objective

Filled execution reports no longer end as isolated historical order records. They are promoted into managed positions owned by the Black Core Position Manager.

Lifecycle:

```text
Execution Request
  -> OMS
  -> EMS
  -> Broker / Protocol Adapter
  -> Exchange / Protocol
  -> Execution Report
  -> Position Manager
  -> Position Protection
  -> Monitoring
  -> Modification
  -> Scaling
  -> Close
  -> Archive
  -> Trade Journal
```

## Implemented Runtime Foundation

- `src/positions/types.ts` now defines managed position lifecycle, protection orders, timeline events, health metrics, notes, and tags.
- `src/positions/positionManager.ts` owns active positions in Black Core runtime state.
- EMS ingests execution reports into the Position Manager after OMS report application.
- Positions workspace synchronizes real portfolio positions into the Position Manager.
- The chart subscribes to managed positions and becomes context-aware by symbol.
- Active-position chart context menu exposes lifecycle actions instead of the generic order menu.
- Take profit, stop loss, break-even, and trailing-stop protection records are owned by Position Manager.
- Entry, TP, SL, trailing, and liquidation lines render on the chart for active positions.
- Draggable TP/SL/trailing lines update the Position Manager and publish lifecycle events.
- Unified Execution Ticket supports position presets, reduce-only presets, TP/SL prefills, and trailing-stop controls.

## Position Manager Responsibilities

Implemented in runtime foundation:

- Create position from execution report.
- Sync external portfolio positions.
- Update position.
- Close position.
- Reverse position.
- Add to position.
- Scale in.
- Scale out.
- Partial close.
- Merge positions.
- Split positions.
- Archive positions.
- Manage protection orders.
- Add notes.
- Update tags.
- Maintain timeline.
- Calculate health metrics.
- Publish Black Core position lifecycle events.

## Position Health Metrics

Current health model exposes:

- Entry price.
- Mark price.
- Average entry.
- Current PnL.
- Realized PnL.
- Unrealized PnL.
- Current risk.
- Distance to TP.
- Distance to SL.
- Risk/reward.
- Margin used.
- Liquidation price.
- Funding paid placeholder.
- Fees placeholder.
- Maximum favorable excursion.
- Maximum adverse excursion.
- Time in trade.
- Execution quality placeholder.

Future persistence and exchange synchronization should fill fees, funding, execution quality, and excursion history from broker/protocol fills.

## Position Protection Layer

Protection belongs to Position Manager, not OMS.

OMS owns orders.

EMS owns execution.

Position Manager owns the relationship between a position and its protection stack.

Supported runtime protection types:

- Take profit.
- Stop loss.
- Trailing stop.
- Break even.
- Future OCO placeholder.

## Context-Aware Chart Menu

When no active position exists for the chart symbol, the chart menu shows execution actions:

- Execute Order.
- Execute Copy Trade Order.
- Buy Market.
- Sell Market.
- Buy Limit Here.
- Sell Limit Here.

When an active position exists for the chart symbol, the chart menu switches to lifecycle actions:

- Position Statistics.
- Add To Position.
- Scale In.
- Scale Out.
- Partial Close.
- Close Position.
- Reverse Position.
- Set Take Profit Here.
- Set Stop Loss Here.
- Set Trailing Stop.
- Move Protection.
- Cancel TP.
- Cancel SL.
- Cancel Trailing.
- Trade Notes.
- Trade Timeline.

## Protocol Framework

Wallets are signers. Protocols execute.

New protocol foundation:

- `src/protocols/types.ts`
- `src/protocols/protocolRouter.ts`
- `src/protocols/hyperliquidAdapter.ts`
- `src/protocols/registerProtocols.ts`

The protocol router is prepared for:

- Hyperliquid.
- GMX.
- Drift.
- Vertex.
- dYdX.
- Jupiter.
- Raydium.
- PancakeSwap.

## Hyperliquid Adapter

Implemented as a protocol adapter registered with the Black Core Connection Manager.

Current capabilities advertised:

- Market orders.
- Limit orders.
- Conditional orders.
- Perpetual orders.
- Modify orders.
- Cancel orders.
- Leverage.
- Cross margin.
- Isolated margin.
- Funding.
- Liquidation.
- Reduce only.
- Post only.
- Balances.
- Positions.
- Orders.
- Trades.
- Wallet signing.
- Public WebSocket.

Important limitation:

The frontend protocol adapter can connect MetaMask and expose protocol capabilities, but live Hyperliquid execution still requires a server-side signing/order relay before real order placement is allowed. The UI therefore enables futures capability detection while blocking live protocol submission with an explicit message until that relay exists.

## Remaining Work

- Persist managed positions, protection records, timeline events, notes, and tags in Supabase.
- Add Vercel API routes for position lifecycle actions.
- Add server-side Hyperliquid signing and order relay.
- Add live position/balance/order sync for Hyperliquid.
- Feed exchange fills back into Position Manager.
- Add execution-quality analytics from real fills.
- Persist chart protection line moves to backend and exchange.
- Add replay/journal surfaces that consume position timeline events.
