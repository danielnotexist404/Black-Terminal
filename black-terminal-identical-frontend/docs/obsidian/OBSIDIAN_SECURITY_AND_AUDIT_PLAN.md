# Obsidian Security and Audit Plan

Status: mandatory staged assurance plan; no stage has begun.

## Release gates

1. **Specification review:** authority, states, equations, failure behavior, legal facts and invariants receive multidisciplinary sign-off.
2. **Reference implementation:** minimal non-production model with traceable requirement IDs; no public capital.
3. **Unit testing:** every operation, boundary, permission, rounding direction and transition.
4. **Invariant testing:** all constitutional/accounting properties under arbitrary valid sequences.
5. **Fuzzing:** malformed signatures, timing, decimals, reentrancy, callbacks, state sequences and adapter responses.
6. **Static analysis:** contract, dependency, privilege, storage and unsafe-call review with findings resolved or accepted explicitly.
7. **Symbolic execution/formal work:** custody, authority, replay, supply/claim, fee/principal and pause properties.
8. **Economic simulation:** deposits across gains/losses, bank-run/queue conditions, oracle shocks, depeg, liquidation, fee gaming and related-party behavior.
9. **Independent audit 1:** full protocol and threat-model review by a qualified firm.
10. **Independent audit 2:** independent review emphasizing economic/accounting, adapters, governance and remediation verification.
11. **Public testnet:** verified contracts, observable test scenarios, no valuable assets and published limitations.
12. **Restricted pilot:** invitation-only, allowlisted/capped participants and capital, preferably non-public/no-value until legal clearance.
13. **Bug bounty:** scoped contracts, severity taxonomy, response SLA and sufficient rewards before public expansion.
14. **Capital caps:** immutable/timelocked per-vault, per-asset, per-market and per-adapter ceilings.
15. **Gradual expansion:** only after measured evidence, incident readiness and fresh review for each added chain/venue/asset.

Skipping a stage requires documented reasoning and cannot bypass either independent audit before public capital.

## Deployment requirements

- immutable or tightly governed minimal first deployment;
- threshold multisig with documented signer independence and hardware controls;
- public timelock for risk-increasing/governance actions;
- guardian emergency pause that cannot redirect funds;
- verified source, reproducible build, deployed bytecode/code hash and role inventory;
- no unaudited upgrade path;
- published audits, findings, fixes, residual risks and version mapping;
- live invariant, oracle, balance, allowance, exposure and state monitoring;
- rehearsed incident response, communication and claim procedure.

## Audit artifacts

Constitution/version, architecture/data-flow/funds-flow diagrams, complete code and dependencies, compiler/build lock, role matrix, transition model, equations, oracle/venue assumptions, threat model, invariant-to-test matrix, fuzz corpus, simulations, static/symbolic reports, audit reports, remediation commits, deployment manifest and monitoring runbook.

## Stop conditions

Unresolved critical finding; unprovable critical invariant; unexplained accounting difference; stale/unreliable valuation; hidden privilege; unaudited code change; legal blocker; venue/adapter uncertainty; unavailable incident owner; or capital cap bypass blocks progression.
