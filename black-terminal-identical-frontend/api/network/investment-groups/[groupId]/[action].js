import joinRequest from "../../../../server/network/routes/investment-group-join-request.js";
import messages from "../../../../server/network/routes/investment-group-messages.js";
import reviewRequest from "../../../../server/network/routes/investment-group-review-request.js";

const handlers = {
  "join-request": joinRequest,
  messages,
  "review-request": reviewRequest
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "").replace(/\.js$/, "");
  const routeHandler = handlers[action];

  if (!routeHandler) {
    return res.status(404).json({ error: "Unknown investment group route." });
  }

  return routeHandler(req, res);
}
