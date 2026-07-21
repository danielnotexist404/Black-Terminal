# Obsidian Epoch and Redemption Model

Status: preferred first-release model; details remain subject to security, economic and legal review.

## Terminology

Use “strategy-vault allocation,” “locked strategy deposit,” or “managed vault participation,” not “90-day staking.” The assets support a managed strategy and may be exposed to trading loss.

## Model comparison

An independent fixed-duration lock gives every tranche a maturity timestamp but can create continuous, unpredictable liquidity demands while derivatives collateral is encumbered. An epoch model batches entry, risk, valuation, fees and redemptions into explicit windows.

Recommendation: the first derivatives experiment should use epochs with independent tranche maturity. Maturity grants eligibility to elect redemption at an available window; it does not guarantee instant transfer while positions are open, collateral is encumbered, a chain/venue is halted, or NAV is disputed.

## Epoch phases

1. **Deposit window:** terms and target epoch published; requests escrowed or admitted under a finalized entry NAV.
2. **Activation:** cap verified, shares/tranches finalized, lock starts under disclosed timestamp rule.
3. **Active epoch:** strategy actions permitted within mandate; redemption elections may be recorded but not paid.
4. **Close-only period:** no exposure increase; orders canceled or positions reduced under settlement policy.
5. **NAV crystallization:** balances, positions, funding, fees and liabilities reconciled at defined sources/times.
6. **Fee crystallization:** HWM fees calculated only after valid NAV.
7. **Redemption window:** matured elected tranches become redeemable as liquidity permits.
8. **Rollover/subscription:** continued participation requires the already-accepted rule or explicit consent to a new tranche/version.

## Required timestamps

Every tranche records request time, accepted term version, deposit finalization, lock start, earliest maturity, redemption election, settlement start, NAV time, fee time, redeemable time and redeemed time. Timestamp source and boundary semantics (`>=`, timezone-independent Unix time, block-time tolerance) must be tested.

## Rules

- No manager or governance action may retroactively extend an active tranche.
- A new term version requires an explicit investor signature and normally a new tranche.
- Maturity never authorizes double redemption or bypasses settlement reconciliation.
- Settlement reserves matured liabilities before capital is rolled or redeployed.
- Pro-rata queues must not favor related parties or transaction-order frontrunners.
- A failed payout preserves the investor claim and cannot mark it redeemed.
- Emergency claims preserve beneficiary and recorded terms but may use a disclosed impairment/waterfall process.

## Rollover

Default first-release recommendation: no automatic rollover. A matured investor explicitly chooses redemption or signs a new term/tranche. If future auto-roll exists, opt-in, cancellation cutoffs and changed terms must be conspicuous and revocable before activation.

## Open decisions

Epoch length, subscription escrow, liquidity buffer, queue ordering, maximum settlement delay, in-kind redemption, forced deleveraging policy, disputed NAV resolution and chain/venue outage calendars remain unresolved.
