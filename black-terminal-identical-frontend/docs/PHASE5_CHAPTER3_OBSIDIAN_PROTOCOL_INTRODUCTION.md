# Phase V Chapter III — Obsidian Protocol Introduction

Status: conceptual introduction only. No smart contract, application, database, execution, infrastructure, deployment, or production behavior is authorized or implemented by this document.

## Chapter Purpose

This chapter introduces Obsidian Protocol as the proposed trust and settlement layer beneath Black Terminal's investment-group system. It preserves the initial product thesis and establishes the questions that a later protocol constitution must answer before implementation begins.

The proposal is not simply to give each investment group a wallet. It is to allow an approved investment group to become a programmable on-chain financial entity with:

- a permanent and publicly verifiable vault identity;
- transparent assets, activity, performance, terms, and mandate history;
- investor economic ownership represented by shares and deposit-tranche records;
- narrowly restricted operator authority for approved strategy execution;
- contract-enforced custody, risk, fee, lock, and redemption rules;
- explicit separation between capital ownership, trading authority, emergency authority, and settlement authority.

Black Terminal would provide the operating experience, identity, analytics, execution controls, and visualization. Obsidian Protocol would enforce the financial relationship and settlement rules.

## Foundational Trust Principle

Investors must not be required to transfer unrestricted custody to an investment-group operator. Operators must not depend on investors voluntarily honoring an agreed fee after profitable execution. Neither side should be required to trust the Black Terminal interface as the final source of financial truth.

The intended separation is:

- the vault contract holds assets under predetermined rules;
- investors own the economic claims represented by shares and immutable deposit records;
- the investment group receives a restricted strategy mandate rather than withdrawal authority;
- guardians receive narrowly defined emergency powers;
- settlement modules calculate and process NAV, fees, maturity, and redemption under disclosed rules;
- the chain and audited protocol state provide the authoritative record.

No operator, administrator, session key, adapter, or user interface should possess a hidden general-purpose route to withdraw, transfer, seize, or arbitrarily call with investor capital.

## Proposed Primary Model

The recommended starting model is one permanent **Obsidian Master Vault per approved investment group**, combined with isolated accounting for every investor deposit tranche.

The master vault gives the group one durable public financial identity and permits shared strategy liquidity. The tranche model preserves the terms that existed when each allocation entered the vault.

A tranche must not be merged blindly with another deposit, even when both belong to the same investor. Each tranche may have a different:

- entry NAV and issued share quantity;
- deposit and maturity timestamp;
- lock duration and redemption state;
- performance-fee agreement and high-water mark;
- mandate and risk-policy version;
- allowed market or strategy scope;
- settlement status.

The pooled master-vault model is the initial architectural preference, not a final decision. A later design phase must compare it formally against per-investor vaults and hybrid sub-vault/account structures for isolation, capital efficiency, accounting complexity, gas cost, failure containment, and regulatory consequences.

## Conceptual System Components

The proposed system may ultimately contain the following independently constrained components:

### Obsidian Master Vault

Holds supported investor assets, issues ownership shares, records tranche obligations, and exposes the permanent public identity of the investment group.

### Obsidian Strategy Account

Interacts only with approved trading venues and adapters. It must not provide unrestricted asset transfer or arbitrary contract-call capability.

### Obsidian Execution Controller

Validates every operator-signed trade instruction against the vault, operator identity, nonce, deadline, approved venue, permitted market, action type, exposure, leverage, slippage, epoch state, and risk mandate before execution.

### Restricted Operator Session Key

Provides expiring, revocable, least-privilege authority limited to a specific vault, approved contracts and functions, markets, risk envelope, and time window. A smart-account model such as ERC-4337 may be evaluated, but no standard is selected by this introduction.

### Obsidian Guardian

Provides bounded emergency authority, such as pausing new exposure or reducing risk. Guardian powers must not become an alternative custody or seizure route.

### Obsidian Settlement Module

Defines authoritative NAV, share accounting, high-water marks, fee crystallization, maturity, redemption queues, settlement timing, and exceptional-state handling.

### Black Terminal

Presents vault identity, disclosures, contract review, approvals, deposits, portfolio state, operator controls, risk status, audit history, and redemption workflow. The interface visualizes and coordinates the protocol but cannot override it.

## Authority Boundaries

An investor is expected to be able to:

- approve and deposit only the selected amount of a supported asset;
- receive the corresponding economic ownership claim;
- inspect vault activity and applicable terms;
- request redemption according to the accepted tranche rules;
- withdraw settled assets when eligible.

An authorized investment-group operator may eventually be permitted to:

- open approved long or short positions;
- reduce and close permitted positions;
- cancel approved orders;
- manage permitted protective orders;
- act only within the current strategy and risk mandate.

The operator must never be permitted to:

- withdraw investor assets;
- transfer assets to an arbitrary wallet;
- seize or rewrite investor ownership;
- retroactively alter existing tranche terms;
- call arbitrary contracts;
- exceed contract-enforced market, exposure, leverage, or loss limits.

## Permanent Group Identity

An approved investment group could expose one permanent, recognizable vault address through Black Terminal. Its public profile could eventually include:

- verified vault address and chain;
- audited contract and adapter versions;
- assets under strategy and current NAV;
- share price and strategy capacity;
- active investor and tranche counts where privacy permits;
- fee structure, lock epochs, and redemption terms;
- allowed markets, venues, and maximum leverage;
- operator keys, session mandates, and guardian configuration;
- historical NAV, drawdown, executions, mandate changes, and redemptions;
- upgrade proposals, timelocks, and audit status.

This identity must communicate verifiable protocol state rather than unverified marketing claims.

## Deposit and Ownership Concept

ERC-4626 provides a relevant assets-for-shares vocabulary and should be evaluated as a foundation, not assumed to solve the complete design. The protocol must additionally account for derivatives exposure, asynchronous settlement, locks, multiple term versions, performance fees, high-water marks, redemptions, and potentially impaired or liquidated states.

When an investor deposits, the selected assets leave the investor's ordinary wallet and enter contract-controlled custody. The investor retains an economic claim through vault shares and the corresponding tranche record. Any interface must explain this distinction clearly before approval and signature.

## Restricted Futures Execution Concept

An operator would sign a bounded trade intent rather than obtain custody of the vault. The execution controller would verify the intent and route it only through an approved adapter.

An intent may identify the vault, market, direction, allocation, leverage, maximum slippage, expiry, and nonce. The final schema, signing standard, replay protection, position accounting, oracle assumptions, venue adapters, and failure semantics remain future constitutional and technical decisions.

The architecture must prohibit general withdrawal and arbitrary-call paths by construction, including through upgrades, adapters, delegate calls, compromised session keys, or emergency modules.

## Governance and Upgrade Principle

An upgradeable contract is not safe merely because its current implementation is constrained. Governance itself must be constrained and transparent.

A future constitution must evaluate requirements including:

- multisignature and role separation;
- public upgrade timelocks;
- published code and independent audit evidence;
- investor notification and review periods;
- exit rights where liquidity and protocol state permit;
- immutable preservation of existing tranche terms;
- emergency actions that are narrow, observable, reversible where possible, and unable to extract funds.

No administrator should be able to introduce withdrawal authority or retroactively weaken an accepted agreement through an opaque upgrade.

## The Protocol Constitution Comes First

Implementation must not begin from UI mockups or contract scaffolding alone. The next specification must define the protocol constitution, including:

1. ownership and authority for every component;
2. powers that can never exist;
3. supported assets, chains, venues, and trust assumptions;
4. deposit, share issuance, tranche, and rounding mathematics;
5. NAV sources, valuation timing, and oracle failure behavior;
6. locks, epochs, maturity, queues, and redemption settlement;
7. fee calculation, high-water marks, crystallization, and loss recovery;
8. operator authorization, session keys, adapters, and trade-intent validation;
9. leverage, exposure, drawdown, liquidation, and insolvency rules;
10. governance, upgrades, timelocks, guardians, and emergency response;
11. venue failure, bridge failure, depeg, chain halt, and protocol failure handling;
12. privacy, transparency, auditability, and data retention;
13. investor disclosures, jurisdictional constraints, and compliance responsibilities;
14. exit, wind-down, migration, and recovery procedures.

Only after these rules are mathematically specified, adversarially reviewed, legally assessed, and converted into testable invariants should contract and interface implementation be authorized.

## Safety, Legal, and Evidence Boundary

This concept involves pooled investor capital, derivatives, custody-like smart-contract behavior, performance fees, and investment-group operation. Its legal classification and obligations may vary by jurisdiction and cannot be resolved by software architecture alone. Specialist legal, regulatory, tax, economic, smart-contract security, and independent audit review are mandatory prerequisites to production use.

The claim that the complete system is unique or unprecedented is not established by this document. A formal competitive, standards, prior-art, and patent landscape review is required before making such a claim.

No production readiness, contract safety, economic soundness, regulatory approval, audit status, or investor protection claim is made here.

## Chapter Outcome

Obsidian Protocol is introduced as the proposed programmable trust and settlement layer for Black Terminal investment relationships. Its defining idea is the separation of:

- investor economic ownership;
- investment-group strategy authority;
- protocol custody and enforcement;
- guardian emergency authority;
- settlement and accounting;
- Black Terminal's operating interface.

This chapter records the vision without selecting an implementation. Further work must wait for explicit instructions and begin with the protocol constitution.
