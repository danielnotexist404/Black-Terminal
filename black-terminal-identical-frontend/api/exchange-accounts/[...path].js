import connect from "../../server/routes/exchange-accounts/connect.js";
import diagnostics from "../../server/routes/exchange-accounts/diagnostics.js";
import sync from "../../server/routes/exchange-accounts/sync.js";
import mainnetValidation from "../../server/routes/exchange-accounts/mainnet-validation.js";
import bybitRuntimeStatus from "../../server/routes/exchange-accounts/bybit-runtime-status.js";
import account from "../../server/routes/exchange-accounts/account.js";
import { applyCors } from "../../server/portfolio-api.js";

const routes = new Map([
  ["connect", connect],
  ["diagnostics", diagnostics],
  ["sync", sync],
  ["mainnet-validation", mainnetValidation],
  ["bybit-runtime-status", bybitRuntimeStatus]
]);

export default async function handler(req, res) {
  const path = normalizePath(req.query.path);
  const route = routes.get(path[0]);

  if (route) return route(req, res);
  if (path.length === 1 && path[0]) return account(req, res);

  if (applyCors(req, res)) return;
  return res.status(404).json({ error: "Exchange account route not found." });
}

function normalizePath(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return [String(value)];
  return [];
}
