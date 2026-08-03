import type { AuctionVisualizationType } from "../core/types.ts";

export function resolveAuctionVisualizationLayers(
  indicatorVisible: boolean,
  footprintChartType: boolean,
  visualizationType: AuctionVisualizationType
) {
  return {
    dataRequired: indicatorVisible || footprintChartType,
    profile: indicatorVisible && visualizationType !== "CVD_FOOTPRINT",
    footprint: footprintChartType || (indicatorVisible && visualizationType !== "AUCTION_PROFILE")
  };
}
