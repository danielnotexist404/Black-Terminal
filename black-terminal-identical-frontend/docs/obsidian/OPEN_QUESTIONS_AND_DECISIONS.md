# Obsidian Open Questions and Decision Register

Status: authoritative pre-implementation register as of 2026-07-21.

## Confirmed principles

- Protocol before native wallet; external-wallet compatibility first.
- One permanent public vault identity per approved investment group.
- Investors retain economic claims; operators receive restricted trading authority only.
- No manager withdrawal, arbitrary transfer, arbitrary call, upgrade power or principal redirection.
- Every deposit has immutable tranche terms; changed terms require explicit consent/new version.
- Performance fees use high-water marks and never treat principal as profit.
- Epoch-based settlement is favored for the first derivatives vault.
- No public deposits before independent audits and qualified legal review.
- Black Cloud, Supabase, frontend storage, analytics and support never receive seed phrases/raw private keys.

## Preferred architecture (not final)

- one permanent master vault per group;
- pooled execution with isolated per-deposit-tranche accounting;
- one chain, one settlement asset candidate, one researched adapter/venue, BTC/ETH, low leverage and hard caps;
- typed intents, expiring scoped operator keys, independent guardian, timelocked multisig governance;
- explicit epochs with no default automatic rollover.

## Unresolved decisions

| Area | Decision required |
|---|---|
| Legal/entity | jurisdiction, operating entities, investor categories, licensing and marketing perimeter |
| Chain/venue | chain, perpetual venue, oracle, liquidation/keeper and finality assumptions |
| Vault isolation | ledger-only tranches versus sub-vaults; pooled loss and insolvency treatment |
| Claim form | fungible shares, restricted shares, NFT/non-transferable tranche record or combination |
| ERC-4626 | exact compatibility and truthful asynchronous preview/withdraw semantics |
| Accounting | canonical NAV components, snapshot frequency, price hierarchy, tolerances and audit source |
| HWM fees | gross versus post-fee HWM update, fee-share versus asset payment, crystallization frequency |
| Epochs | durations, deposit escrow, close-only period, queue ordering, settlement deadline and rollover |
| Liquidity | reserves, in-kind payout, partial settlement and impairment waterfall |
| Risk | leverage/exposure/loss/drawdown formulas and cross-position aggregation |
| Governance | immutability/proxy choice, thresholds, signer identities, timelocks, veto and migration consent |
| Guardian | quorum, reduce/close authority and exact emergency triggers |
| Privacy | public investor/tranche data, analytics, sanctions screening and data retention |
| Wallets | supported connection protocols, permits/allowances, recovery and smart-account scope |

## Rejected approaches

- direct transfers to a manager-controlled wallet;
- general `execute(target, calldata)` or unrestricted token approvals;
- operator/governance power to rewrite active tranche terms;
- a single vault-wide HWM for investors entering at different prices;
- describing the product as risk-free, fully self-custodial after deposit, or ordinary staking;
- building a proprietary DEX for the first version;
- storing investor seed phrases or raw keys in Black Terminal/Black Cloud/Supabase;
- public/mainnet capital before audits and legal clearance;
- claiming novelty without research.

## Contradictions and tensions found

1. **“Investor retains ownership” versus asset custody:** after deposit, tokens are held by the vault; the investor retains an economic claim, not possession of the same tokens. UX must say this precisely.
2. **Permanent master vault versus immutable terms:** an upgradeable permanent address could change behavior. Version-pinned claims, immutable modules or opt-in migration must resolve this.
3. **Pooled liquidity versus isolated PnL:** truly pooled trading shares common gains/losses. “Precise individual PnL” cannot mean independent trading outcomes unless sub-vaults or allocation rules create real segregation.
4. **Independent 90-day locks versus pooled derivatives liquidity:** maturity cannot always provide immediate cash. Epoch queues and conservative settlement are needed.
5. **Fungible ERC-4626 shares versus tranche-specific terms/HWMs:** freely fungible shares may erase term provenance. Claim representation is unresolved.
6. **Operator may close risk versus cannot transfer assets:** some venue exits require swaps/withdrawals. These must be typed settlement actions with fixed destinations, never general authority.
7. **No retroactive changes versus emergency/migration:** emergencies may impair timing/value but cannot rewrite beneficiary or undisclosed economics; the impairment waterfall must be pre-agreed.
8. **25% positive-profit fee versus per-share pooled accounting:** deposits and partial redemptions can game a global HWM. Per-tranche or equalization accounting is required.

## Assumptions requiring validation

- a suitable on-chain perpetual venue can support restricted adapter calls and reliable full-state reconciliation;
- one settlement asset is legally and technically suitable and its depeg/freeze risk acceptable;
- pooled execution with tranche-level HWM is mathematically fair and gas-feasible;
- reliable manipulation-resistant derivatives NAV can be produced at epoch boundaries;
- locks, queues and fee arrangements are lawful for intended users/jurisdictions;
- wallet clients render required typed disclosures consistently;
- emergency close actions can be bounded without creating extraction authority;
- users understand that deposited assets leave their ordinary wallets.

## Security blockers

Unselected venue/oracle/chain; unresolved claim representation and HWM mechanism; no executable accounting model; no proofs/tests/audits; undefined governance/guardian topology; undefined insolvency/emergency valuation; no verified adapter design; no incident runbook or monitoring implementation.

## Legal-review blockers

No entity/jurisdiction/user classification; no analysis of custody, collective investment/fund, portfolio/order execution, derivatives, performance-fee, KYC/AML/sanctions, disclosures/marketing, tax or data-protection obligations. These block any public-capital or production claim.

## Future research

Standards, comparable products, incidents, venue/chain/oracle candidates, economic attacks, account abstraction, wallet security, tokenized funds and patent/prior art must be reviewed from dated primary sources with an evidence ledger.

## Implementation prerequisites

Close the critical open decisions; obtain multidisciplinary specification approval; build and validate the offline reference model; obtain legal direction; select/research dependencies; map every threat to controls/tests; authorize only the smallest no-value experiment; then follow `OBSIDIAN_SECURITY_AND_AUDIT_PLAN.md`.
