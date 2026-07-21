# Obsidian Adapter Standard

Status: conceptual safety standard; no venue or adapter is approved.

## Purpose

An adapter translates typed protocol actions into one specific researched venue interface without creating a general asset-extraction path. The preferred first experiment uses an existing on-chain venue, not a proprietary DEX.

## Registry record

Each approved adapter record binds chain, code address/hash, implementation/version, venue, supported assets/markets/actions, token spenders, maximum allowance, per-vault/per-market capital caps, oracle dependencies, emergency behavior, audit artifacts and activation/deactivation times.

## Mandatory interface properties

- only the execution controller can invoke trading entry points;
- action-specific typed parameters, no arbitrary target/calldata;
- exact allowlists for tokens, spenders, venues and function selectors;
- bounded approvals, preferably exact-use or promptly revoked;
- returned assets go only to the vault/strategy account;
- venue position/order identifiers are recorded for reconciliation;
- view functions expose positions, orders, balances and health;
- disabled adapters reject new capital and exposure;
- reduce/close behavior is separately bounded and tested;
- callbacks cannot reenter accounting or expand authority.

## Approval process

Research venue contracts and governance → model custody/oracle/liquidation risk → implement reference adapter → unit/invariant/fuzz tests → independent audits → public testnet → cap-limited registry proposal → timelock → activation. “Compatible” is not “approved.”

## Failures

Unknown return data, stale oracle, unexpected token movement, allowance drift, balance mismatch, venue pause, code change or reconciliation divergence pauses new exposure. The adapter must never compensate by routing assets elsewhere. Emergency recovery paths must be venue-specific, pre-disclosed and unable to select an arbitrary beneficiary.

## First controlled research profile

One chain; one native settlement asset candidate; one on-chain perpetual venue selected only after research; BTC and ETH; low leverage; one strategy; invitation-only users; hard vault, adapter and market caps. Bridges are excluded from the initial hypothesis unless separately justified and audited.

## Unresolved

Venue, chain, oracle, upgradability detection, allowance pattern, margin-account custody, liquidation keeper, callback model and settlement withdrawal mechanics are open decisions.
