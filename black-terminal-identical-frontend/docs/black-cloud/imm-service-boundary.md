# Future IMM Service Boundary

Repository evidence identifies IMM as Institutional Market Map: persistent market-depth memory, rollups, liquidity walls, replay and operational status. Existing status is served by `/api/imm/status`; AIF explicitly reports unavailable when depth memory is absent.

The future local IMM node must connect outbound over a private authenticated network. Black Cloud will own durable jobs/results and expose a narrow claim/heartbeat/complete protocol. The intended abstractions are `ImmGateway`, `ImmJobService`, `ImmResultRepository` and `ImmHealthService`.

A job requires stable job/idempotency IDs, schema versions, input hash/reference, model requirement, priority, availability/deadline/TTL, bounded attempts, status, claimant and timestamps. A result requires matching job/input hash, model/version, output schema/hash, worker identity, duration and bounded error fields. Claim and completion must be transactional, fenced and replay-safe.

The IMM identity receives no database/service-role/exchange credentials, Docker socket, shell access or withdrawal capability. Use mTLS or equivalent private identity, short-lived scoped tokens, request signatures, replay protection, rate limits and audited key rotation.

Current deployment is intentionally:

```text
IMM_ENABLED=false
IMM_REQUIRED=false
```

Disabled/unreachable IMM returns explicit `UNAVAILABLE`, never fixtures, random output or stale data presented as current. Black Cloud boot and unrelated BC-RDA/Event Alpha functionality remain available.
