import cancel from "../../../server/protocols/hyperliquid-routes/cancel.js";
import closePosition from "../../../server/protocols/hyperliquid-routes/close-position.js";
import connect from "../../../server/protocols/hyperliquid-routes/connect.js";
import modify from "../../../server/protocols/hyperliquid-routes/modify.js";
import order from "../../../server/protocols/hyperliquid-routes/order.js";
import sync from "../../../server/protocols/hyperliquid-routes/sync.js";

const handlers = {
  cancel,
  "close-position": closePosition,
  connect,
  modify,
  order,
  sync
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "").replace(/\.js$/, "");
  const routeHandler = handlers[action];

  if (!routeHandler) {
    return res.status(404).json({ error: "Unknown Hyperliquid relay route." });
  }

  return routeHandler(req, res);
}
