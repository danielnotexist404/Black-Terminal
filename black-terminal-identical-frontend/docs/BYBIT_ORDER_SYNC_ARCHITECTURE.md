# Bybit Order Synchronization Architecture

## Canonical path

`Bybit REST snapshot + private order stream -> Bybit normalizer -> account reconciliation -> Black Core order store -> Orders panel + chart order overlay`

The REST snapshot uses `GET /v5/order/realtime`, cursor pagination and account-wide category policy. Linear orders use `settleCoin=USDT`; spot is queried separately. The current implementation requests the certified products (`linear`, `spot`) and reports successful/failed categories independently.

The long-running private worker subscribes to Bybit's all-in-one `order` topic. Every order, execution, position or wallet event schedules a fresh reconciliation. This prevents externally created orders from being discarded because they lack a Black Terminal client order ID.

## Identity and isolation

Canonical identity is `network + connectionId + venue + category + venueOrderId`. `orderLinkId` is secondary. Orders are isolated by connected account and mainnet/testnet network. The chart filters the canonical account order set by normalized symbol while the Orders panel remains account-wide.

REST pagination has a processed-cursor guard and page-level venue-ID map. Reconciliation and the browser store apply the same identity and venue-version precedence. Raw/unique/duplicate counters make identity failures observable instead of cosmetic.

## Empty-state safety

An empty result is authoritative only when every requested category succeeds. A partial category failure marks the snapshot stale/degraded. The Black Core order store retains the last verified account state instead of replacing it with an unverified empty array.

## Stream limitations

Vercel functions cannot own durable WebSocket sessions. Private streams run in the existing long-running Bybit worker. The web client receives canonical state through authenticated snapshots at a five-second fallback cadence; stream events trigger server reconciliation immediately.

Chart lines use `BlackChartEngine.getScreenYForPrice` and an overlay anchored to the Pixi host, so limit orders share the exact active linear/log price transform.

## Native position protection and reconciliation

Position TP/SL/trailing-stop changes use Bybit V5 `POST /v5/position/trading-stop`; they are not represented as generic reduce-only exit orders. Each field has three explicit states: omitted means preserve, a positive finite value means set, and explicit zero means cancel. `positionIdx` is mandatory so one-way and hedge-mode legs cannot be conflated.

For full-position TP/SL, Black Terminal reads the exact `(category, symbol, positionIdx)` position first and carries the untouched paired side forward. An accepted REST response is provisional. The execution route immediately runs authoritative account reconciliation and reports `reconciled` only when the requested field matches the fresh venue position. Local chart and Position Manager state changes only after that report.

Bybit `retCode 34040` is handled only as a reconcile-required idempotent no-op. Black Terminal never reports success unless the subsequent exact position snapshot confirms that the requested protection value is already authoritative.

Open orders are read from `/v5/order/realtime` across linear USDT, linear USDC, inverse, spot, and option scopes with cursor pagination. A failed category makes the snapshot partial/stale: successful-category orders remain visible and prior rows from failed categories are retained until a later verified snapshot authoritatively removes them.
