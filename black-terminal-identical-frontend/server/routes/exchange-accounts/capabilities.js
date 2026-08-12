import { applyCors, requireMethod, requireUser, sendError } from "../../portfolio-api.js";
import { listBrokerAdapterDefinitions } from "../../exchanges/broker-adapter-registry.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    requireMethod(req, "GET");
    await requireUser(req);
    return res.status(200).json({ adapters: listBrokerAdapterDefinitions() });
  } catch (error) {
    return sendError(res, error);
  }
}
