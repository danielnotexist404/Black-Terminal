# Project Obsidian Phase III - Chapter 1

Phase III defines Black Terminal as a Trading Operating System, not a charting clone or exchange UI.

## System Boundaries

Black Terminal now treats execution and capital management as separate systems:

- Execution System: broker connections, wallet connections, live positions, orders, margin, leverage, risk checks, exchange communication, execution routing.
- Capital Management System: portfolio analytics, historical performance, capital allocation, investment groups, managed followers, performance statistics, enterprise risk, execution matrix, audit, permissions.

## Module Ownership

- Positions owns execution. Users connect brokers and wallets from Positions, manage open positions, monitor live orders, and route all orders through the Execution Engine.
- Portfolio Manager owns capital management. It consumes synchronized portfolio data and expands by role. It does not own broker connectivity and does not submit direct exchange orders.

## Product Tiers

- Retail: execution cockpit, portfolio analytics, risk statistics, performance views, investment group discovery.
- Professional: retail capabilities plus higher limits and future advanced analytics.
- Enterprise: managed capital, followers, investment groups, execution matrix, audit, permissions, institutional risk controls.
- Admin: unrestricted administrative and override capabilities isolated from normal user surfaces.

## Engineering Laws Implemented In This Chapter

- UI execution flows route through the Execution Engine API.
- Broker and wallet connectivity live in Positions.
- Portfolio Manager no longer exposes an order ticket.
- Portfolio Manager tabs are capability-driven, not hardcoded decorative controls.
- Empty states are honest: no fake positions, balances, followers, groups, or allocation data.
