# Wallet Persistence Limitations

## MetaMask

The current MetaMask adapter requests accounts and observes account/network changes in the browser.
It is `FULLY FUNCTIONAL — INTERACTIVE ONLY`. A remembered wallet session is not server authority to
sign unattended transactions. Black Terminal never requests or stores a recovery phrase or primary
wallet private key. Persistent protocol execution requires a protocol-supported delegation or a
separate agent/smart-account policy, followed by adapter and certification work.

Reference: https://docs.metamask.io/metamask-connect/evm/guides/manage-user-accounts/

## Phantom

The current Phantom adapter connects the injected Solana provider and receives the public key. It is
`FULLY FUNCTIONAL — INTERACTIVE ONLY`. Eager reconnection for a trusted origin still depends on the
wallet/browser and does not make Black Cloud an authorized signer. Black Terminal does not store a
Phantom seed phrase, extension secret, or primary private key.

Phantom Connect now documents embedded/KMS-backed and server/agent surfaces, but Black Terminal has
not integrated or certified those authorization models. Jupiter, Raydium, and Drift therefore remain
interactive signer placeholders or unsupported for unattended execution.

References:

- https://docs.phantom.com/solana/establishing-a-connection
- https://docs.phantom.com/phantom-connect
- https://docs.phantom.com/wallet-sdks-overview

## UI rule

Wallet identity, delegated authority, Black Cloud connectivity, and execution readiness must be
shown as separate states. A green wallet dot may never imply browser-independent automation.
