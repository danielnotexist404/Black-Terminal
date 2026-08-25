import claudeHandler from "../../api/claude.js";
import cloudExecutionHandler from "../../api/cloud-execution/[...path].js";
import emailHandler from "../../api/email/send.js";
import eventAlphaHandler from "../../api/event-alpha/[...path].js";
import exchangeAccountsHandler from "../../api/exchange-accounts/[...path].js";
import executionHandler from "../../api/execution/[...path].js";
import immStatusHandler from "../../api/imm/status.js";
import institutionalFlowHandler from "../../api/institutional-flow.js";
import marketDepthHandler from "../../api/market-depth/[action].js";
import marketFlowHandler from "../../api/market-flow/[action].js";
import networkHandler from "../../api/network/[resource].js";
import investmentGroupActionHandler from "../../api/network/investment-groups/[groupId]/[action].js";
import portfolioSnapshotHandler from "../../api/portfolio/snapshot.js";
import qalcHandler from "../../api/qalc/[...path].js";
import hyperliquidHandler from "../../api/protocols/hyperliquid/[action].js";
import securityHandler from "../../api/security/[action].js";
import strategiesHandler from "../../api/strategies/[...path].js";

const EXACT_ROUTES = new Map([
  ["/api/claude", claudeHandler],
  ["/api/email/send", emailHandler],
  ["/api/imm/status", immStatusHandler],
  ["/api/institutional-flow", institutionalFlowHandler],
  ["/api/portfolio/snapshot", portfolioSnapshotHandler],
  ["/api/strategies", strategiesHandler]
]);

const DYNAMIC_ROUTES = [
  route(/^\/api\/network\/investment-groups\/([^/]+)\/([^/]+)\/?$/, investmentGroupActionHandler, ["groupId", "action"]),
  route(/^\/api\/cloud-execution\/(.+)\/?$/, cloudExecutionHandler, ["path"], true),
  route(/^\/api\/event-alpha\/(.+)\/?$/, eventAlphaHandler, ["path"], true),
  route(/^\/api\/exchange-accounts\/(.+)\/?$/, exchangeAccountsHandler, ["path"], true),
  route(/^\/api\/execution\/(.+)\/?$/, executionHandler, ["path"], true),
  route(/^\/api\/market-depth\/([^/]+)\/?$/, marketDepthHandler, ["action"]),
  route(/^\/api\/market-flow\/([^/]+)\/?$/, marketFlowHandler, ["action"]),
  route(/^\/api\/qalc\/(.+)\/?$/, qalcHandler, ["path"], true),
  route(/^\/api\/network\/([^/]+)\/?$/, networkHandler, ["resource"]),
  route(/^\/api\/protocols\/hyperliquid\/([^/]+)\/?$/, hyperliquidHandler, ["action"]),
  route(/^\/api\/security\/([^/]+)\/?$/, securityHandler, ["action"]),
  route(/^\/api\/strategies\/(.+)\/?$/, strategiesHandler, ["path"], true)
];

export function resolveApiRoute(pathname) {
  const cleanPath = normalizePathname(pathname);
  const exact = EXACT_ROUTES.get(cleanPath);
  if (exact) return { handler: exact, params: {} };

  const legacyLiquidation = cleanPath.match(/^\/api\/liquidation-intelligence\/([^/]+)\/?$/);
  if (legacyLiquidation) {
    return {
      handler: marketDepthHandler,
      params: { action: "bclif", bclifAction: decode(legacyLiquidation[1]) }
    };
  }

  for (const candidate of DYNAMIC_ROUTES) {
    const match = cleanPath.match(candidate.pattern);
    if (!match) continue;
    const params = {};
    candidate.names.forEach((name, index) => {
      const value = decode(match[index + 1]);
      params[name] = candidate.catchAll ? value.split("/").filter(Boolean) : value;
    });
    return { handler: candidate.handler, params };
  }
  return null;
}

export function apiRouteManifest() {
  return Object.freeze({
    exact: [...EXACT_ROUTES.keys()],
    dynamic: [
      "/api/network/investment-groups/:groupId/:action",
      "/api/cloud-execution/:path*",
      "/api/event-alpha/:path*",
      "/api/exchange-accounts/:path*",
      "/api/execution/:path*",
      "/api/market-depth/:action",
      "/api/market-flow/:action",
      "/api/qalc/:path*",
      "/api/network/:resource",
      "/api/protocols/hyperliquid/:action",
      "/api/security/:action",
      "/api/strategies/:path*",
      "/api/liquidation-intelligence/:action (compatibility rewrite)"
    ]
  });
}

function route(pattern, handler, names, catchAll = false) {
  return Object.freeze({ pattern, handler, names, catchAll });
}

function normalizePathname(value) {
  const path = String(value || "/").split("?")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function decode(value) {
  try { return decodeURIComponent(String(value)); } catch { return String(value); }
}
