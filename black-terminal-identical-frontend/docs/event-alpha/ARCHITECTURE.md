# Event Alpha Engine architecture

BT-EAE-001 is a server-authoritative, point-in-time event research system. It is not a news sentiment bot and is not a second execution engine.

## Authority boundaries

1. A server adapter receives structured event evidence from a fixed allowlisted source. Public sources use no credentials; a licensed source with missing credentials reports `DISABLED`. Fixtures are never substituted in production.
2. Raw envelopes and normalized revisions are immutable. The same source/payload is idempotent; changed evidence creates a revision.
3. An expectation snapshot is admissible only when `as_of < first_actionable_at`. This is enforced in both JavaScript and PostgreSQL.
4. The surprise engine measures actual minus pre-event expectation, then the economics layer estimates supply/absorption/value-capture relevance.
5. The forecast subtracts benchmark-adjusted realized response, spread, slippage, fees, funding, and uncertainty. Its outcomes are `UNDERREACTION`, `FULLY_PRICED`, `OVERREACTION`, `AMBIGUOUS`, and `NO_TRADE`.
6. Event Alpha may produce an economic thesis. BC-RDA may only confirm tactical timing for an `ARMED` thesis with matching direction, freshness, expiry, setup identity, and cooldown.
7. Risk may create a durable **PAPER** intent. PostgreSQL rejects any other mode. No Event Alpha module imports a broker adapter or submits a venue order.

## Components

- `server/event-alpha/domain.js`: schemas, UTC/causality validation, canonical hashing, runtime policy.
- `server/event-alpha/engine.js`: robust expectation, surprise, economic impact, remaining-alpha classification, BC-RDA gate, paper risk/fill math.
- `server/event-alpha/token-unlock-adapter.js`: HTTPS/allowlisted/credentialed provider with checkpoint, timeout, retry and quarantine semantics.
- `server/event-alpha/live-source-adapters.js`: live Snapshot governance, DefiLlama protocol-revenue, and optional Tokenomist adapters.
- `server/event-alpha/market-evidence.js`: public Bybit price/turnover evidence used only for benchmark-adjusted response attribution.
- `server/event-alpha/live-assessment.js`: automatic causal expectation lookup, surprise/forecast/thesis generation, and explicit `NO_TRADE` audit decisions.
- `server/event-alpha/repository.js`: bounded projections, immutable ingestion, revisions, work queue and audit.
- `server/event-alpha/service.js`: authenticated admin mutations and safe read projections.
- `server/event-alpha/worker.js`: durable polling and `SKIP LOCKED` job processing.
- `server/event-alpha/replay.js`: deterministic point-in-time replay.
- `src/modules/event-alpha/`: read-only operator/research workspace.
- `supabase/migrations/20260820014838_phase5_event_alpha_engine.sql`: service-only ledger and state machine.
- `supabase/migrations/20260825013000_event_alpha_live_pipeline.sql`: scheduled-evidence causality, generic live ingestion, and atomic live-assessment persistence.

## Event-family status

| Family | Calculation contract | Production adapter |
|---|---:|---:|
| Token supply/unlock | Implemented | Tokenomist V5 supported; disabled until a licensed server key is configured |
| Governance | Live point-in-time probability/outcome | Snapshot GraphQL |
| Protocol economics | Live rolling-24h revenue expectation/surprise | DefiLlama free API |

No unverified scraping or synthetic fallback is permitted.
