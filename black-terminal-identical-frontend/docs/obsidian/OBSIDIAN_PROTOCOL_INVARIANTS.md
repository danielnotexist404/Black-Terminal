# Obsidian Protocol Invariants

Status: normative properties for later models, property tests and formal verification.

## Authority and custody

1. An operator cannot transfer vault assets to an arbitrary address.
2. No operator action accepts arbitrary target, calldata, selector or spender.
3. Trading cannot grant, broaden or delegate operator authority.
4. A guardian cannot redirect assets or change a beneficiary.
5. Governance cannot activate an upgrade before its timelock.
6. An adapter disabled at time `t` receives no new capital or exposure after `t`.
7. An expired, revoked, suspended or superseded mandate cannot authorize new exposure.
8. Black Cloud or a UI signature cannot override on-chain policy.

## Terms and claims

9. Existing tranche terms, maturity, fee rate, HWM basis and beneficiary cannot change retroactively.
10. Rollover or migration requires the consent defined by the accepted terms and cannot silently mutate the old tranche.
11. An investor cannot redeem before eligibility except through a formally declared emergency path.
12. A failed asset transfer cannot consume or mark a claim redeemed.
13. A tranche/share unit cannot be redeemed twice.
14. `sum(active tranche claims) + accrued fees + other liabilities` reconciles to NAV within an explicit bounded valuation/rounding tolerance.

## Fees and accounting

15. Principal and new deposits never count as performance profit.
16. Performance fee is zero when value does not exceed the applicable HWM.
17. The same unit of profit cannot be charged twice.
18. Funding, trading costs and attributable liabilities reduce eligible profit before performance fee.
19. Depositing or redeeming cannot transfer pre-existing gains/losses between tranches beyond disclosed pooled investment performance.
20. Stale/disputed NAV cannot finalize minting, performance fees or redemption amounts.
21. Aggregate rounding extraction is bounded by the documented tolerance and cannot favor the fee recipient.

## Execution and risk

22. The same signed intent cannot execute twice on any supported domain.
23. A signature valid for one chain, controller, vault, mandate or version is invalid for every other domain.
24. A paused/emergency vault cannot increase gross exposure.
25. Every exposure-increasing action leaves leverage, concentration, market, venue and capital values within mandate limits.
26. Timeout/ambiguous submission cannot be retried until authoritative reconciliation resolves it.
27. Recorded balances, orders and positions converge to venue-authoritative state or the vault remains paused.

## Lifecycle

28. Only documented state transitions occur and each transition is atomic.
29. Terminal states cannot regain authority.
30. Maturity creates eligibility, not fictitious liquidity.
31. Emergency controls preserve claim ownership and cannot create a privileged exit.

## Verification mapping

Each invariant needs: a reference-model assertion; positive and negative unit tests; stateful property/fuzz tests; adversarial economic simulation where relevant; and, for custody/authority/accounting invariants, symbolic or formal proof against deployed bytecode and upgrade paths. Any unprovable critical invariant blocks release.
