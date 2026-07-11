import order from "../../server/routes/execution/order.js";
import cancel from "../../server/routes/execution/cancel.js";
import modify from "../../server/routes/execution/modify.js";
import cancelAll from "../../server/routes/execution/cancel-all.js";
import positionAction from "../../server/routes/execution/position-action.js";
import protection from "../../server/routes/execution/protection.js";
import accountMode from "../../server/routes/execution/account-mode.js";
import { applyCors } from "../../server/portfolio-api.js";

const routes = new Map([
  ["order", order],
  ["cancel", cancel],
  ["modify", modify],
  ["cancel-all", cancelAll],
  ["position-action", positionAction],
  ["protection", protection],
  ["account-mode", accountMode]
]);

export default async function handler(req, res) {
  const path = normalizePath(req.query.path);
  const route = routes.get(path[0]);
  if (route) return route(req, res);

  if (applyCors(req, res)) return;
  return res.status(404).json({ error: "Execution route not found." });
}

function normalizePath(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return [String(value)];
  return [];
}
