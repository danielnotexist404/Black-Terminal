# Bybit External Order Reconciliation

## Root cause

Bybit returned active orders correctly, but synchronization queried only the active chart symbol and reconciliation only updated rows already present in `execution_orders`. A Bybit web/mobile/API order had no local row, so it disappeared before the Orders panel. The chart had no canonical open-order input. The private worker also ignored `order` events when deciding whether to reconcile.

## Resolution

- Account-wide linear and spot snapshots now use paginated `/v5/order/realtime` requests.
- Every venue order receives a deterministic external identity and full quantity, remaining, price, TIF, category and source metadata.
- Snapshot responses feed the Black Core order store directly; Supabase persistence is not required for the first render.
- Private order events schedule reconciliation.
- The Orders panel shows venue and external source fields plus verified/degraded freshness.
- Current-symbol active orders render as chart price lines.
- Manual `Refresh Orders` invalidates the snapshot cache and runs a fresh authenticated account snapshot.

## Operational diagnostics

The sync payload exposes requested/successful/failed categories, orders per category, active count, network, latency and timestamp. `AUTHENTICATED` and `ORDER READ VERIFIED` are separate conditions.
