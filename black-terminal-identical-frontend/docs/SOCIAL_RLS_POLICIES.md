# Social RLS Policies

Phase IV Chapter II enables RLS on every new social, messaging, privacy, report, and preference table.

## Core Rules

- profiles honor owner, public, follower-only, private, deleted, and blocked state
- posts honor author, visibility, follower relationship, active group membership, deletion, and block state
- reactions, comments, reposts, saves, collections, and hidden posts are written only as the authenticated user
- message rows and reads require active conversation membership
- message requests are visible only to sender and recipient
- reports are visible to their reporter; moderation and rate-limit records have no direct client policy
- private media uses storage-object policies in addition to application checks

Security-definer helpers set an explicit `search_path`, expose only boolean membership/visibility results, and have public execution revoked. The direct-conversation RPC is granted only to `service_role`; the atomic rate-limit function accepts authenticated self-use and service-role route use.

The migration contains no `USING (true)` development policies. Service-role routes still perform explicit authorization because bypassing RLS is not an authorization strategy.
