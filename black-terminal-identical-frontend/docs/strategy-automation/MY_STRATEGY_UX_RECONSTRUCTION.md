# My Strategy UX Reconstruction

## Outcome

`MY STRATEGY` now opens a strategy library. Creation is a ten-step guided workflow; published strategies open into an operating cockpit. The former `StrategyAutomationPanel` is no longer mounted by `StrategyLabPage` and remains only as a deprecated compatibility reference while the new surface is certified.

## Frontend audit

| Existing surface | Classification | Result |
| --- | --- | --- |
| `StrategyLabPage` | Reused and reorganized | Owns the seven primary Strategy Lab sections and the research subnavigation. |
| `StrategyAutomationPanel` | Deprecated | Removed from the rendered product workflow; no new behavior was added to it. |
| `strategyAutomationApi` | Reused and extended | Added explicit draft, publish and start-version operations. |
| Backtest, optimization, heatmap, AI review, code suggestions, forward test | Reused | Research utilities are nested under `RESEARCH`. |
| Paper and target backend | Preserved | Existing records, policies, idempotency and worker controls remain authoritative. |
| My Strategy UI | Reconstructed | Library, wizard and cockpit are separate component trees. |

## Product navigation

Primary navigation is `MY STRATEGY`, `BACKTEST`, `PAPER TRADING`, `LIVE AUTOMATION`, `ANALYTICS`, `RESEARCH`, and `LOGS`. A strategy cockpit uses `OVERVIEW`, `CONFIGURATION`, `PAPER`, `LIVE TARGETS`, `POSITIONS`, `TRADES`, `PERFORMANCE`, `RISK`, and `LOGS`.

The UI uses readable 12 px normal text, bounded forms, progressive disclosure, windowed large tables, and a compact target matrix. It never renders ten empty target cockpits.

## Safety boundary

Paper automation remains enabled. Live broker execution and Investment Group fan-out remain disabled. This chapter adds no broker order route and does not change the production execution flags.
