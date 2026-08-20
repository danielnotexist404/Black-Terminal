# Vercel Function Migration

The central router preserves all 13 function paths:

| Former function | Persistent Black Cloud route |
|---|---|
| `api/claude.js` | `/api/claude` |
| `api/cloud-execution/[...path].js` | `/api/cloud-execution/:path*` |
| `api/email/send.js` | `/api/email/send` |
| `api/event-alpha/[...path].js` | `/api/event-alpha/:path*` |
| `api/exchange-accounts/[...path].js` | `/api/exchange-accounts/:path*` |
| `api/execution/[...path].js` | `/api/execution/:path*` |
| `api/imm/status.js` | `/api/imm/status` |
| `api/market-depth/[action].js` | `/api/market-depth/:action` |
| `api/network/[resource].js` | `/api/network/:resource` |
| `api/network/investment-groups/[groupId]/[action].js` | `/api/network/investment-groups/:groupId/:action` |
| `api/portfolio/snapshot.js` | `/api/portfolio/snapshot` |
| `api/protocols/hyperliquid/[action].js` | `/api/protocols/hyperliquid/:action` |
| `api/security/[action].js` | `/api/security/:action` |

`/api/liquidation-intelligence/:action` remains a compatibility rewrite into market-depth BCLIF handling. Existing function modules are imported; the migration does not duplicate business logic. The central process adds bounded bodies, request deadlines, readiness/liveness, structured request IDs and graceful shutdown.
