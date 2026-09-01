# Black Terminal Standalone

Black Terminal Standalone turns a Windows, Linux, or macOS workstation into the local application, strategy host, execution queue, broker signer, data store, and P2P peer while the Black Terminal process is running. It does not require an open browser or a Black Cloud/VPS session. Closing the main window hides it to the system tray when background execution is enabled; choosing **Quit Black Terminal** stops local automation and networking.

This document describes the implemented boundary. It is not a real-funds certification claim.

## Supported release targets

| Platform | Package | Background behavior | Current boundary |
|---|---|---|---|
| Windows 10/11 x64 | NSIS `.exe`, WiX `.msi` | Tray process | Native CI build and signed-release validation remain required |
| Ubuntu-compatible Linux x64 | `.deb`, `.rpm`, AppImage | Tray process | Secret Service/keyring and WebKitGTK runtime are required |
| macOS 11+ Intel/Apple Silicon | Universal `.app`, `.dmg` | Menu-bar/tray process | Apple signing and notarization are required for public distribution |
| iPhone/iPad | Companion target | iOS may suspend networking | Not an unattended execution host |
| Android | Companion target | Foreground service required | Persistent trading service is not implemented or certified |

The mobile limitation is imposed by mobile background-execution policy. A mobile client can eventually monitor, approve, configure, and receive P2P notifications, but unattended execution must remain on a desktop host until a separately designed and certified mobile service exists.

## What is local

- Workspaces, terminal settings, encrypted Strategy Lab state, strategy checkpoints, Paper ledgers, broker records, user scripts, investment-group mandates, social state, direct-message outboxes, webhook outboxes, IMM depth history, and P2P inboxes are stored on the device.
- Broker API secrets and the permanent P2P private key are stored in the operating-system credential vault and are never returned to the webview.
- Broker requests are signed in the native Rust process. Durable execution intents are processed by a native worker even while the main window is hidden.
- Closed-candle Black Script evaluation runs in the installed app's supervised background webview. A Web Lock, periodic heartbeat, disabled background throttling where supported, and native watchdog keep that strategy host alive and reload it if it stops reporting. Quitting the app stops strategy evaluation.
- IMM live aggregation runs from local public market feeds. Its wide professional ladder combines public Bybit, Binance, and OKX order books locally; persistent depth memory is encrypted in the native document store.
- Event Alpha uses encrypted local authority in standalone mode and never silently calls the VPS. Its causal engine remains fail-closed until the user configures local point-in-time evidence providers; no provider data is fabricated.
- BC-QALC configurations, runtime snapshots, and bounded timelines use the encrypted local document store. The standalone host can run its deterministic Paper-only event engine against Bybit's canonical L200 book and public trades, with native instrument discovery, native exchange-clock sampling, gap/staleness recovery, conservative fees, queue-ahead simulation, and restart restoration. It remains `RESEARCH`—not Paper-certified—and its type boundary makes live order submission and Investment Group fanout impossible.
- BlackGPT can use an operator-installed Ollama-compatible model through a native bridge. Only explicit numeric loopback endpoints (`127.0.0.1` or `[::1]`) at `/api/chat` are accepted; redirects, embedded credentials, remote hosts, oversized requests, and oversized responses are rejected. The model itself is not bundled, and chat history/provider settings are encrypted locally.

The native Content Security Policy excludes Black Terminal VPS and Supabase endpoints in standalone builds. Bybit is currently the only locally authenticated and automated venue, and the certified local Strategy Lab route is linear futures. Other displayed public venues are market-data sources, not promises of local trade execution.

## Execution safety model

- Strategy/manual execution commands use a SQLite WAL queue with unique idempotency keys, dependency edges, leases, bounded retries, restart recovery, and terminal failure states.
- Entry leverage is set before its dependent order. Reversal is close-confirm-then-open, and partial take-profit plans use reduce-only orders reconciled by deterministic order-link identifiers.
- Mainnet submission requires explicit per-account confirmation. Black Terminal rejects withdrawal-enabled API credentials.
- A first-time Strategy Lab target must be flat and have no working orders on the strategy symbol. This prevents automation from inheriting or modifying personal/manual exposure.
- Personal-chart broker accounts and Strategy Lab broker accounts use separate workspace scopes.
- Investment-group membership grants no execution authority. Each member must publish an explicit, bounded mandate for a specific local account.
- Remote investment-group delivery is acknowledged before the manager checkpoint advances, but exchange fills across independent machines cannot be atomic. A member machine must be running and reachable, and partial distributed fills remain an operational risk.

## Local security model

- SQLite document values, execution payloads/results, P2P inbox payloads, IMM history, and durable outboxes are authenticated with AES-256-GCM using a device key stored in the operating-system credential vault.
- Queue metadata needed for ordering, leasing, and recovery remains visible to the local operating-system account.
- Direct P2P request/response streams are authenticated and encrypted end to end by libp2p Noise. Signed gossipsub topics are integrity-protected but are visible to peers subscribed to that topic; public social announcements must not contain confidential data.
- LAN discovery uses mDNS. After one trusted peer is reached, an isolated Black Terminal Kademlia/Identify mesh expands discovery across reachable peers; the native node also attempts UPnP port mapping, exposes verified external multiaddresses, and automatically reconnects encrypted locally remembered trusted addresses. Internet-wide first contact and reachability behind symmetric NAT or restrictive firewalls use operator-configured Circuit Relay v2 reservations, a bounded `black-terminal.public.v1` Rendezvous v1 registry, and DCUtR direct-upgrade attempts. The hardened relay/rendezvous container and operating runbook live in `infra/p2p-relay`; a live public service is never silently supplied by the VPS.
- Webhook URLs and alert payloads are kept in the encrypted local store. Delivery uses a durable retry outbox and rejects private-network targets, redirects, non-HTTPS URLs, secret-like payload fields, and payloads over 64 KiB.
- Local email delivery is not implemented because no SMTP/OAuth credential adapter has been configured.
- The hosted administrator, subscription, institutional-fund archive, authentic-flow archive, and cloud-control screens do not silently activate in local-only mode. Where no certified local provider exists, the feature reports that boundary instead of contacting Black Cloud.

## Migrating the existing profile

1. Open **Settings** in the existing Black Terminal deployment.
2. Under **Encrypted Profile Migration**, use a unique passphrase of at least 12 characters and export the `.btprofile` file.
3. Install and initialize the standalone app using the same owner email.
4. Open **Settings**, select the archive, enter the passphrase, and import it.
5. Restart and verify the migrated workspaces, seven-pane layouts, indicator visibility/settings, A.I.F. and DOM Pro settings, alerts, scripts, colors, DPI/render preferences, and last chart state.
6. Re-enter broker API keys, webhook URLs, and future provider credentials locally. They are deliberately excluded from migration archives.
7. Recreate and approve Strategy Lab and investment-group execution bindings; migration never carries live trading authority.

The archive uses PBKDF2-SHA-256 with 600,000 iterations and AES-256-GCM authentication. The passphrase is never stored. Imports are bound to the normalized owner email. Broker credentials, authentication tokens, passwords, private keys, active sessions, and webhook secrets are excluded.

## Building installers

Run the **Standalone desktop release** GitHub Actions workflow or push a `desktop-v*` tag. Each platform is built on its native runner. The workflow performs local-runtime contract tests, the production/security build, Rust tests, native packaging, and a SHA-256 artifact manifest. Windows NSIS and WiX packages use the Black Terminal pyramid/red-arrow installer artwork; the in-app first-run wizard provides the full black/red/silver local-runtime setup flow on every desktop platform.

Local development commands:

```bash
npm ci --ignore-scripts
npm run test:desktop-local
npm run test:script-runtime
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri:build
```

Linux also requires the Tauri/WebKitGTK development dependencies listed in `.github/workflows/standalone-release.yml`. A front-end-only build is not native-runtime certification. Public installers additionally require Windows signing and Apple Developer signing/notarization credentials.

## Release gate before real funds

Do not call a build production-ready merely because it compiles. A mainnet release requires all of the following:

1. Native tests and clean-machine installer tests pass on Windows, Linux, and macOS.
2. Bybit demo validates long, short, reduce-only TP1–TP7, cancel, amend, leverage, restart recovery, duplicate suppression, and close-confirm-then-open reversal.
3. Deterministic closed-candle replay matches the source strategy for entries, exits, partial fills, checkpoint recovery, and bar-magnifier coverage.
4. A prolonged tray/background soak confirms evaluation and native queue processing continue with the window hidden and stop only on explicit quit.
5. Network loss, rate limits, clock skew, stale market data, partial fills, insufficient margin, existing manual exposure, and exchange rejection fail closed and reconcile correctly.
6. P2P mandate rejection, offline member, delayed ACK, duplicate delivery, and partial distributed execution scenarios are exercised.
7. Signed installers are scanned, installed on clean machines, upgraded in place, and uninstalled without deleting exported backups.
8. Mainnet begins with staged capital, exchange-side limits, monitoring, and an independent kill switch.

There is no responsible “zero bugs” certification for trading software. Release approval must be based on repeatable evidence and explicitly recorded residual risk.
