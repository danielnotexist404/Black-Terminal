# Phase IV Preview - Professional Network Foundation

Status: foundation implemented.

## Objective

Phase IV adds a professional trading network inside Black Terminal. It is not generic social media. It is a trading identity, research publishing, follow graph, investment group discovery, join request, and Trading Room foundation that can later connect into capital allocation and verified performance analytics.

## Implemented Surface

- Added `PROFILE` to the main sidebar.
- Added `INVESTMENT GROUPS` to the main sidebar.
- Added a Professional Profile module with avatar and banner upload scaffolding, display name, bio, country, trading style tags, Research Feed composer, own posts, followed research feed, follower/following graph, published indicator scaffolding, published strategy scaffolding, opt-in performance disclosure settings, and owned/joined group views.
- Added an Investment Groups module with discovery, Enterprise/Admin creation gate, six-step group creation wizard, password-hash-only protected group handling, group detail tabs, join requests, owner/admin review, and Trading Room channels.
- Updated Portfolio Manager Investment Groups tab to show owned/joined/discovery groups and role-based group tool status.

## Architecture

The frontend currently uses `src/modules/profile/professionalNetworkStore.ts` as a typed scaffold store. It keeps state local so the product surface can be exercised before production Supabase deployment.

The production server path is scaffolded through:

- `api/network/profile.js`
- `api/network/posts.js`
- `api/network/follow.js`
- `api/network/investment-groups.js`
- `api/network/investment-groups/[groupId]/join-request.js`
- `api/network/investment-groups/[groupId]/review-request.js`
- `api/network/investment-groups/[groupId]/messages.js`
- `server/network/permissions.js`

## Permission Model

Capabilities added:

- `can_create_investment_group`
- `can_manage_investment_group`
- `can_approve_group_requests`
- `can_post_group_announcements`
- `can_view_enterprise_portfolio_tools`
- `can_publish_research`
- `can_publish_indicators`
- `can_publish_strategies`
- `can_follow_users`

Retail users can follow users and publish research. Professional users can publish indicators and strategies. Enterprise/Admin users can create Investment Groups. Enterprise users manage their own groups; Admin override can manage across the platform.

## Data Model

The Supabase migration ledger now includes:

- `profiles_extended`
- `user_follows`
- `profile_posts`
- `published_indicators`
- `published_strategies`
- `investment_groups`
- `investment_group_stats`
- `investment_group_members`
- `investment_group_join_requests`
- `investment_group_messages`
- `notification_events`

Password-protected groups store only `password_hash`. No plaintext group password is stored.

## Trust Rules

- Performance disclosure is opt-in.
- Empty performance data renders as awaiting verified data, not fake PnL.
- Historical performance language is used.
- Group creation is restricted to Enterprise/Admin.
- Group owner cannot access broker credentials through this subsystem.
- Capital control is not implemented here and must continue through allocation and execution architecture later.

## Next Work

- Wire Profile and Investment Groups pages to Supabase API clients after the migration is applied.
- Add verified exchange performance feeds.
- Add admin moderation tools for group suspension and content governance.
- Add notification center UI backed by `notification_events`.
- Connect Investment Groups to future Allocation Engine rules without bypassing OMS/EMS/Risk.
