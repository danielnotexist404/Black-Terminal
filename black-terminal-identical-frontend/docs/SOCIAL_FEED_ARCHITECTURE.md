# Social Feed Architecture

## Feed Modes

The route supports For You, Following, Research, Market Analysis, Indicators, Strategies, Investment Groups, Saved, profile-specific, and group-specific feeds. Each response is capped and cursor-based. Muted authors, hidden posts, blocked relationships, private posts, and inaccessible group posts are removed server-side.

Reposts distribute the canonical original rather than duplicating its body. A deleted or privatized original consequently disappears from unauthorized repost contexts.

## Publishing And Engagement

Posts use explicit market classifications and progressive composer modes. Post, comment, and message mutations carry idempotency keys where duplicate delivery is plausible. A user has one reaction per post and one reaction per comment. The UI applies optimistic reaction, follow, save, comment, and repost changes with rollback on failure.

Comments support two visible levels; deeper replies are flattened to the top thread. Owners can edit or soft-delete comments. Post edits preserve prior title/body/metadata. Trade-idea lifecycle changes create explicit update attachments.

Saved posts are private. A default collection is created lazily and users may create named collections from a post's Save menu.

## Performance

The client stores one post entity per canonical ID, lazy-loads images, limits comment previews, paginates long lists, and does not aggressively reorder an active reading session. Realtime is not subscribed across the whole feed.
