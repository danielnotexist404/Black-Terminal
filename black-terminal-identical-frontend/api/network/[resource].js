import follow from "../../server/network/routes/follow.js";
import investmentGroups from "../../server/network/routes/investment-groups.js";
import posts from "../../server/network/routes/posts.js";
import profile from "../../server/network/routes/profile.js";
import professionalCenter from "../../server/network/routes/professional-center.js";
import socialPosts from "../../server/network/routes/social-posts.js";
import socialEngagement from "../../server/network/routes/social-engagement.js";
import socialRelationships from "../../server/network/routes/social-relationships.js";
import socialMessaging from "../../server/network/routes/social-messaging.js";
import socialNotifications from "../../server/network/routes/social-notifications.js";
import socialMedia from "../../server/network/routes/social-media.js";
import socialSearch from "../../server/network/routes/social-search.js";
import socialAssets from "../../server/network/routes/social-assets.js";
import socialModeration from "../../server/network/routes/social-moderation.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

const handlers = {
  follow,
  "investment-groups": investmentGroups,
  posts,
  profile,
  "professional-center": professionalCenter,
  "social-posts": socialPosts,
  "social-engagement": socialEngagement,
  "social-relationships": socialRelationships,
  "social-messaging": socialMessaging,
  "social-notifications": socialNotifications,
  "social-media": socialMedia,
  "social-search": socialSearch,
  "social-assets": socialAssets,
  "social-moderation": socialModeration
};

export default async function handler(req, res) {
  try {
    const resource = String(req.query?.resource || "").replace(/\.js$/, "");
    const routeHandler = handlers[resource];
    if (!routeHandler) return res.status(404).json({ error: "Unknown professional network route." });
    const security = await requireApiSecurity(req, res, { endpoint: `network.${resource}`, maxBytes: 512 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
    if (security.handled) return;
    return routeHandler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}
