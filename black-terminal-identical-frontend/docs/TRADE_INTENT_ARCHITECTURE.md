# Trade Intent Architecture

Investment Group managers submit strategy intent, never follower quantities. The authenticated control plane verifies group authority, validates a strict payload, sets a seven-day maximum validity window, canonicalizes the intent and signs it with the server-held signing key.

The Black Cloud worker verifies the hash and signature, expands the intent only to active mandates and creates one follower plan per mandate. Each plan calculates quantity from follower equity or available margin, applies venue precision and passes the full risk/capability gate.

Idempotency is layered:

1. group and client intent ID identify the intent;
2. intent, mandate, connection, version and leg identify the follower execution;
3. a deterministic `bt-grp-*` client order ID identifies the venue order;
4. unique database constraints prevent duplicate plans and commands;
5. an ambiguous submission is queried by deterministic client ID before retry.

The exchange acknowledgement is persisted in the canonical OMS `execution_orders` table with `INVESTMENT_GROUP` origin. The browser only displays intent, plan and audit state.
