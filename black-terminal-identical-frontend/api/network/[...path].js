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
import joinRequest from "../../server/network/routes/investment-group-join-request.js";
import messages from "../../server/network/routes/investment-group-messages.js";
import reviewRequest from "../../server/network/routes/investment-group-review-request.js";
import moderation from "../../server/network/routes/investment-group-moderation.js";
import { sendError } from "../../server/portfolio-api.js";
import { requireApiSecurity } from "../../server/security/securityMiddleware.js";

const resourceHandlers = {
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

const investmentGroupHandlers = {
  "join-request": joinRequest,
  "messages": messages,
  "review-request": reviewRequest,
  "moderation": moderation
};

const cleanSegment = (value) => String(value || "").replace(/\.js$/, "");

export default async function handler(req, res) {
  try {
    const path = Array.isArray(req.query?.path)
      ? req.query.path.map(cleanSegment)
      : String(req.query?.path || "").split("/").filter(Boolean).map(cleanSegment);

    if (path.length === 3 && path[0] === "investment-groups") {
      const [, groupId, action] = path;
      const routeHandler = investmentGroupHandlers[action];
      if (!routeHandler) return res.status(404).json({ error: "Unknown investment group route." });
      const security = await requireApiSecurity(req, res, { endpoint: `network.investment-group.${action}`, maxBytes: 128 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
      if (security.handled) return;
      req.query.groupId = groupId;
      req.query.action = action;
      return routeHandler(req, res);
    }

    if (path.length !== 1) return res.status(404).json({ error: "Unknown professional network route." });
    const resource = path[0];
    const routeHandler = resourceHandlers[resource];
    if (!routeHandler) return res.status(404).json({ error: "Unknown professional network route." });
    const security = await requireApiSecurity(req, res, { endpoint: `network.${resource}`, maxBytes: 512 * 1024, rateLimit: { perMinute: 60, perDay: 10000 } });
    if (security.handled) return;
    return routeHandler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}
