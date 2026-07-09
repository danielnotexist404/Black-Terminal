import follow from "../../server/network/routes/follow.js";
import investmentGroups from "../../server/network/routes/investment-groups.js";
import posts from "../../server/network/routes/posts.js";
import profile from "../../server/network/routes/profile.js";

const handlers = {
  follow,
  "investment-groups": investmentGroups,
  posts,
  profile
};

export default async function handler(req, res) {
  const resource = String(req.query?.resource || "").replace(/\.js$/, "");
  const routeHandler = handlers[resource];

  if (!routeHandler) {
    return res.status(404).json({ error: "Unknown professional network route." });
  }

  return routeHandler(req, res);
}
