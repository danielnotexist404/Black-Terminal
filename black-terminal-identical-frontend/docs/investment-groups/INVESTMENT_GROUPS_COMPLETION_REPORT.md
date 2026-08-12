# Investment Groups completion report

## Delivery identity

- Starting commit: `17c6323578442623cae785b849783aaf16800a68`.
- Delivery branch: `preview` only. `main` is not changed or pushed.
- Final commit: reported by the delivery handoff/git log because a commit cannot embed its own hash.
- Production deployment: not performed. The forward migration and environment certification must be applied to the preview deployment before server-backed flows can operate there.

## Delivered scope

The repository audit classifies existing foundations and the new UI provides Discover, Joined Groups and authorized My Investment Group navigation. Group detail includes overview, performance, strategy, risk, members and research. The five-stage join flow uses risk disclosure `2026-08-12.v1`, persisted acceptance/drafts, separate Copy Trading versus research-only Obsidian choices, strict broker/worker/reconciliation checks, an idempotent mandate, user allocation/loss/drawdown/slippage controls and consent review.

The mandate uses withdrawal/transfer `false`; requested leverage is bounded by user, group, EMS and instrument caps. Member pause/resume/leave are immediate for future entries. Leave supports detach, close-now handoff and when-flat; removal detaches rather than closes. Cockpit delivery includes manager-only authorization, group selector, member directory/detail, consent-aware capital/health, attributed positions, gross/net PnL and exposure, execution-quality summaries, leverage updates, approval/rejection, pause/removal, emergency stop and a working canonical Group Execution Ticket. The ticket submits one idempotent group intent to the protected server route for OMS/EMS fan-out; it never submits follower orders from React. Portfolio Manager shows member and owner group summaries from the same API.

APIs extend the protected Investment Group routes for detail, risk acceptance, join drafts/join, membership/pause/resume/leave, waitlist, cockpit/members, approvals, leverage, member pause/removal, positions, analytics and emergency stop. A forward migration adds policy/version/visibility/history/snapshot/exit/removal/waitlist records, group attribution and RLS. Events and notifications cover risk acceptance, join/activation/rejection, pause/resume, leverage, leave/removal, emergency stop and waitlist.

## Verification

Passing local checks: Investment Group contract tests; TypeScript; migration-source verifier; professional network; Black Cloud; investor execution; mandates; reconciliation; persistent connectivity; broker connectivity; production Vite build; security contracts; production-asset secret audit. In-app browser QA covered desktop and 390px responsive layouts, Investment Groups navigation/empty/auth states and Portfolio Manager integration, with no Investment Group `TypeError` or `ReferenceError` in the browser log.

Aggregate calculation benchmark, 2,000 iterations: 10 members p50/p95/p99 `0.0071/0.0149/0.0619 ms`; 100 members `0.0386/0.0579/0.1078 ms`; 500 members `0.1853/0.2538/0.3343 ms`. This is not a production capacity claim.

## Remaining limitations/blockers

- The SQL migration is forward-only and is not applied to a shared environment by this repository change.
- `CLOSE_NOW` safely revokes entry first and requires the existing OMS/EMS close-ticket path to complete attributable open positions; no direct broker shortcut was added.
- Historical chart retention/rollup scheduling and higher-volume browser table virtualization remain deployment-scale follow-up work.
- Production legal review of the disclosure remains required.
- Obsidian remains blocked as documented in `OBSIDIAN_FUTURE_INTEGRATION.md`.

No withdrawal capability was introduced. Broker secrets remain inaccessible to group managers and React.

## Screenshots

- `screenshots/investment-groups-desktop.png`
- `screenshots/investment-groups-mobile.png`
- `screenshots/portfolio-manager-investment-groups.png`

Screenshots truthfully show the unauthenticated server state because no fake memberships, balances or positions were injected for visual review.
