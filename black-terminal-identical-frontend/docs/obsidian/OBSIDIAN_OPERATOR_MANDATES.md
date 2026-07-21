# Obsidian Operator Mandates

Status: authorization specification; no signing or execution implementation exists.

## Mandate contents

A versioned mandate binds vault, chain, controller, operator/session key, valid interval, term compatibility, adapters, venues, assets, markets, action set, position direction if limited, gross/net exposure, per-market concentration, leverage, slippage, daily loss, drawdown, order types, protection policy and nonce policy.

## Mandate lifecycle

| From → To | Actor | Preconditions | Event | Consequence / failure |
|---|---|---|---|---|
| DRAFT → PUBLISHED | group proposer/governance | complete immutable proposal | `MandatePublished` | content hash fixed; corrections require a new version |
| PUBLISHED → ACCEPTED | authorized investor/vault policy | disclosure and signature valid | `MandateAccepted` | acceptance applies only to bound terms/tranche |
| ACCEPTED → ACTIVE | controller | vault/epoch active and operator key valid | `MandateActivated` | trading scope begins; otherwise remains ACCEPTED |
| ACTIVE → SUSPENDED | guardian/governance/automatic risk gate | pause trigger | `MandateSuspended` | no new exposure; explicitly permitted reduce-only remains |
| SUSPENDED → ACTIVE | governance/controller | remediation, delay and validity | `MandateResumed` | scope cannot broaden |
| ACTIVE/SUSPENDED → EXPIRED | controller/time | `now >= validUntil` | `MandateExpired` | terminal for new trades; reconciliation/close policy persists |
| ACTIVE/SUSPENDED → REVOKED | governance or authorized revoker | valid revocation | `MandateRevoked` | terminal for new trades; cannot strand monitoring |
| DRAFT/PUBLISHED/ACCEPTED/ACTIVE/SUSPENDED → SUPERSEDED | governance | newer version published/accepted as required | `MandateSuperseded` | existing tranche rights unchanged; old signatures invalid prospectively |

No transition out of `EXPIRED`, `REVOKED`, or `SUPERSEDED` restores authority. A new version is required.

## Allowed calls

No `execute(target, arbitraryCalldata)` capability is permitted. Candidate typed actions are `openPosition`, `reducePosition`, `closePosition`, `placeLimitOrder`, `cancelOrder`, `updateProtection`, and narrowly defined `swapApprovedAsset` for settlement only.

Every action validates vault/operator identity, mandate and contract version, chain/domain, signature, nonce, deadline, adapter/venue status, asset/market, action-specific parameters, leverage/exposure/concentration, slippage, daily loss/drawdown, NAV freshness, vault state and emergency state.

## Typed intent envelope

The conceptual signed domain binds chain ID, verifying controller address, protocol name/version and vault. The message binds mandate hash/version, intent ID, action, structured parameters, nonce, issued time and deadline. Nonces are consumed atomically before external effects and remain consumed on an ambiguous submission until reconciliation proves the outcome.

Cross-chain, cross-vault, cross-controller and cross-version replay must fail. Signature malleability and smart-contract signature validation require explicit handling.

## Trade-intent lifecycle

| From → To | Actor | Preconditions | Event | Failure/irreversibility |
|---|---|---|---|---|
| CREATED → SIGNED | operator | typed intent complete | `IntentSigned` | signature binds immutable payload |
| SIGNED → VALIDATING | relayer/controller | format/domain/deadline plausible | `IntentValidationStarted` | malformed input → REJECTED |
| VALIDATING → APPROVED | controller | all policy/risk checks pass | `IntentApproved` | nonce reserved/consumed atomically |
| VALIDATING → REJECTED | controller | any check fails | `IntentRejected` | terminal; reason recorded |
| APPROVED → SUBMITTED | controller/adapter | adapter enabled and call accepted | `IntentSubmitted` | external ambiguity is not automatically FAILED |
| SUBMITTED → PARTIALLY_FILLED | adapter/reconciler | authoritative venue evidence | `IntentPartiallyFilled` | residual remains bounded by original intent |
| SUBMITTED/PARTIALLY_FILLED → FILLED | reconciler | authoritative completion | `IntentFilled` | execution result immutable |
| SIGNED/APPROVED/SUBMITTED/PARTIALLY_FILLED → CANCELLED | authorized actor/controller | cancellation permitted and venue confirms | `IntentCancelled` | filled quantity remains real |
| APPROVED/SUBMITTED/PARTIALLY_FILLED → FAILED | controller/reconciler | definitive non-execution/failure | `IntentFailed` | no blind retry with same external client ID |
| FILLED/CANCELLED/FAILED → RECONCILED | reconciler | balances/orders/positions agree | `IntentReconciled` | terminal accounting evidence stored |

`RECONCILED` is terminal. Timeout or lost response stays ambiguous until venue-authoritative reconciliation; duplicate execution is prohibited.
