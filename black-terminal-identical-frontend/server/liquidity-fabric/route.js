import { requireMethod } from "../portfolio-api.js";
import { directLiquidityFabricRuntime } from "./direct-runtime.js";

export default async function consolidatedLiquidityRoute(req, res) {
  requireMethod(req, "GET");
  const result = await directLiquidityFabricRuntime.viewport({
    baseAsset: req.query?.baseAsset,
    minimumPrice: req.query?.minimumPrice,
    maximumPrice: req.query?.maximumPrice,
    rowCount: req.query?.rowCount,
    priceStep: req.query?.priceStep
  });
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Black-Core-Data-Source", "consolidated-liquidity-fabric");
  return res.status(200).json(result);
}
