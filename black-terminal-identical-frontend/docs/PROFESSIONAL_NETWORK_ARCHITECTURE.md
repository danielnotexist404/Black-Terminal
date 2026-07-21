# Professional Network Architecture

## Scope

Phase IV Chapter II turns Professional Center into Black Terminal's professional market-intelligence network. The canonical flow is:

```text
Professional Center UI
  -> authenticated /api/network/[resource]
  -> server/network route
  -> authorization, privacy, rate limit, and validation
  -> Supabase canonical tables/private storage
  -> hydrated response with short-lived media URLs
```

The browser never receives the Supabase service-role key and never writes privileged moderation or rate-limit records.

## Frontend Boundaries

`src/modules/professional-network/` owns the network experience. `ProfessionalCenterPage` coordinates route state and normalized post entities; profile, feed, composer, messaging, discovery, notifications, assets, and moderation remain separate components. Legacy profile entry points are wrappers so existing navigation continues to work.

Hash routes are shareable and preserve profile tabs, messages, and individual posts:

- `#network/feed`
- `#network/profile/:handle/:tab`
- `#network/post/:postId`
- `#network/messages/:conversationId`
- `#network/notifications`

## Server Boundaries

- `professional-center`: profile reads, editing, privacy, signed identity media
- `social-posts`: cursor feeds, structured publishing, edits, lifecycle history
- `social-engagement`: reactions, threaded comments, reposts, saves, reports
- `social-relationships`: follows, requests, mute, block
- `social-messaging`: conversations, requests, messages, reads, archive/mute
- `social-notifications`: notification inbox and preferences
- `social-media`: scoped signed-upload authorization
- `social-search`: privacy-aware discovery
- `social-assets`: public indicator and strategy publication metadata
- `social-moderation`: administrator review and audit actions

Exactly one canonical profile (`profiles_extended`), post (`profile_posts`), follow (`user_follows`), notification (`notification_events`), indicator, strategy, and Investment Group concept is reused.

## State And Realtime

Posts are normalized by ID before entering feed/profile lists. Feed, comments, notifications, and conversations use cursor pagination. Realtime is intentionally narrow: the active conversation and authenticated user's notifications only. Channels are unsubscribed on dependency change and unmount.

## Deployment Dependencies

Apply `docs/migrations/20260717_phase4_professional_network_chapter2.sql` before enabling the deployed UI. Vercel also requires the existing Supabase URL, public key, and server-only service-role key.
