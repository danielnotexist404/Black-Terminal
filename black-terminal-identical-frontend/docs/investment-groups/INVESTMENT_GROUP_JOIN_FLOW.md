# Investment Group join flow

The UI implements five explicit stages: risk acknowledgement, method selection, method configuration, consent review and approval/activation.

Progress is stored in `investment_group_join_drafts`; a draft cannot execute trades. Risk acceptance is stored separately and must match the active server document version and hash. Copy Trading then requires a server-certified supported connection, risk policy and final idempotent consent. The service creates one membership, one versioned risk policy and one versioned mandate. Auto-accept groups activate only when all eligibility conditions are still true; approval groups remain `PENDING_APPROVAL` until an authorized manager rechecks them.

The browser never receives broker secrets. Missing connectivity routes back to `Positions -> Connection Manager` while preserving the draft. Obsidian selection stops at research/waitlist and cannot produce a membership or mandate.
