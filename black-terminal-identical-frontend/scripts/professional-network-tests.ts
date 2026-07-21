import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canViewPost, cleanText, sanitizeHandle } from "../server/network/social-utils.js";
import { parseProfessionalNetworkHash } from "../src/modules/professional-network/routing.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

assert.equal(sanitizeHandle("  Black Triangle Group  "), "black_triangle_group");
assert.equal(sanitizeHandle("A!"), "a");
assert.equal(cleanText("  market structure  ", 20, true), "market structure");
assert.equal(cleanText("123456", 4), "1234");
assert.throws(() => cleanText("  ", 20, true), /Required text/);

assert.deepEqual(parseProfessionalNetworkHash("#network/feed"), { section: "feed" });
assert.deepEqual(parseProfessionalNetworkHash("#network/profile/quant_desk/research"), { section: "profile", handle: "quant_desk", profileTab: "research" });
assert.deepEqual(parseProfessionalNetworkHash("#network/messages/abc-123"), { section: "messages", conversationId: "abc-123" });
assert.deepEqual(parseProfessionalNetworkHash("#network/post/post-123?comment=comment-4"), { section: "feed", postId: "post-123" });
assert.deepEqual(parseProfessionalNetworkHash("#profile/public_trader/followers"), { section: "profile", handle: "public_trader", profileTab: "followers" });

const publicPost = { id: "post", user_id: "author", visibility: "public", deleted_at: null };
assert.equal(await canViewPost(mockSupabase({ blocked: false }), "viewer", publicPost), true);
assert.equal(await canViewPost(mockSupabase({ blocked: true }), "viewer", publicPost), false);
assert.equal(await canViewPost(mockSupabase({ blocked: false }), "author", { ...publicPost, visibility: "private" }), true);
assert.equal(await canViewPost(mockSupabase({ blocked: false, follows: true }), "viewer", { ...publicPost, visibility: "followers" }), true);
assert.equal(await canViewPost(mockSupabase({ blocked: false, follows: false }), "viewer", { ...publicPost, visibility: "followers" }), false);
assert.equal(await canViewPost(mockSupabase({ blocked: false, groupMember: true }), "viewer", { ...publicPost, visibility: "group", investment_group_id: "group" }), true);

const migration = read("docs/migrations/20260717_phase4_professional_network_chapter2.sql");
for (const table of [
  "profile_specialties", "profile_links", "profile_privacy_settings", "social_follow_requests",
  "user_blocks", "user_mutes", "social_post_media", "social_post_symbols", "social_post_attachments",
  "social_post_edits", "social_reactions", "social_comments", "social_comment_reactions",
  "social_saved_collections", "social_saved_posts", "conversations", "conversation_members",
  "message_requests", "messages", "message_attachments", "message_reads", "notification_preferences",
  "content_reports", "moderation_actions", "social_rate_limit_events"
]) assert.match(migration, new RegExp(`(?:create table if not exists|alter table) public\\.${table}`), `missing schema for ${table}`);

for (const table of ["social_reactions", "social_comments", "social_saved_posts", "messages", "message_reads", "content_reports"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), `RLS is not enabled for ${table}`);
}
assert.doesNotMatch(migration, /using\s*\(\s*true\s*\)/i, "permissive RLS policy found");
assert.match(migration, /professional-media'[\s\S]*false/, "professional media bucket must remain private");
assert.match(migration, /social_start_direct_conversation/, "atomic direct-conversation RPC is missing");
assert.match(migration, /social_consume_rate_limit/, "atomic social rate limiter is missing");
assert.match(migration, /idx_social_comments_idempotency/, "comment idempotency is missing");
assert.match(migration, /idx_profile_posts_idempotency/, "post idempotency is missing");

const engagement = read("server/network/routes/social-engagement.js");
for (const operation of ["reaction", "comment", "edit_comment", "delete_comment", "comment_reaction", "save", "collection", "repost", "report", "hide"]) assert.match(engagement, new RegExp(`operation === \\"${operation}\\"`));
const messaging = read("server/network/routes/social-messaging.js");
for (const operation of ["start", "send", "review_request", "read", "archive", "mute", "delete_message"]) assert.match(messaging, new RegExp(`operation === \\"${operation}\\"|operation === \\"archive\\" \\|\\| operation === \\"mute\\"`));
assert.match(messaging, /clientMessageId/, "message idempotency key is not enforced");
assert.match(messaging, /social_start_direct_conversation/, "messaging route bypasses the atomic conversation RPC");

const routeMap = read("api/network/[resource].js");
for (const route of ["professional-center", "social-posts", "social-engagement", "social-relationships", "social-messaging", "social-notifications", "social-media", "social-search", "social-assets", "social-moderation"]) assert.match(routeMap, new RegExp(`\\"${route}\\"`));

const page = read("src/modules/professional-network/ProfessionalCenterPage.tsx");
for (const component of ["FeedComposer", "ProfileHeader", "ProfileWorkspace", "MessagingPanel", "NotificationsPanel", "DiscoveryPanel", "ModerationPanel"]) assert.match(page, new RegExp(`<${component}`));
assert.ok(read("src/modules/professional-network/components/PostCard.tsx").length < 30000, "PostCard has become an unbounded monolith");
assert.ok(root.length > 0);

console.log("Professional Network deterministic contract tests passed.");

function mockSupabase(state: { blocked: boolean; follows?: boolean; groupMember?: boolean }) {
  return {
    from(table: string) {
      const result = table === "user_blocks"
        ? { data: state.blocked ? [{ blocker_user_id: "viewer" }] : [], error: null }
        : table === "user_follows"
          ? { data: state.follows ? { follower_user_id: "viewer" } : null, error: null }
          : table === "investment_group_members"
            ? { data: state.groupMember ? { id: "membership" } : null, error: null }
            : { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "or", "limit"]) builder[method] = () => builder;
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    }
  } as never;
}
