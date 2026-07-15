# Chart Order Management Menu

Right-clicking a canonical order line or Orders-table row opens one shared management surface targeting the selected venue order ID.

- **Modify Order** submits price/remaining quantity through the authenticated `/api/execution/modify` route and Bybit adapter.
- **Cancel Order** submits through `/api/execution/cancel`; the UI waits for venue acknowledgement and synchronization instead of inventing an immediate terminal state.
- **Inspect Details** shows canonical key, venue order ID, exact venue price, lifecycle and ownership.
- **Chase Order** is capability-gated for existing standard orders. Bybit does not convert an existing regular order into a native Chase strategy; unsafe silent cancel-and-replace is deliberately not performed.

All server actions retain ownership checks, credential decryption, mainnet-management gates, adapter normalization and audit logging.

