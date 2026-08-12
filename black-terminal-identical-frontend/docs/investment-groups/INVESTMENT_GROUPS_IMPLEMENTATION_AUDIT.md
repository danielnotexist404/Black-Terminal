# Investment Groups implementation audit

Audit baseline: `17c6323578442623cae785b849783aaf16800a68` on the `preview` branch. The audit was completed before the Chapter IV implementation.

| Foundation | Location | Classification | Chapter IV decision |
| --- | --- | --- | --- |
| Investment Groups UI/cards | `src/modules/investment-groups/components/InvestmentGroupsPage.tsx` | MIGRATE | Replace browser-local membership state with protected server routes and real empty states. |
| Group detail/create/join APIs | `api/network/investment-groups`, `server/network/routes` | EXTEND | Preserve group creation and add detail, draft, risk, membership and cockpit actions. |
| Local professional group store | `src/modules/profile/professionalNetworkStore.ts` | DEPRECATE | Retained for unrelated profile capabilities; removed as capital/membership source of truth. |
| Membership/join records | `investment_group_members`, `investment_group_join_requests` | EXTEND | Add operational membership states, participation method, broker/mandate links and idempotency. |
| Role/capability model | network permissions and owner/member roles | REUSE | Cockpit is server-authorized for owner/manager only. |
| Portfolio Manager | `src/modules/portfolio-manager` | EXTEND | Add server-backed member and owner group-capital summaries. |
| Professional Profile integration | professional center/group routes | REUSE | Group identity and verified owner continue to use the network profile foundation. |
| Notifications | `notification_events`, network notification routes | REUSE | Join, activation, pause, leverage, leave and removal notifications write to the canonical table. |
| Broker Connection Manager | Positions/connectivity modules | REUSE | Join only inspects eligibility and links to `Positions -> Connection Manager`; it never collects credentials. |
| Encrypted credential vault | `broker_secret_vault`, secret references | REUSE | Server-side eligibility checks safe metadata only. Secrets are never selected or returned. |
| Automation mandates | `broker_automation_mandates` | REUSE | Activation requires an active mandate with withdrawal/transfer permissions disabled. |
| Group mandates + versions | `group_execution_mandates`, `group_execution_mandate_versions` | EXTEND | Add membership, effective leverage, visibility and exit controls; preserve independent follower mandates. |
| Trade intents + versions | `group_trade_intents`, `group_trade_intent_versions` | REUSE | Cockpit execution remains routed through the existing signed intent pipeline. |
| Follower plans/commands/attempts | Black Cloud execution schema | REUSE | Fan-out remains per follower; revocation cancels only queued entry work. |
| Execution audit | `execution_audit_events` | EXTEND | Chapter IV events contain IDs, versions, reasons and safe metadata only. |
| Broker health | connectivity and `broker_connection_health` | REUSE | Readiness requires cloud/hybrid connection, current worker, reconciliation and safe capabilities. |
| Managed positions/PositionManager | `position_lifecycle_positions` and Position Manager | EXTEND | Add group/membership/mandate attribution, fees and funding. No parallel position book. |
| OMS/EMS | cloud execution allocation, intent and worker services | EXTEND | Enforce current membership immediately before submission and calculate bounded leverage. |
| Black Core event/notification services | core service registry | REUSE | UI does not implement browser trade fan-out or per-member polling. |
| Supabase RLS/migrations | `supabase/migrations` | EXTEND | Forward-only migration adds consented manager views and owner/member isolation. |
| Obsidian UI totals/balances | previous conceptual surfaces | PLACEHOLDER | Replaced by research summary and waitlist only; no capital, deposits or vault address. |
| Fake investor/member balances | browser-local/demo membership state | REMOVE | Capital views now render server data, unavailable labels or explicit empty states. |

No parallel broker, OMS, EMS, mandate or PositionManager architecture was introduced.
