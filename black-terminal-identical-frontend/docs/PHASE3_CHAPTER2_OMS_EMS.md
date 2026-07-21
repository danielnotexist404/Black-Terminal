# Project Obsidian Phase III - Chapter 2

Chapter 2 establishes the first OMS / EMS foundation for Black Terminal.

## Implemented Foundation

- `src/execution/types.ts` now defines normalized execution requests, lifecycle states, sizing methods, execution sources, execution destinations, reports, and preview rows.
- `src/execution/omsService.ts` owns internal order state and lifecycle transitions.
- `src/execution/emsService.ts` owns validation, risk checks, allocation integration points, broker routing, reports, event publishing, and audit buffering.
- `src/execution/brokerRouter.ts` abstracts broker adapter selection.
- `src/execution/orderLifecycle.ts` enforces legal lifecycle transitions.
- `src/execution/executionAudit.ts` provides append-only in-memory audit buffering for browser/runtime events.
- `src/execution/components/UnifiedExecutionTicket.tsx` is the shared ticket entry point used by chart execution flows.

## Current Live Bridge

Browser execution still routes through the Vercel `/api/execution/order` endpoint for real broker execution. The request payload now carries Phase III fields such as source, destination, sizing method, leverage, and margin mode. The Bybit adapter rejects unimplemented future algorithms rather than silently converting them into basic orders.

## Architecture Rule

Future manual trading, AI execution, strategy automation, replay execution, paper trading, and capital allocation must integrate through this OMS / EMS pipeline. Do not create parallel execution paths.
