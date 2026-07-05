# Phase III Connectivity Investigation

## Root cause: MetaMask futures

MetaMask connects correctly, but it is a wallet signer, not an executable perpetual venue. The MetaMask adapter reports wallet-only capabilities:

- `wallet-connect`
- `transaction-signing`
- `token-transfers`
- `network-switching`

It does not report `perpetual-orders`, `leverage`, `swap`, or `spot-orders`. Futures therefore require a protocol or venue adapter, such as Hyperliquid, GMX, dYdX, or another perpetual DEX router, layered behind the connected wallet.

The previous UI disabled futures for every DEX-style connection without explaining why. The ticket now reads capabilities from the connection record and shows the unsupported reason from the adapter metadata instead of looking broken.

## Root cause: execution ticket synchronization

The Positions panel and Unified Execution Ticket were using separate account sources. Positions managed broker and wallet links locally, while the execution ticket read a stale broker-only localStorage snapshot. Wallet connections could appear in Positions while the ticket still displayed a placeholder.

The execution ticket now subscribes directly to the Black Core Connection Manager. Positions also connects, disconnects, counts, and renders active accounts through the same manager. The account dropdown is populated from active connection diagnostics, including centralized exchanges and wallet connections.

## Corrected architecture

Black Core Connection Manager is now the runtime source of truth for connected accounts. It owns:

- adapter registration
- connect and disconnect lifecycle
- heartbeat and reconnect state
- capability detection
- diagnostics
- permission warnings
- connectivity event publishing
- in-memory audit buffering

The Unified Execution Ticket keeps only a selected connection id as local UI state. It does not maintain account records independently.

OMS and EMS continue to receive execution requests by account id, and the Broker Router resolves that account through the Connection Manager before routing execution.

## MetaMask futures decision

MetaMask futures are intentionally unsupported until a perpetual DEX execution adapter is connected. This is not a regional restriction and not a MetaMask provider failure. It is a missing protocol execution layer: MetaMask can sign transactions, but Black Terminal still needs an adapter that knows how to create and manage perpetual orders on the target venue.
