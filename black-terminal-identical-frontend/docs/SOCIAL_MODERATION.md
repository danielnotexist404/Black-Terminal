# Social Moderation

Users may privately report posts, comments, profiles, messages, and groups for spam, harassment, impersonation, misleading performance claims, scams, market manipulation, copyright violations, sensitive information, or another documented reason.

Reports enter a restricted queue. Only an authenticated administrator with `admin.override` can read it or issue an action. Every decision creates an immutable moderation-action row containing the moderator, target, action, and internal reason. Reporter identities are never included in public responses.

Supported review outcomes are dismiss, warn, hide, remove, restrict, and suspend. Hide/remove actions soft-delete supported content so references remain auditable without remaining visible. Block and mute are user-controlled and enforced independently of administrative moderation.

Server rate limits cover posts, comments, reactions, reposts, follows, message starts, messages, uploads, mentions, reports, and search. The limiter uses an advisory transaction lock to prevent concurrent burst bypass.
