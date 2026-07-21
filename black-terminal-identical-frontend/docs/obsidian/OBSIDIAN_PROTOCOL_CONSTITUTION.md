# Obsidian Protocol Constitution

Status: normative architectural constitution; implementation remains prohibited pending review.

## Constitutional hierarchy

1. Investor claims and accepted tranche terms.
2. Protocol safety invariants.
3. Vault state and risk policy.
4. Governance actions after timelock.
5. Strategy mandate.
6. Operator trade intent.
7. Interface or off-chain instruction.

A lower item can never override a higher item.

## Powers that must exist

### Investor

- inspect immutable terms and verified contract addresses before signing;
- deposit approved assets and receive shares plus a tranche claim;
- inspect authoritative vault activity and accounting;
- request redemption when eligible and redeem after settlement;
- refuse future term versions or rollover;
- revoke optional off-chain permissions;
- receive emergency and governance notifications.

### Strategy operator

Only while a mandate is active, the vault permits enumerated operations: open approved spot/perpetual positions, reduce or close positions, place/cancel approved limit orders, and update permitted protection. Every action remains bounded by vault, venue, adapter, asset, market, leverage, exposure, loss, drawdown and time policy.

### Guardian

- pause new exposure;
- disable a compromised adapter;
- invoke explicitly defined reduce-only or close-only procedures;
- initiate an emergency settlement state.

Guardian actions must be logged, bounded, and unable to change beneficiaries or redirect assets.

### Governance

- approve audited versions through multisignature and public timelock;
- manage registries and caps prospectively;
- notify affected investors;
- offer an explicit migration or exit procedure;
- separate protocol governance identities from strategy operators.

## Powers that must never exist

No operator, guardian, governance shortcut, adapter, frontend or off-chain service may:

- withdraw or transfer investor assets to an arbitrary recipient;
- execute arbitrary targets or calldata;
- seize, redirect or rewrite investor ownership;
- extend an active lock or change its fees retroactively;
- add unauthorized assets, venues, spenders or markets;
- bypass leverage, exposure, loss, drawdown or pause controls;
- grant itself upgrade authority or broaden its own mandate;
- make an emergency action payable to a non-investor beneficiary.

Governance must never activate an upgrade before its configured timelock or mutate accepted tranche terms. A new implementation may govern new tranches; old claims remain under their accepted version unless the investor explicitly chooses a defined migration.

## Consent rules

Consent must bind chain, verifying contract, vault, term version, asset, amount/cap, maturity rule, fee rule, mandate/risk version and nonce. Silence, UI use or acceptance of a later term version is not consent to modify an existing tranche.

## Emergency doctrine

Emergency authority is for loss containment, not normal operation. `EMERGENCY` blocks exposure-increasing actions. Recovery priority is: preserve evidence, stop new risk, cancel eligible orders, reduce/close only if pre-authorized, value liabilities conservatively, open claims or settlement, and publish an incident record.

If a safe automated action is ambiguous, fail closed and escalate through the disclosed governance process. Emergency maturity may enable a claim path but cannot manufacture liquidity or promise immediate transfer.

## Separation of duties

At minimum, protocol governance, strategy operation, guardian action, oracle administration, adapter approval, fee receipt and deployment should not resolve to one unilateral key. Exact signer thresholds remain unresolved.

## Constitutional amendment

This constitution may be refined during specification review. After any capital-bearing deployment, a constitutional change applies only prospectively through audited code, multisignature approval, timelock, public notice, and a defined exit/migration path. No amendment can legitimize the forbidden powers above for existing claims.
