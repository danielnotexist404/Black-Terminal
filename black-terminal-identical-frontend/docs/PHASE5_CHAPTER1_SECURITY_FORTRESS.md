# Phase V Chapter I — Security Fortress

Status: Implemented and production-validated on 2026-07-20. Final provider-name cutover and exposed Resend-key revocation require new values from the provider account owner.

Production deployment: `dpl_9GCZhTrzk41EZ3rdE4MB7gmwHwYf` at `https://www.black-terminal.live`.

## Security Boundary

Black Terminal now treats the browser and all browser-supplied data as untrusted. Provider credentials, email HTML, email recipients, AI model selection, AI system instructions, rate-limit state, administrative user mutation, and security-audit insertion are server-owned.

The shared API security layer provides:

- strict production CORS for `black-terminal.live`, `www.black-terminal.live`, `tauri://localhost` and `https://tauri.localhost`;
- development origins only outside production or behind an explicit override;
- Supabase JWT verification and profile-based suspended/tier/permission checks;
- per-instance and persistent per-user/IP/endpoint rate limits;
- declared and measured payload-size limits;
- uniform no-store, nosniff, frame, referrer and permissions headers;
- safe error responses and classified security events with hashed IP addresses;
- metadata filtering that excludes passwords, secrets, tokens, credentials, prompts, messages, HTML and authorization headers.

Execution, exchange-account, Hyperliquid and Black Cloud mutations additionally use strict Zod contracts. Unknown fields, unsupported enum values, invalid/negative quantities, unbounded strategy parameters and incorrect high-risk consent phrases are rejected before route logic runs. The production build executes deterministic positive and negative contracts for all 24 mutating route/action combinations.

All twelve Vercel functions are authenticated or service-token protected. The exchange, execution, portfolio, network, Hyperliquid, Black Cloud, IMM, market-depth, AI, email, audit and admin surfaces pass through centralized policy enforcement. Worker-only depth ingest/prune operations retain their dedicated service token and add anonymous/IP rate enforcement.

## Secret Isolation

The former browser-side Resend client and arbitrary email API were removed. `/api/email/send` accepts only strict template identifiers and bounded template data. The server chooses sender, recipient, subject and HTML. Cross-user delivery is limited to an authorized Investment Group invitation; security alerts use a fixed server-owned recipient.

`/api/claude` now requires a Supabase session, builds the system prompt on the server, enforces server model/token policy by authenticated tier, validates a bounded message/context schema, and applies persistent minute/day quotas. The browser cannot choose the model or system instruction.

The production asset audit confirmed:

- zero Resend credentials;
- zero Anthropic credentials;
- no direct `api.resend.com` call;
- no sensitive provider `VITE_*` references in frontend source;
- no private key or service-role JWT pattern.

Vercel classifies the legacy provider variables as Sensitive and intentionally will neither reveal nor rename them. Server code temporarily accepts those legacy names only through `process.env`; Vite has no `import.meta.env` reference, so they are not bundled. `RESEND_API_KEY`, `RESEND_FROM` and `CLAUDE_API_KEY` take precedence as soon as fresh values are entered.

The previously exposed Resend key is restricted to sending and returned `restricted_api_key` when an automated rotation was attempted. It cannot create or revoke provider keys. The account owner must create a replacement sending key in Resend, add it as `RESEND_API_KEY` in Vercel Production and Preview, verify a server-side notification, then revoke the old key and remove `VITE_RESEND_API_KEY`. The same dashboard cutover can move the non-exposed Claude value to `CLAUDE_API_KEY` and sender value to `RESEND_FROM`, after which the remaining legacy names can be removed.

## Authentication and Administrative Access

Supabase Auth is the only password authority. The migration linked all existing `bt_users` profiles to `auth.users`, installed the profile trigger, removed `bt_users.password`, revoked anonymous profile access and restricted authenticated profile updates to non-privileged columns. Product tier, role, permissions, suspension, indicator grants, user creation and deletion are controlled by the authenticated admin API.

Legacy audit writes now go through `/api/security/audit`; direct anonymous/authenticated access to `bt_audit_logs` is revoked. Admin user and audit routes are consolidated behind `/api/security/[action]` to remain within the Vercel Hobby twelve-function limit.

## Database Foundation

The live public schema was exported with PostgreSQL 17 and stored as `supabase/migrations/000000_baseline.sql`. It was registered as already applied before any forward migration ran.

Applied migration chain:

1. `000000_baseline.sql` — exact live public-schema baseline, registered only.
2. `202607190001_phase5_security_imm_foundation.sql` — missing IMM memory, snapshots, deltas, rollups, statistics, walls, events and collector state.
3. `202607190002_phase5_black_cloud_execution_foundation.sql` — Black Cloud connections, mandates, intents, commands, attempts, incidents, reconciliation, audit and secret-reference foundation.
4. `202607190003_phase5_security_fortress.sql` — Auth/RLS hardening, persistent API and AI limits, classified security audit, AES-256-GCM vault and retention.
5. `202607190004_phase5_security_verification.sql` — production invariant assertions and bounded retention sweep.
6. `202607200001_phase5_compressed_audit_archive.sql` — explicit compressed extended storage and access assertions for the cold execution-audit tier.
7. `202607200002_phase5_audit_redaction_guard.sql` — database-enforced recursive secret/prompt/raw-payload redaction for all audit ledgers.

The verification command reports 24/24 required Phase V tables. Remote migration history matches all seven local versions.

## Broker Vault

`broker_secret_vault` stores only AES-256-GCM ciphertext, a 96-bit IV, authentication tag, version and lifecycle metadata. Encryption keys remain in server/KMS environment variables. Client roles have no table privileges. `broker_secret_references` exposes only safe reference metadata and never decrypted credential material. Withdrawal-enabled credentials are rejected.

## Audit Retention

`execution_audit_logs` is the 90-day hot ledger. Older rows move in bounded batches to the server-only `execution_audit_archive`; its long text and JSON evidence use PostgreSQL compressed extended storage, and archive rows plus classified security events older than one year are deleted. A low-frequency insert trigger performs maintenance incrementally, and the verification migration ran an immediate bounded sweep.

Security events record identity, event class, endpoint, severity, hashed IP and safe bounded metadata. Client-supplied audit prose is no longer stored; descriptions are selected by the server. Private-stream audits retain only normalized event identifiers and outcomes, not raw provider events. Application sanitizers and database triggers recursively redact sensitive keys and provider-key/JWT patterns. AI prompts, email HTML, raw provider payloads, secrets, tokens and credentials are prohibited.

## Browser, Vercel and Tauri Hardening

Vercel sends a restrictive CSP plus nosniff, deny-frame, strict referrer and permissions policies. The API additionally uses no-store responses and origin-aware CORS. Production runs Node `22.x`.

Tauri now has a non-null CSP, an explicit minimum capability file (`core:default` only), no opener plugin, and a two-command IPC surface. Webhook and public-market requests require HTTPS on port 443, do not follow redirects, use DNS resolution pinned to public addresses, reject private/special-use IPv4 and IPv6 ranges, enforce connection/total timeouts, and bound webhook request and market response sizes.

Rust 1.97.1 was installed locally. `cargo fmt`, locked dependency metadata and lockfile regeneration pass, the dependency-free SSRF address-policy test configuration passes a direct Rust metadata compile, and the obsolete opener dependency is absent. A temporary SHA-256-verified Zig 0.16.0 toolchain advanced `cargo check` through Rust dependency compilation; the remaining host-only blocker is the absence of Zorin/Ubuntu GLib/WebKit development packages and `pkg-config`, which require sudo. Install `build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`, then run `npm run check:rust` for the final native compile gate.

## Polling and Write-Churn Investigation

The live pre-change table statistics showed extreme sequential scans on `exchange_accounts`, `bt_users`, balances and risk controls. The principal frontend causes were frequent profile/permission and portfolio polling.

Changes:

- admin users: Realtime primary, 60-second missed-event repair;
- current-user authorization: filtered Realtime primary, five-minute repair;
- portfolio snapshots: 15 seconds visible and 60 seconds hidden instead of five seconds;
- visibility-aware cleanup remains on every interval/subscription;
- market-data one-second loops remain only where they represent live exchange fallback feeds, not Supabase profile/database polling.

## Verification Evidence

- `npm run typecheck` — passed.
- `npm run security:contracts` — 24/24 mutating route contracts plus negative payload, audit-redaction and CORS controls passed.
- `npm run build` — passed on Vite 8 and Node 22.
- `npm audit` — zero vulnerabilities.
- `npm run security:audit` — 18 production assets clean.
- `npm run security:verify-migrations` — 24/24 live tables.
- Supabase verification migration — passed all Auth/RLS/vault/retention assertions.
- production headers — CSP, nosniff, referrer, permissions and deny-frame present.
- production CORS — both web origins and both explicit Tauri origins return approved preflight 204; localhost and unapproved origins return 403.
- unauthenticated AI, email, IMM, depth, admin and audit requests — 401.
- removed `/api/send-email` — 404.
- anonymous `bt_users` REST request — denied with PostgreSQL `42501`.
- production function count — 12/12 Hobby limit.

## Threat Model

The defended trust boundaries are an untrusted browser/webview, authenticated but potentially malicious users, compromised client state, abusive automation, provider failure, database-role misuse, SSRF through desktop IPC, and accidental logging or bundling of credentials. Serverless functions, Supabase service-role operations and the long-running Black Cloud worker are privileged and must receive secrets only through environment-managed values. The design does not treat CSP, client validation or obscurity as authorization controls.

## Future Security Roadmap

- move vault master keys to a managed KMS/HSM with envelope encryption, automatic rotation and revocation drills;
- add managed WAF/bot controls and centralized distributed rate limiting before institutional traffic;
- schedule retention sweeps and encrypted object-storage exports with legal-hold support and restore testing;
- add dependency provenance/SBOM, SAST, DAST, secret-history scanning and signed release artifacts in CI;
- commission independent web, Supabase RLS, desktop IPC and trading-control penetration tests;
- establish security alert routing, incident response runbooks, access reviews and disaster-recovery exercises.

Trading calculations, AIF logic, HDLX logic, DOM Pro rendering and execution semantics were not changed. DOM Pro/IMM edits are limited to authenticated API token transport and status/replay access.
