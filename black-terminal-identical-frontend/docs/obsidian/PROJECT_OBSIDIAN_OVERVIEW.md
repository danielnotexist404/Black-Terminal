# Project Obsidian Overview

Status: architecture specification; not implemented or approved for capital.

## Product hierarchy

| Layer | Responsibility | Explicit boundary |
|---|---|---|
| Black Terminal | Professional trading and investment operating system | User experience, disclosure and coordination; not the custody authority |
| Black Core | Rendering, market intelligence, events and local application engine | No investor keys or protocol custody |
| Black Cloud | Persistent broker connectivity, execution and reconciliation | Off-chain authorized execution only; never seed phrases or raw user keys |
| Project Obsidian | Complete on-chain capital-management initiative | Umbrella program, not a contract or wallet |
| Obsidian Protocol | Wallet-independent contracts and strategy-vault infrastructure | Capital rules, claims, mandates and settlement |
| Obsidian Connect | Existing-wallet integration | MetaMask, Rabby, Coinbase Wallet and WalletConnect-compatible clients |
| Obsidian Account | Optional future programmable smart-account layer | Session policy and account abstraction; non-binding concept |
| Obsidian Wallet | Future Black Terminal desktop/mobile wallet | Owns user signing authority; not required for Protocol launch or validation |

Obsidian Protocol must be developed and validated independently of Obsidian Wallet. External wallets are the preferred first integration.

## Core concept

Each approved investment group may operate a permanent, publicly verifiable Obsidian Master Vault. Investors allocate an approved asset under an immutable term version and retain economic ownership through shares plus an isolated deposit-tranche claim. A strategy operator receives a narrow, expiring mandate to perform enumerated trading actions. The operator never receives withdrawal, transfer, custody, upgrade or arbitrary-call authority.

## What it is not

| Model | Difference from Obsidian |
|---|---|
| Copy trading | Obsidian pools or accounts for contract-controlled capital; it does not merely mirror orders in unrelated accounts |
| Centralized managed account | Rules and claims are contract-enforced rather than solely controlled by a manager or custodian |
| Transfer to a manager | Capital cannot be freely redirected by the operator |
| Conventional self-custody wallet | A wallet signs entry; the vault then holds only the allocated amount under accepted rules |
| Generic yield vault | Derivatives, tranches, mandates, locks, HWM fees and asynchronous settlement require additional machinery |
| Exchange subaccount | The identity and investor claim layer is protocol-level and venue-independent, subject to adapter risk |

## Initial architectural hypothesis

The preferred—but not final—model is one permanent master vault per approved group, pooled strategy execution, and isolated accounting for every deposit tranche. The safer initial derivatives release is epoch-based, invitation-only and capped: one chain, one settlement asset (candidate: USDC), one researched and approved on-chain venue, BTC/ETH only, low leverage and one strategy.

No venue is selected or represented as supported by these documents.

## Required proof before implementation

- constitutional agreement on authority and forbidden powers;
- complete accounting and transition specifications;
- independent economic, legal and security review;
- verified venue and oracle research;
- executable invariants and reference-model tests;
- two independent audits before public capital;
- public testnet and restricted capped pilot evidence.

See `OPEN_QUESTIONS_AND_DECISIONS.md` for the decision register.

## Primary references

- ERC-4626 tokenized-vault interface: https://eips.ethereum.org/EIPS/eip-4626
- ERC-4337 account abstraction: https://eips.ethereum.org/EIPS/eip-4337

These standards are research inputs, not selected implementation commitments.
