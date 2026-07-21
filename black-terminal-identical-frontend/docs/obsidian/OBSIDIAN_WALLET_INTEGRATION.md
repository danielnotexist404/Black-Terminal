# Obsidian Wallet Integration

Status: integration architecture; no wallet integration is implemented by Project Obsidian.

## First release

Use existing wallets through Obsidian Connect: MetaMask, Rabby, Coinbase Wallet and WalletConnect-compatible clients, subject to compatibility testing. The wallet signs network selection, exact token approval or permit where safe, term acceptance and deposit. The vault—not the wallet—enforces the lock.

Only the approved allocation leaves the investor wallet. All remaining wallet assets stay under the investor's control. Once deposited, the allocated assets are contract-controlled; the investor holds an economic claim and cannot truthfully be told the funds remain in the ordinary wallet.

## Required signing experience

Before signature, show verified chain, vault address, contract/term version, asset, exact amount/cap, lock start rule, maturity, loss risk, fee/HWM rule, venue/market/leverage scope, redemption constraints and upgrade/emergency policy. Detect chain/address mismatch and link to independent block-explorer verification.

Approvals should be exact or bounded by explicit user choice. Unlimited approvals must not be the default. Revoking a token allowance after a completed deposit does not withdraw vault assets and must be explained.

## Future Obsidian Account

Non-binding research may evaluate smart accounts, scoped session keys, guardians, delayed recovery, gas sponsorship and batched transactions. ERC-4337 is one research input, not a commitment. Smart-account policy cannot weaken vault invariants or give Black Cloud custody.

## Future Obsidian Wallet

A future desktop/iOS/Android client may add hardware-backed key storage, biometric local unlock, transaction simulation, recovery and native Black Terminal UX. It remains an interface over the same wallet-independent protocol.

Strict boundary: Obsidian Wallet owns user signing authority. Black Cloud operates authorized off-chain execution. Obsidian Protocol enforces on-chain capital rules. Seed phrases and raw private keys must never enter Black Cloud, Supabase, frontend persistence, analytics, logs or support systems.

## Recovery and phishing

Recovery cannot reset vault ownership without a pre-authorized, delayed and observable mechanism. Interfaces must defend against fake vault addresses, malicious WalletConnect proposals, blind signatures, DNS compromise and injected frontends. Canonical addresses, code hashes and term hashes require independent verification paths.

## Reference inputs

- ERC-4337: https://eips.ethereum.org/EIPS/eip-4337
- WalletConnect documentation: https://docs.walletconnect.network/

These references do not certify compatibility or security.
