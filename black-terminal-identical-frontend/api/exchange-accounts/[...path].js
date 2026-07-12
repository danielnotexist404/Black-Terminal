import connect from "../../server/routes/exchange-accounts/connect.js";
import diagnostics from "../../server/routes/exchange-accounts/diagnostics.js";
import sync from "../../server/routes/exchange-accounts/sync.js";
import mainnetValidation from "../../server/routes/exchange-accounts/mainnet-validation.js";
import bybitRuntimeStatus from "../../server/routes/exchange-accounts/bybit-runtime-status.js";
import account from "../../server/routes/exchange-accounts/account.js";
import { applyCors, sendError } from "../../server/portfolio-api.js";

const routes = new Map([
  ["connect", connect],
  ["diagnostics", diagnostics],
  ["sync", sync],
  ["mainnet-validation", mainnetValidation],
  ["bybit-runtime-status", bybitRuntimeStatus]
]);

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query.path, req, "exchange-accounts");
    const route = routes.get(path[0]);

    if (route) return route(req, res);
    if (path.length === 1 && path[0]) return account(req, res);

    if (applyCors(req, res)) return;
    return res.status(404).json({ error: "Exchange account route not found." });
  } catch (error) {
    if (res.headersSent) throw error;
    return sendError(res, error);
  }
}

function normalizePath(value, req, baseSegment) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return [String(value)];

  try {
    const pathname = new URL(req.url || "", "https://black-terminal.local").pathname;
    const marker = `/api/${baseSegment}/`;
    const markerIndex = pathname.indexOf(marker);
    const remainder = markerIndex >= 0
      ? pathname.slice(markerIndex + marker.length)
      : pathname.replace(/^\/+/, "");
    return remainder
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean)
      .filter((segment, index, all) => !(index === 0 && segment === "api") && !(index === 1 && all[0] === "api" && segment === baseSegment));
  } catch {
    return [];
  }
  return [];
}
