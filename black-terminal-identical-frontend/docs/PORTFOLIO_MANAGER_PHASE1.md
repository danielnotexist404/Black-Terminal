# Portfolio Manager Phase 1

This phase introduces the Portfolio Manager as a modular trading workstation subsystem.

## Boundaries

- `src/modules/portfolio-manager/` owns the React workspace and presentation components.
- `src/portfolio/` owns portfolio snapshots, account summaries, balances, and account connection orchestration.
- `src/broker/` defines centralized exchange broker adapters. UI code must not call exchange APIs directly.
- `src/execution/` owns order submission flow through risk checks and broker adapters.
- `src/risk/` owns account-level risk controls and pre-trade validation.
- `src/copyTrading/` owns follower allocation profiles and execution matrix construction.
- `src/orders/` owns order ticket domain types.
- `src/positions/` owns live position domain types.
- `src/wallets/` defines browser wallet connector contracts for DEX workflows.
- `src/core/secureCredentialStore.ts` is the secure credential boundary. Renderer code receives only credential references after handoff.

## Current Adapter Status

Phase 1 uses mock broker adapters for account, balance, and position data. Order placement intentionally rejects by default until exchange-specific secure execution is implemented.

TODO: implement Tauri commands for encrypted credential storage:

- `secure_store_exchange_credentials`
- `secure_delete_exchange_credentials`

TODO: replace read-only mock adapters with venue-specific adapters for Bybit, Binance, OKX, Bitget, Coinbase Advanced, and the existing market catalog exchanges.

TODO: add capability-gated TWAP and Iceberg implementations per venue.
