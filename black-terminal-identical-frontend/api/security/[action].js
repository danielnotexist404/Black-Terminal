import { handleAdminUsers } from "../../server/security/routes/admin-users.js";
import { handleAudit } from "../../server/security/routes/audit.js";

const handlers = {
  "admin-users": handleAdminUsers,
  audit: handleAudit
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "").replace(/\.js$/, "");
  const route = handlers[action];
  if (!route) return res.status(404).json({ error: "Unknown security route." });
  return route(req, res);
}
