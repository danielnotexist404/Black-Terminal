# Event Alpha security and threat model

## Protected assets

Provider credentials, immutable source evidence, expectation timing, model manifests, thesis state, risk decisions, paper intent identity and decision audit.

## Threats and controls

- **Prompt/source injection:** raw text is treated as hostile data, bounded by size/depth, prototype keys rejected, never executed or granted LLM/order authority.
- **Lookahead leakage:** expectation `as_of < first_actionable_at` in application and database; replay filters every input by its knowledge timestamp.
- **Duplicate/revision storms:** stable hashes and unique constraints; duplicate payload replay is idempotent, changed payload becomes a numbered revision.
- **SSRF/credential exfiltration:** HTTPS only, no URL credentials, exact hostname allowlist, literal local/private IPs and local hostnames rejected, redirects rejected, JSON content type and two-MiB response limit enforced, bounded timeout/retries, authorization never logged.
- **Browser authority:** RLS enabled; `public`, `anon`, and `authenticated` receive no table grants. Authenticated routes expose bounded safe projections; mutation requires server-verified admin identity.
- **Execution escalation:** database intent mode is constrained to `PAPER`; runtime live flag is always false and unsafe configuration is rejected. Independent ingestion/family/paper rollout gates and strategy/global kill switches default closed. No broker adapter is imported.
- **Worker races:** claims use `FOR UPDATE SKIP LOCKED`, leases, worker identity and fenced completion updates.
- **Audit tampering:** raw evidence, revisions, expectations, transitions, risk decisions, fills and decision audit reject update/delete.

The service role remains high privilege and must be isolated to server/worker processes. The migration uses invoker-rights RPCs with execute revoked from browser roles.
