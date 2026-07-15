# Bybit External Order Certification Report

Status: **Implementation verified; live venue evidence pending an existing controlled order.**

## Deterministic evidence

- REST and private-stream payloads normalize to the same deterministic identity.
- Partial-fill remaining quantity is preserved.
- Filled status closes the active order lifecycle.
- Cursor pagination, category policy, private worker reconciliation and chart projection are regression tested.

## Live evidence procedure

1. Place a small limit order directly in Bybit, away from market, using the controlled account.
2. Run `BYBIT_API_KEY=... BYBIT_API_SECRET=... BYBIT_EXPECTED_ORDER_ID=... npm run certify:bybit-external-orders` in the protected worker environment.
3. Confirm the generated `BYBIT_EXTERNAL_ORDER_CERTIFICATION_EVIDENCE.json` reports `PASS`.
4. Confirm the same order appears in the Orders panel and as a chart line.
5. Amend, partially fill and cancel the venue order; record the lifecycle timestamps.

No live order was placed by this implementation task. Production certification remains blocked until the operator supplies the controlled existing-order evidence.
