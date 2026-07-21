# Obsidian Governance and Upgrades

Status: governance requirements; signer topology and durations unresolved.

## Role separation

Protocol governance, vault strategy operator, guardian, adapter reviewer, oracle administrator, deployer and fee recipient are distinct roles. Production must use threshold multisignatures with hardware-backed operational practices; no production authority rests on one ordinary key.

## Upgrade lifecycle

Proposal → published source/diff/build artifacts → reproducible bytecode and storage analysis → independent review/audit as risk requires → multisig approval → public timelock → monitoring/notification → activation → post-activation invariant verification.

No unaudited bypass, hidden proxy admin, emergency instant upgrade or retroactive tranche mutation is allowed. Emergency response should pause behavior, not silently install unreviewed code.

## Existing tranches

Accepted term and claim semantics remain bound to their version. A new contract/version applies prospectively. Migration requires a published mapping, claim-preservation proof, investor notification, defined consent/exit process, timelock and reconciliation before/after movement. Investors who do not migrate retain an operable settlement/claim route under the disclosed wind-down policy.

## Registry governance

Adapter, venue, asset, oracle and cap changes are versioned, timelocked and prospective. Disabling new exposure may be immediate under guardian authority; re-enabling or raising caps requires normal governance delay.

## Incident governance

The incident plan identifies detection, severity declaration, pause authority, evidence preservation, public communication, reconciliation, valuation, recovery choices, claim handling, postmortem and safe resumption. Strategy operators cannot adjudicate their own misconduct or unilaterally choose claimant outcomes.

## Open parameters

Multisig threshold/composition, timelock duration by action, veto/cancel mechanism, guardian quorum, immutable versus upgradeable deployment, migration consent threshold, communication channels and dispute process require formal selection.
