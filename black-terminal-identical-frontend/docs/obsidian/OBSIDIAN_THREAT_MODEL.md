# Obsidian Threat Model

Status: pre-implementation threat register. Severity is provisional: Critical, High, Medium.

Assets include investor principal/claims, vault/venue collateral, protocol authority, accounting/NAV, availability, privacy and reputation. Controls are requirements, not implemented facts.

| Threat and attack scenario | Assets / severity | Preventive controls | Detection | Recovery / residual risk |
|---|---|---|---|---|
| Malicious operator intentionally takes prohibited or reckless exposure | capital, claims / Critical | typed actions, mandate and caps, no withdrawals | exposure/risk events, independent monitor | suspend, close-only, settle; permitted trading can still lose |
| Compromised operator key signs valid-looking harmful trades | capital / Critical | scoped expiring key, low caps, nonce/deadline | behavioral/risk alerts | revoke, pause, reconcile; loss before detection remains |
| Compromised guardian freezes service or abuses close authority | availability/capital / High | bounded pause/reduce-only, multisig where appropriate | every guardian action public | replace guardian via timelock, settle; forced close can realize loss |
| Malicious governance signer proposes extraction upgrade | all / Critical | threshold multisig, separation, timelock, immutable old terms | public proposal/code-hash monitor | cancel/exit/migrate; signer collusion remains |
| Upgrade bypass or storage-layout error changes rights | all / Critical | minimal/tightly governed upgrades, layout proofs, audits | code/version and invariant monitor | pause and audited migration; irreversible corruption possible |
| Arbitrary-call/delegatecall path extracts assets | capital / Critical | no generic execution, selector/target/spender allowlists | token-flow invariant | pause adapter, incident claim; extraction may be unrecoverable |
| Reentrancy corrupts shares, claims or settlement | capital/accounting / Critical | checks-effects-interactions, guards, pull claims | invariant and trace monitoring | pause, snapshot, repair/migrate if possible |
| Share inflation/donation manipulates first or later deposits | claims / Critical | virtual offset/minimum seed/asynchronous finalized NAV design | conversion deviation alarms | pause deposits, reject epoch; chosen defense needs proof |
| Oracle manipulation inflates NAV or bypasses leverage | capital/accounting / Critical | independent sources, TWAP/median, bounds and delays | source divergence/confidence alerts | NAV_STALE, halt mint/fee/redeem; correlated oracle failure remains |
| Stale NAV prices deposits/redemptions incorrectly | claims / High | freshness threshold and atomic snapshot | staleness state | pause settlement, recompute; opportunity cost remains |
| Fee gaming via deposits, withdrawals or price timing | claims / High | per-tranche HWM, epoch pricing, anti-dilution | attribution simulation/reconciliation | reverse unfinalized epoch; finalized leakage may remain |
| Front-running a deposit/redemption/intent changes outcome | capital/claims / High | batch epochs, deadlines, slippage, commit/reveal research | MEV/outcome telemetry | cancel/settle under bounds; public-chain MEV remains |
| Sandwiching venue trades worsens execution | capital / High | slippage/price impact limits, private routing research | benchmark execution quality | stop adapter; unavoidable market impact remains |
| Related-party/self-dealing trades transfer value | capital / Critical | venue/instrument limits, conflicts policy, surveillance | counterparty/price-quality analysis | revoke operator, legal/settlement response; pseudonymity limits detection |
| Liquidation from adverse move or operational delay | capital / Critical | low leverage, buffers, caps, independent keeper/monitor | margin and liquidation-distance alerts | reduce-only/emergency settle; gap losses remain |
| Extreme leverage through composition or stale exposure | capital / Critical | aggregate gross/net exposure invariant across adapters | independent position reconciliation | pause/close; venue latency remains |
| Adapter compromise or malicious upgrade | capital / Critical | immutable audited adapter, code-hash registry and caps | code/allowance/balance monitor | disable, revoke allowance, venue recovery; exposed collateral remains |
| Bridge compromise mints/unlocks false assets | capital / Critical | exclude bridges initially; dedicated caps if ever approved | supply/bridge health monitor | pause asset/adapter; bridge insolvency may be unrecoverable |
| Chain halt/reorg delays settlement or reverses state | availability/claims / High | finality policy, no instant guarantees | chain/finality monitor | remain paused, resume after finality; extended halt remains |
| Stablecoin depeg/freeze impairs NAV or transfer | capital / Critical | asset policy, issuer/freeze disclosure, caps | price/freeze/liquidity alerts | pause, approved conversion/claims; issuer action may be irreversible |
| Venue insolvency or withdrawal halt traps collateral | capital / Critical | due diligence, caps, on-chain proof where available | venue withdrawal/solvency monitor | cease exposure, claim process; recovery uncertain |
| Denial of service blocks deposits, risk action or redemption | availability/capital / High | permissionless critical paths, redundant keepers/RPCs | liveness SLOs | alternate callers/RPCs, emergency mode; chain congestion remains |
| Rounding extraction repeats dust-favorable operations | claims / High | fixed rounding rules, minimums, dust caps | cumulative rounding ledger | pause vector, allocate dust by policy |
| Replayed intent executes twice | capital / Critical | domain separation, unique nonce/client ID, atomic consumption | duplicate ID/reconciliation alarm | pause and reduce unintended exposure; fill loss remains |
| Ambiguous response causes duplicate retry | capital / Critical | reconciliation before retry, deterministic IDs | submitted-vs-chain mismatch | resolve authoritative state; never blind retry |
| Settlement mismatch omits position, fee or liability | claims / Critical | independent full-state reconciliation and balanced ledger | invariant failure | block crystallization/redemption, recompute |
| Premature redemption drains collateral | capital/claims / Critical | tranche state gate, maturity and settled-liquidity proof | claim-state invariant | reject/ pause; confirmed overpayment may be irreversible |
| Incorrect lock timestamp changes eligibility | claims / High | exact timestamp semantics and immutable record | boundary/property tests, state monitor | honor safer disclosed interpretation or claim process |
| Investor/operator key loss prevents action | access/availability / High | optional delayed recovery and role redundancy | inactivity/recovery events | pre-authorized recovery; social recovery introduces collusion risk |
| Phishing obtains approvals or signatures | investor assets/claims / Critical | human-readable typed data, exact approvals, address verification | wallet simulation/user alerts | revoke unused approvals, incident support; signed transfers may be final |
| Malicious frontend substitutes vault/terms | investor assets / Critical | independently verifiable addresses/hashes, signed releases | integrity/DNS monitors | stop frontend, warn/revoke; completed deposit may be unrecoverable |
| DNS compromise redirects users | investor assets / Critical | DNS security, multiple verification channels, CSP/release signing | certificate/DNS/address monitors | disable domain, out-of-band warning |
| Fake vault address impersonates group | investor assets / Critical | on-chain registry and verified profile/explorer links | registry mismatch and reports | warnings/takedown; external scam recovery uncertain |
| Hidden admin power bypasses public mandate | all / Critical | source/bytecode verification, role enumeration, no unaudited proxy | continuous privilege/code-hash monitor | never activate; if discovered live, emergency exit |

## Review rule

Every design change updates this register with owner, test mapping and residual-risk acceptance. Critical residual risk requires explicit governance, auditor and legal/economic review; documentation alone cannot accept it for investors.
