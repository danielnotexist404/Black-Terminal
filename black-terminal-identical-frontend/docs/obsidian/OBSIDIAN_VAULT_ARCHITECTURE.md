# Obsidian Vault Architecture

Status: conceptual reference architecture; no contracts exist.

## Model comparison

| Criterion | A: pooled master vault | B: individual vault per allocation/investor | C: master vault plus isolated tranches/sub-vaults |
|---|---|---|---|
| Public group identity | Strong | Fragmented | Strong |
| Capital/margin efficiency | High | Low | Medium-high |
| Claim isolation | Accounting-dependent | Strong | Strong if correctly designed |
| Personalized terms | Complex | Natural | Natural per tranche |
| Gas/operations | Lower | Higher | Medium |
| Failure containment | Shared | Strong | Depends on capital segregation |
| Reconciliation | One pool, complex allocation | Many simple accounts | Complex but explicit |

Architectural recommendation: evaluate Model C first—one permanent group master vault, pooled execution, and isolated tranche records. This is not a final selection. Whether isolation is ledger-only or uses sub-vaults requires economic and security modeling.

## Why tranches are mandatory

One investor may enter at different NAVs under different locks, fee rates, high-water marks, mandate versions and redemption dates. Each deposit therefore creates an immutable tranche identity. Fungible share transfers may be incompatible with tranche-specific obligations; the claim representation remains unresolved.

## Conceptual components

- **Master Vault:** asset custody, share/claim ledger and public group identity.
- **Tranche Registry:** immutable accepted terms and lifecycle per deposit.
- **Strategy Account:** venue collateral controlled only through the execution controller.
- **Execution Controller:** typed intent validation and risk gates.
- **Adapter Registry:** approved code hashes, venue scopes and caps.
- **Accounting/Oracle Module:** conservative NAV snapshots and staleness state.
- **Settlement Module:** fee crystallization, queues, reserves and redemption.
- **Guardian Module:** pause, disable and declared emergency transitions.
- **Governance:** version registration, timelocked upgrades and migrations.

## Vault lifecycle

| From → To | Actor | Preconditions | Event | Irreversible consequence / failure handling |
|---|---|---|---|---|
| DRAFT → REVIEW | proposer | complete version and disclosures | `VaultReviewRequested` | version frozen for review; defects return by creating a new draft |
| REVIEW → ACTIVE | governance | audits/approvals/caps valid | `VaultActivated` | address/version becomes eligible; failed checks leave REVIEW |
| ACTIVE → DEPOSIT_PAUSED | guardian/governance | pause reason | `DepositsPaused` | no new deposits; existing terms unchanged |
| DEPOSIT_PAUSED → ACTIVE | governance | reason remediated and delay met | `DepositsResumed` | prospective only |
| ACTIVE/DEPOSIT_PAUSED → TRADING_PAUSED | guardian/governance | risk trigger or maintenance | `TradingPaused` | exposure increase blocked; reduce-only policy applies |
| TRADING_PAUSED → ACTIVE | governance | health proof, delay and policy permit | `TradingResumed` | no retroactive action |
| ACTIVE/TRADING_PAUSED → SETTLEMENT | controller/governance | epoch close or wind-down trigger | `SettlementStarted` | new exposure/deposits blocked; deterministic snapshot begins |
| SETTLEMENT → REDEMPTION_WINDOW | settlement module | NAV/fees/liquidity finalized | `RedemptionWindowOpened` | crystallized epoch values become authoritative subject to dispute policy |
| REDEMPTION_WINDOW → ACTIVE | controller | redemptions processed and rollover conditions met | `EpochActivated` | non-consenting matured tranches cannot be rolled |
| any live state → EMERGENCY | guardian/governance/automatic invariant | declared trigger | `EmergencyDeclared` | new risk blocked; recovery path only; failure remains EMERGENCY |
| EMERGENCY → SETTLEMENT | governance | incident plan and reliable valuation | `EmergencySettlementStarted` | emergency claim basis selected and published |
| REVIEW/ACTIVE/paused/settlement → MIGRATING | governance | audited target, timelock, consent/exit rules | `MigrationOpened` | no forced mutation of old tranches |
| MIGRATING → CLOSED | governance | liabilities settled or preserved in claim contract | `VaultClosed` | terminal: no deposits/trading |
| REDEMPTION_WINDOW → CLOSED | governance | final wind-down, zero unresolved liabilities | `VaultClosed` | terminal |

Transitions not listed are illegal. `CLOSED` is terminal. An invalid or failed transition makes no partial state change and emits a failure reason through the transaction/reconciliation record.

## Deposit-tranche lifecycle

| From → To | Actor | Preconditions | Event | Consequence / failure |
|---|---|---|---|---|
| PENDING_APPROVAL → DEPOSITED | investor/vault | exact terms, allowance, asset and cap valid | `TrancheDeposited` | assets transferred and claim minted atomically; otherwise no tranche |
| DEPOSITED → LOCKED | vault | activation/lock rule reached | `TrancheLocked` | accepted maturity/terms immutable |
| LOCKED → ACTIVE | epoch controller | capital admitted to active epoch | `TrancheActivated` | participates at recorded entry NAV |
| ACTIVE/LOCKED → MATURED | clock/controller | maturity reached | `TrancheMatured` | redemption eligibility only, not instant liquidity |
| MATURED → REDEMPTION_REQUESTED | investor | valid request/window | `RedemptionRequested` | claim queued; cancellation policy must be disclosed |
| REDEMPTION_REQUESTED → SETTLING | settlement module | epoch close and valuation available | `TrancheSettlementStarted` | shares/claim locked against duplicate use |
| SETTLING → REDEEMABLE | settlement module | fees/liabilities and liquid assets finalized | `TrancheRedeemable` | payout fixed under rounding policy |
| REDEEMABLE → REDEEMED | investor/authorized recipient | valid claim, replay guard | `TrancheRedeemed` | terminal burn/payment; failed transfer preserves claim |
| any nonterminal funded state → EMERGENCY_CLAIM | emergency module | declared emergency and published claim rule | `EmergencyClaimCreated` | normal path suspended; never changes beneficiary |

`REDEEMED` is terminal. Rollover creates a new explicitly accepted tranche; it never changes the old maturity.

## Unresolved architecture decisions

Chain, venue, oracle design, claim token type/transferability, collateral custody across adapters, upgradeability, accounting frequency, privacy, liquidation ownership, insolvency waterfall and bridge prohibition/allowance remain open.
