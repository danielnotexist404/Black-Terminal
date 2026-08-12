# Investment Group security and RLS

Protected API wrappers enforce authentication, request-size limits and rate limits. Services verify group/member authority, schemas and idempotency; manager policy changes also enforce optimistic versions. Removal and emergency controls require a recent session.

RLS permits public group profile data and a member's own membership, risk and raw portfolio snapshot data. Raw member snapshots remain member-only at the table policy: authorized managers receive group-attributed and consent-shaped data through the protected server cockpit API, which removes exact account equity, available balance and wallet balance unless `FULL_SELECTED_ACCOUNT` consent is active. It prevents ordinary members from reading another member. Broker secret tables are not joined by this service.

Permanent invariants:

- `allow_withdrawals = false` and `allow_asset_transfers = false` on every group mandate.
- Connections with withdrawal/transfer capability are ineligible.
- No React component receives credentials or service-role material.
- No manager cap can exceed a member mandate.
- Current membership and mandate are re-read immediately before execution.
- Audit metadata is identifier/policy/health data, not secret payloads.
- Obsidian has no financial activation surface.

The forward migration enables RLS on every new table and grants service-role execution only for atomic exit/removal/emergency functions.
