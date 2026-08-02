# Security Fortress Connectivity Regression Audit

Audit date: 2026-08-02
Scope: Black Terminal browser, consolidated API control plane, Supabase policies, Black Cloud worker, OMS/EMS, connection cockpit, and every provider advertised by the venue registry.

## Certification boundary

This is a source and configuration audit. It is not proof that an always-on worker is deployed, that a real broker account passed testnet, or that mainnet execution is certified. Those states require recorded external evidence. The Security Fortress controls remain mandatory: authenticated control routes, strict schemas, tenant RLS, server-only credentials, withdrawal prohibition, restricted CORS/CSP, and a provider endpoint allowlist.

## Request trace and root causes

| Symptom | Failing stage | Exact source | Security control | Cause | Secure correction | Regression test |
|---|---|---|---|---|---|---|
| Cloud activation reports disabled | Control-plane rollout gate | `server/routes/cloud-execution/connection.js`, `handler` | Explicit production feature gate | `CLOUD_EXECUTION_CONTROL_PLANE_ENABLED` defaults closed | Keep fail-closed behavior; document and validate the worker before enabling | Control route must return a typed disabled state when the flag is absent |
| Saved CEX appears connected without persistent execution | Browser connection projection | `src/connectivity/connectionManager.ts`, `connect`; `src/connectivity/adapters/centralizedExchangeAdapter.ts` | Browser must not own execution authority | Local connection health is independent of broker credential, worker, synchronization, and mandate state | Render separate UI, broker, worker, sync, mandate, and execution states from the authenticated status API | Local adapter connection must never imply `EXECUTION_READY` |
| Connection ends when browser closes | Browser adapter lifecycle | `src/connectivity/connectionManager.ts`; wallet adapters | Secrets and persistent sockets cannot live in React | Heartbeats and injected-wallet sessions are page-owned by design | Use Black Cloud for API/agent credentials; label injected wallets interactive-only | Capability contract distinguishes interactive from persistent |
| Black Cloud ignores non-Bybit cloud records | Worker adapter registration | `server/cloud-execution/adapters/registry.js`, `factories`; `connection-supervisor.js`, `startConnection` | Provider allowlist | Only Bybit has a registered persistent adapter; supervisor silently returned for others | Return explicit unsupported/disabled states; register only complete adapters | Registry and lifecycle tests assert truthful unsupported states |
| Hyperliquid relay cannot survive browser workflow as a supervised session | Separate request relay | `server/protocols/hyperliquid.js`; `server/protocols/hyperliquid-routes/*` | Delegated key only; primary wallet keys forbidden | Agent credential and request endpoints exist, but no Black Cloud adapter/private-stream supervisor owns them | Move authorized agent material into the common vault/mandate/worker lifecycle before claiming persistence | Delegation/master-address, nonce, reconnect, and revocation tests |
| Worker readiness may be green while dependencies are unavailable | Health process | `scripts/black-cloud-execution-worker.js`; `server/cloud-execution/worker.js`, `diagnostics` | Service identity and dependency health | Readiness checks process/tick state but not database, vault, lease RPC, or queue availability | Add dependency probes and fail readiness closed | Readiness tests cover database/vault/lease/queue failures |
| Credential envelope cannot be independently rotated | Vault implementation | `server/cloud-execution/secret-vault.js`, `storeBrokerCredential` | Server-only authenticated encryption | v1 encrypts each secret directly with one master key and does not bind user/connection/provider as AAD | Use a random per-record DEK, wrap it with a versioned master key, and bind canonical AAD | Wrong-user, wrong-connection, AAD, rotation, and redaction tests |
| Duplicate private events may return after worker restart | Private event supervisor | `server/cloud-execution/connection-supervisor.js`, `seenEvents` | Idempotent OMS ingestion | Dedupe state exists only in memory | Insert a durable inbox identity before applying the event | Restart/duplicate/out-of-order event tests |
| Lease is checked when work begins but not immediately before every broker mutation | Worker execution | `server/cloud-execution/worker.js`, `processCommand` and `placeFollowerOrder` | Distributed fencing | Token is checked when completing the database command, after the external side effect | Assert current lease generation immediately before place/modify/cancel/cancel-all | Stale worker cannot call adapter mutation |
| Logout behavior is not explicit to the operator | Auth/UI boundary | `src/lib/supabase.ts`, `clearSupabaseAuthSession`; app sign-out action | UI session and automation mandate must be separate | Standard logout correctly affects Auth only, but no warning or stop-and-logout workflow is exposed | Add explicit warning and a separate audited stop workflow; preserve protection by default | Logout contract verifies mandates remain active unless explicitly revoked |
| Existing documentation overstates deployment | Documentation | `docs/PHASE5_CHAPTER2_BLACK_CLOUD_CONNECTIVITY.md` | Truthful operational state | A historical deployment ID is not evidence of a currently running persistent host or offline certification | Replace deployment claims with evidence-linked state and an operator checklist | Documentation/certification matrix must distinguish code-complete from externally certified |

Authentication headers are present in `src/portfolio/portfolioApiClient.ts`; consolidated APIs call `requireUser`; the Security Fortress CORS and schema middleware are not the primary break. They must not be bypassed.

## Provider inventory

| Provider | Frontend entry | Backend/private route | Persistent adapter | Credential/authority | Worker owner | Audited state | Persistent-capable now | Production-capable now | Required repair or truthful limit |
|---|---|---|---|---|---|---|---|---|---|
| Bybit | Positions CEX connection | exchange account routes; cloud connection/status/control; execution routes | `BybitCloudAdapter` | Trade-only API key/secret | Black Cloud (when deployed/enabled) | `PERSISTENT_CAPABLE`, not certified | Yes in code | No external proof | Complete v2 vault, durable inbox, pre-side-effect fencing, readiness, and testnet offline evidence |
| Hyperliquid | Protocol/MetaMask flow | `/api/protocols/hyperliquid/*` | No common persistent adapter | Delegated agent/API wallet | Request relay only | `PARTIALLY_IMPLEMENTED` | No | No | Integrate agent delegation, private subscriptions, reconciliation, mandates, and revocation with Black Cloud |
| MetaMask | Positions wallet flow | None for wallet session | None | Injected wallet signer | Browser | `INTERACTIVE_ONLY` | No | Interactive only | Never claim persistence from extension state; use a protocol-supported delegated agent |
| Phantom | Positions wallet flow | None for wallet session | None | Injected Solana signer | Browser | `INTERACTIVE_ONLY` | No | Interactive only | No safe general delegated execution architecture is implemented |
| Binance | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| OKX | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Bitget | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Coinbase Advanced | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Kraken | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Bitfinex | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Bitstamp | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Deribit | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| KuCoin | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Gate.io | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| MEXC | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| BitMEX | Positions CEX list | Public market-data path only | None | None | None | `READ_ONLY` market data | No | No | Private account/execution adapter not implemented |
| Uniswap | Positions protocol list | None | None | MetaMask signer | Browser | `PLACEHOLDER` / signer-only | No | No | Quote, allowance, signing, broadcast, and reconciliation absent |
| Jupiter | Positions protocol list | None | None | Phantom signer | Browser | `PLACEHOLDER` / signer-only | No | No | Quote, signing, broadcast, and reconciliation absent |
| Raydium | Positions protocol list | None | None | Phantom signer | Browser | `PLACEHOLDER` / signer-only | No | No | Swap execution absent |
| PancakeSwap | Positions protocol list | None | None | MetaMask signer | Browser | `PLACEHOLDER` / signer-only | No | No | Swap execution absent |
| GMX, dYdX, Vertex, Drift | Hidden/deferred registry entries | None | None | None | None | `NOT_IMPLEMENTED` | No | No | Keep hidden/unsupported |
| WalletConnect | Hidden/deferred registry entry | None | None | None | None | `NOT_IMPLEMENTED` | No | No | Keep hidden/unsupported |
| FIX, Interactive Brokers, Tradovate, Rithmic, CQG, Prime Broker | Hidden institutional entries | None | None | None | None | `SCAFFOLDED` | No | No | Contracts and certification do not exist |

## Architectural decision

The browser is only the authenticated cockpit. A browser session may create or revoke a signed automation mandate. An active mandate permits a leased Black Cloud execution session. Only the worker decrypts credentials, owns private sockets, reconciles broker state, and consumes durable OMS/EMS commands. Ordinary logout does not mutate the mandate. Explicit pause, revoke, disconnect, and emergency actions do.

No unsupported provider will be made green merely by adding a card or saving credentials.
