# Black Terminal Documentation

This folder is the permanent engineering record for Black Terminal.

Every meaningful platform change must update documentation in the same work cycle. If code changes behavior, data flow, permissions, migrations, execution routing, market data, or user-visible workflow, the docs must change with it.

## Canonical Docs

- `PROJECT_BRIEF.md` - product intent, target user, and product principles.
- `PLATFORM_BUILD_MANUAL.md` - how the platform is assembled from frontend, Black Core, execution, backend APIs, Supabase, and Tauri.
- `ARCHITECTURE.md` - current and target technical architecture.
- `IMPLEMENTATION_HISTORY.md` - chronological record of what was implemented and why.
- `WORKSPACE.md` - local setup, commands, and directory guide.
- `ROADMAP.md` - milestone sequence and future direction.
- `SUPABASE_MIGRATIONS.md` - database migration ledger and rules.

## Phase Docs

- `PORTFOLIO_MANAGER_PHASE1.md` - Portfolio Manager and early execution boundaries.
- `BLACK_CORE_PHASE2.md` - Black Core market data platform foundation.
- `PHASE3_CHAPTER1_ARCHITECTURE.md` - Phase III product boundaries and role separation.
- `PHASE3_CHAPTER2_OMS_EMS.md` - OMS / EMS foundation.
- `PHASE_III_CONNECTIVITY_INVESTIGATION.md` - Connection Manager, MetaMask futures, and ticket synchronization investigation.
- `PHASE3_CHAPTER4_POSITION_LIFECYCLE.md` - Position Lifecycle Engine, protection layer, context-aware chart, and protocol framework.
- `PHASE3_CHAPTER5_HYPERLIQUID_RELAY.md` - Hyperliquid server-side signing relay, credential model, nonce manager, and testnet-first execution flow.
- `PHASE3_CHAPTER6_DOM_PRO.md` - DOM Pro+ detachable institutional order-flow cockpit, aggregation engine, shared feed, and diagnostics.
- `PHASE3_CHAPTER7_MARKET_DEPTH_MEMORY.md` - Black Core Market Depth Memory, server collector, compression, wall lifecycle, replay API, and IMM foundation.
- `PHASE4_PROFESSIONAL_NETWORK.md` - Professional Profile, Research Feed, follow graph, Investment Groups, join requests, and Trading Room foundation.

## Specialist Docs

- `EXCHANGE_AUTOMATION.md` - exchange data, trading, and webhook strategy.
- `PYTHON_INDICATORS.md` - Python indicator runtime contract.
- `scanner.md` - scanner module notes.

## Documentation Rules

1. Add or update a doc whenever a feature changes architecture, persistence, execution, connectivity, risk, permissions, or user workflow.
2. Record important implementation work in `IMPLEMENTATION_HISTORY.md`.
3. Record every Supabase schema change in `SUPABASE_MIGRATIONS.md`.
4. Keep UI-only polish in the history only when it changes workflow or product behavior.
5. Do not mark a phase complete unless its docs describe what was built, what is still missing, and what the next integration point is.
6. Never leave temporary architectural decisions only in chat. Promote them into docs before pushing.

## Future Entry Template

```md
## YYYY-MM-DD - Short Title

Status: Planned | Implemented | Pushed | Blocked

Changed:
- ...

Why:
- ...

Files / Systems:
- ...

Validation:
- ...

Remaining:
- ...
```
