# BT-EAE-001 completion report

## 1. Repository audit

The browser event bus, in-memory OMS and Strategy Lab backtester were inspected. They remain consumers/tools and were not promoted into persistent authority. Black Cloud/live broker execution remains separate.

## 2. Architecture delivered

Server-authoritative raw evidence → canonical revision → pre-event expectation → surprise/economics → response forecast → thesis → BC-RDA tactical gate → risk → durable paper intent/fill → immutable audit.

## 3. Domain contracts

RawEventEnvelope, canonical event/revision, expectation, asset profile, surprise, forecast, thesis, risk decision, trade intent and decision audit are represented by validated application contracts and constrained PostgreSQL tables.

## 4. Data sources

Token-unlock HTTPS adapter implemented with credentials, allowlist, checkpoint, timeout, bounded retry and quarantine. It stays disabled without configuration. No production provider was contacted. Governance/protocol adapters are not present and stay disabled.

## 5. Point-in-time correctness

Expectation timestamps are strictly before first actionable evidence. Asset-profile and market cutoffs are validated. Replay filters by knowledge/cutoff timestamp and emits a reproducible manifest hash.

## 6. Models

Deterministic robust-expectation, surprise, economic-impact and remaining-alpha v1 formulas are implemented and documented. No trained or LLM model is falsely claimed.

## 7. BC-RDA integration contract

The tactical gate requires an `ARMED`, unexpired, direction-matching thesis; fresh confirmed setup; stable setup identity; and cooldown. It is pure/server-consumable and does not modify BC-RDA's rendering/calculation engine.

## 8. Execution and risk

Paper only. Manual approval defaults on. Risk is deterministic, symbol/cost/confidence/alpha/notional/loss bounded. The database forbids non-paper intent mode. No real order path or venue call exists.

## 9. Persistence and security

Twenty service-role-only RLS tables, immutable evidence triggers, unique identities, pagination indexes, durable queue, transition CAS and explicit grants. No direct browser table access.

## 10. UI

Event Feed, Theses, Research, Health, Audit and Controls tabs added. The workspace states server authority and execution prohibitions and truthfully renders disabled/unavailable states.

## 11. Acceptance scenarios

Tests cover material unlock underreaction, fully priced positive economics, weak value capture, 98%-expected governance pass, duplicate storm, malicious source, expectation lookahead, BC-RDA cooldown/direction conflict and deterministic paper fill.

## 12. Feature flags

Engine, ingestion, token family and paper execution are false by default. Strategy and global execution kill switches default engaged; manual approval defaults required. Token adapter requires server URL/token/allowlist. There is no supported live authority; requesting it is a configuration error.

## 13. Verification boundary

Application contracts and the migration are exercised locally, including an isolated PostgreSQL-compatible runtime transaction/RLS test. This is not a production Supabase deployment or production-data test. Typecheck, production build and the cross-system regression suites remain release gates.

## 14. Deliberate non-claims

No Supabase migration was deployed, no production event-provider call occurred, no real funds/order mutation occurred, no live Event Alpha execution was tested, and no alpha profitability claim is made.

## 15. Remaining production dependencies

A licensed verified token-unlock provider, reviewed server credentials/allowlist, migration deployment, worker supervision, production observability/alerts, and a paper forward-test are required before enabling ingestion or paper execution. Governance/protocol sources need separate reviewed adapters.

The delivered replay is a deterministic point-in-time vertical-slice harness, not a survivorship-complete institutional research dataset or full walk-forward analytics product. Paper fill v1 persists one deterministic market fill and its paper position; partial-fill, cancellation, rejection, position-close reconciliation, funding, daily-loss/drawdown portfolio accounting, and venue-liquidity simulation remain unavailable and therefore cannot be described as production-complete. The Event Alpha UI is an operator evidence/control workspace; the full requested CAR/calibration/capacity analytics surface depends on verified historical datasets that are not present in this repository.

## 16. Measured local performance evidence

`npm run benchmark:event-alpha` executes 20,000 deterministic normalize → surprise → remaining-alpha kernel iterations. The release report must quote the result from the final run only. It is local kernel evidence, not persistent-I/O, API, browser, source-provider, VPS-capacity or profitability evidence.

Final local run on Node 22.23.1: 20,000 iterations in 647.099 ms; 30,907.2 iterations/second; p50 0.0272 ms, p95 0.0499 ms, p99 0.1369 ms; observed RSS delta 15.22 MiB. Persistent I/O, API latency, browser latency and host capacity were not measured.
