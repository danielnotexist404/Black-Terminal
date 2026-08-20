# Event Alpha data-source onboarding

A source is acceptable only when it supplies structured evidence, stable event IDs, publication/observation timestamps, revision semantics and a documented availability SLA.

Required review:

- contractual right to store normalized and raw evidence;
- HTTPS endpoint and exact hostname allowlist;
- secret stored server-side, never under `VITE_`;
- stable pagination cursor or watermark;
- event ID stability and revision behavior;
- UTC timestamp semantics and clock-skew bound;
- batch size, rate limits and `Retry-After` behavior;
- provider outage/quarantine plan;
- canonical asset/symbol mapping;
- source authority class (`PRIMARY`, `VERIFIED_PROVIDER`, `SECONDARY`);
- fixtures derived from non-secret synthetic examples, never production payload dumps.

The adapter must return `DISABLED` when credentials are absent. It must not scrape HTML, invent calendar events, replace failures with fixtures, follow redirects, accept HTTP, or contact a host outside its allowlist.

Raw source text is hostile data. It is size/depth bounded and prototype keys are rejected. It is never passed to shell commands, evaluated as code, or treated as instructions to an LLM or execution service.
