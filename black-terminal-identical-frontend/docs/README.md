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
- `BYBIT_MAINNET_ENVIRONMENT_SETUP.md` - Bybit mainnet validation env, worker, verifier, and emergency-disable guide.

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
- `PHASE3_IMM_OPERATIONAL_READINESS.md` - IMM health endpoint, worker heartbeat, integrity validation, verification command, and data-trust readiness.
- `PHASE3_CHAPTER8_IMM_POLISH.md` - DOM Pro+ workspace presets, camera controls, keyboard shortcuts, and IMM status strip.
- `PHASE3_CHAPTER9_PERFORMANCE.md` - Black Core performance monitor, hidden HUD, baseline report, and long-session stress harness.
- `PHASE3_CHAPTER10_AUDIT_AND_LIVE_READINESS.md` - architectural audit, integration review, controlled Hyperliquid mainnet validation mode, and production-readiness checklist.
- `PHASE3_CHAPTER11_UNIVERSAL_CONNECTIVITY.md` - venue certification matrix, universal connectivity truth states, and production adapter gating.
- `PHASE3_CHAPTER12_EXCHANGE_CERTIFICATION.md` - Wave 1 exchange certification implementation, Bybit diagnostics, and mainnet execution gates.
- `PHASE3_CHAPTER13_VENUE_NATIVE_EXECUTION_TICKET.md` - capability-driven venue ticket, Bybit functional parity, live instrument rules, and execution algorithm registry.
- `PHASE3_CHAPTER14_PERFORMANCE_STABILITY.md` - Black Core telemetry, bounded workers/resources, execution priority, hidden-panel suspension, and soak testing.
- `PERFORMANCE_BASELINE_CHAPTER14.md` - pre-change source/build baseline and scenario measurement boundaries.
- `PERFORMANCE_RESULTS_CHAPTER14.md` - measured post-change results, regressions, soak status, and remaining bottlenecks.
- `REACT_RENDER_AUDIT.md` - high-frequency React ownership and render-path findings.
- `MEMORY_LEAK_AUDIT.md` - resource lifecycle, retention rules, fixes, and repeatable leak procedure.
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
# Latest DOM Pro Chapter

The final Phase III DOM Pro refinement adds independent panel settings, coordinated cockpit presets, stable structural depth/walls/CVD/metrics, one centralized panel scheduler, and deterministic regression coverage. Start with `PHASE3_FINAL_DOM_PRO_FIXES_OPTIMIZATION.md`.

# A.I.F. Auction Intelligence

Phase IV begins with the chart-native A.I.F. long-horizon auction engine. Start with `PHASE4_CHAPTER1_AIF_LONG_HORIZON_PROFILE_ENGINE.md`, then use the profile, timeline, CHoB, provenance and benchmark references alongside it.

The critical chart-coordinate and automatic 20,000-bar initialization contract is documented in `PHASE4_CHAPTER1A_AIF_PRICE_SYNCHRONIZATION.md`.

# DOM Pro Performance Recovery

- `PHASE3_DOM_PRO_FINAL_PERFORMANCE_RECOVERY.md` - implementation, safety and acceptance contract.
- `DOM_PRO_FINAL_PERFORMANCE_BASELINE.md` - measured pre-change failure and bottlenecks.
- `DOM_PRO_FINAL_PERFORMANCE_RESULTS.md` - before/after trace and soak evidence.
- `DOM_PRO_RENDER_PIPELINE.md` - source, worker, scheduler, canvas and retention ownership.
- `DOM_PRO_WORKER_BACKPRESSURE.md` - latest-wins queue and transfer contract.
