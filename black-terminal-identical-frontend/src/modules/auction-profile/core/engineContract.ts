import type {
  AuctionCalculationEngine,
  AuctionNodeSource,
  AuctionPocBasis,
  AuctionProfileSettings,
  AuctionProfileWidthMetric,
  AuctionValueAreaBasis
} from "./types.ts";

export interface AuctionEngineContract {
  engine: AuctionCalculationEngine;
  profileWidthMetric: AuctionProfileWidthMetric;
  valueAreaBasis: AuctionValueAreaBasis;
  pocBasis: AuctionPocBasis;
  nodeSource: AuctionNodeSource;
  presentation: "DIRECTIONAL_MATRIX" | "TPO_LETTERS" | "SCALAR_HISTOGRAM";
}

const CVD_ENGINES = new Set<AuctionCalculationEngine>(["CVD_REAL_TRADES", "CVD_PINE_COMPATIBLE", "DELTA_VOLUME", "IMBALANCE_RATIO"]);

export function auctionEngineContract(engine: AuctionCalculationEngine): AuctionEngineContract {
  if (engine === "TPO") {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "TPO", pocBasis: "MAXIMUM_TPO", nodeSource: "TPO", presentation: "TPO_LETTERS" };
  }
  if (engine === "VOLUME") {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "TOTAL_VOLUME", pocBasis: "MAXIMUM_TOTAL_VOLUME", nodeSource: "SELECTED_ENGINE", presentation: "SCALAR_HISTOGRAM" };
  }
  if (engine === "BUY_VOLUME") {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "BUY_VOLUME", pocBasis: "MAXIMUM_SELECTED_METRIC", nodeSource: "SELECTED_ENGINE", presentation: "SCALAR_HISTOGRAM" };
  }
  if (engine === "SELL_VOLUME") {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "SELL_VOLUME", pocBasis: "MAXIMUM_SELECTED_METRIC", nodeSource: "SELECTED_ENGINE", presentation: "SCALAR_HISTOGRAM" };
  }
  if (engine === "HYBRID_AUCTION_SCORE") {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "HYBRID", pocBasis: "HYBRID", nodeSource: "HYBRID", presentation: "SCALAR_HISTOGRAM" };
  }
  if (CVD_ENGINES.has(engine)) {
    return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "ABSOLUTE_VALUE", pocBasis: "MAXIMUM_ABSOLUTE_METRIC", nodeSource: "SELECTED_ENGINE", presentation: "DIRECTIONAL_MATRIX" };
  }
  return { engine, profileWidthMetric: "SELECTED_ENGINE", valueAreaBasis: "SELECTED_ENGINE", pocBasis: "MAXIMUM_SELECTED_METRIC", nodeSource: "SELECTED_ENGINE", presentation: "SCALAR_HISTOGRAM" };
}

/**
 * Engine selection is a semantic operation, not a label change. The selected
 * metric owns profile width, value area, POC and LVN/HVN detection. Users may
 * still override those controls after selecting the engine.
 */
export function configureAuctionProfileEngine(current: AuctionProfileSettings, engine: AuctionCalculationEngine): AuctionProfileSettings {
  const contract = auctionEngineContract(engine);
  const next = structuredClone(current);
  next.calculationEngine = engine;
  next.valueAreaBasis = contract.valueAreaBasis;
  next.pocBasis = contract.pocBasis;
  next.nodeDetection.source = contract.nodeSource;
  next.rendering.profileWidthMetric = contract.profileWidthMetric;
  next.rendering.showText = true;

  if (contract.presentation === "TPO_LETTERS") {
    next.rendering.displayStyle = "LETTERS_TPO";
    next.rendering.profileBodyStyle = "SOLID_HISTOGRAM";
    next.rendering.timeSegmentsMode = "OFF";
    next.rendering.rowLabelMode = "ALWAYS";
    next.rendering.profileGeometry = next.rendering.profileSide === "LEFT" ? "SINGLE_SIDED_RIGHT" : "SINGLE_SIDED_LEFT";
    next.rendering.profilePlacement = next.rendering.profileSide === "LEFT" ? "RANGE_START" : "RANGE_END";
  } else if (contract.presentation === "DIRECTIONAL_MATRIX") {
    next.rendering.displayStyle = "COMBINED";
    next.rendering.profileBodyStyle = "HDLX_CVD_BLOCKS";
    next.rendering.timeSegmentsMode = "STACKED";
    next.rendering.rowLabelMode = "OFF";
  } else {
    next.rendering.displayStyle = "HORIZONTAL_HISTOGRAM";
    next.rendering.profileBodyStyle = "SOLID_HISTOGRAM";
    next.rendering.timeSegmentsMode = "OFF";
    next.rendering.rowLabelMode = "AUTO";
    next.rendering.profileGeometry = next.rendering.profileSide === "LEFT" ? "SINGLE_SIDED_RIGHT" : "SINGLE_SIDED_LEFT";
    next.rendering.profilePlacement = next.rendering.profileSide === "LEFT" ? "RANGE_START" : "RANGE_END";
  }
  return next;
}
