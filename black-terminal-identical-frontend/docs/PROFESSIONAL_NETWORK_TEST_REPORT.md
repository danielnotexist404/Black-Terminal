# Professional Network Test Report

## Automated Evidence

Run:

```powershell
npm run test:professional-network
npm run typecheck
npm run build
```

The deterministic suite checks route parsing, handle/text normalization, owner/public/follower/group/block visibility, required schema entities, RLS enablement, absence of permissive migration policies, private media storage, direct-conversation atomicity, post/comment/message idempotency, required engagement operations, API route registration, and frontend module composition.

## Required Production Certification

Local tests cannot prove hosted Supabase RLS or realtime behavior. After applying the migration to staging, certify with two regular users plus one administrator:

1. Edit profile identity and private media.
2. Publish text, research, trade idea, and image posts.
3. Attach one public indicator and strategy; reject a private attachment.
4. Follow public and private profiles; approve a follow request.
5. React, comment, reply, edit, delete, repost, quote, save, and use a named collection.
6. Start an allowed message and a message request; accept, read, archive, mute, and block.
7. Verify post/profile/group visibility from unauthorized sessions.
8. Verify private media cannot be read with an expired or unrelated URL.
9. Submit and resolve a moderation report without exposing the reporter.
10. Verify desktop, tablet, mobile, high-DPI, keyboard, and reduced-motion behavior.
11. Inspect realtime channel cleanup and long-feed memory behavior.

Production certification remains incomplete until those hosted checks and visual snapshots are recorded. This document must be updated with dates, deployment ID, test users, and results rather than assuming local build success proves production security.
