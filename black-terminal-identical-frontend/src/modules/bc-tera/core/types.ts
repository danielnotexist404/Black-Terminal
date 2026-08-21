export const BC_TERA_MODEL_VERSION = "bc-tera-phase1-1.0.0" as const;
export const BC_TERA_FEATURE_SCHEMA_VERSION = "bc-tera-feature-v1" as const;

export type BCTERAState =
  | "INSUFFICIENT_DATA"
  | "NORMAL_EXPANSION"
  | "MATURE_EXPANSION"
  | "TOP_EXTREMITY"
  | "TOP_EXHAUSTION"
  | "TOP_REVERSAL_CONFIRMED"
  | "NORMAL_CONTRACTION"
  | "MATURE_CONTRACTION"
  | "BOTTOM_EXTREMITY"
  | "BOTTOM_CAPITULATION"
  | "BOTTOM_ABSORPTION"
  | "BOTTOM_REVERSAL_CONFIRMED"
  | "TRANSITION"
  | "DATA_DEGRADED";

export type BCTERADataProfile =
  | "BTC_FULL"
  | "ETH_FULL"
  | "TRANSPARENT_CHAIN"
  | "DERIVATIVES_AND_SPOT"
  | "SPOT_ONLY"
  | "LIMITED"
  | "UNAVAILABLE";

export type BCTERADataQuality =
  | "AUTHORITATIVE"
  | "VERIFIED_PARTIAL"
  | "STALE"
  | "DEGRADED"
  | "SYNTHETIC"
  | "UNAVAILABLE";

export type BCTERADecisionTimeframe = "4H" | "12H" | "1D" | "3D" | "1W";
export type BCTERAChangeDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type BCTERAChangePointMethod = "DIRECTIONAL_CUSUM" | "BAYESIAN_ONLINE";
export type BCTERAEvidenceFamily =
  | "MARKET"
  | "VALUATION"
  | "SPOT_FLOW"
  | "ORDER_BOOK"
  | "DERIVATIVES"
  | "LIQUIDATIONS"
  | "OPTIONS"
  | "STABLECOIN_LIQUIDITY";

export type BCTERAEventType =
  | "TOP_EXTREMITY"
  | "TOP_EXHAUSTION"
  | "TOP_REVERSAL_CONFIRMED"
  | "BOTTOM_EXTREMITY"
  | "BOTTOM_CAPITULATION"
  | "BOTTOM_ABSORPTION"
  | "BOTTOM_REVERSAL_CONFIRMED"
  | "DATA_DEGRADED";

export type BCTERASourceObservation = {
  source: string;
  venue: string;
  symbol: string;
  marketType: "SPOT" | "PERPETUAL" | "FUTURE" | "OPTION" | "ON_CHAIN" | "AGGREGATE";
  eventTimestamp: number;
  sourceCutoff: number;
  receivedTimestamp: number;
  sequence: string | null;
  revisionId: string;
  quality: BCTERADataQuality;
};

export type BCTERAEvidenceBlock<T extends Record<string, number | boolean | null>> = {
  values: T;
  quality: BCTERADataQuality;
  sources: BCTERASourceObservation[];
};

export type BCTERAFeatureBar = {
  schemaVersion: typeof BC_TERA_FEATURE_SCHEMA_VERSION;
  symbol: string;
  exchangeScope: string;
  profile: BCTERADataProfile;
  timeframe: BCTERADecisionTimeframe;
  time: number;
  confirmed: boolean;
  sourceCutoff: number;
  receivedTimestamp: number;
  revisionId: string;
  market: BCTERAEvidenceBlock<{
    close: number;
    logReturn: number;
    realizedVolatility: number;
    trend: number;
    distanceFromMean: number;
    structureBreakUp: boolean;
    structureBreakDown: boolean;
  }>;
  valuation: BCTERAEvidenceBlock<{
    topExtremity: number;
    bottomExtremity: number;
    costBasisTop: number;
    costBasisBottom: number;
    holderDistribution: number;
    realizedProfit: number;
    realizedLoss: number;
  }> | null;
  spotFlow: BCTERAEvidenceBlock<{
    aggressiveBuy: number;
    aggressiveSell: number;
    buyerImpactCollapse: number;
    sellerImpactCollapse: number;
    venueAgreement: number;
    tradeConfirmed: boolean;
  }> | null;
  orderBook: BCTERAEvidenceBlock<{
    offerReplenishment: number;
    bidReplenishment: number;
    venueAgreement: number;
    tradeConfirmed: boolean;
  }> | null;
  derivatives: BCTERAEvidenceBlock<{
    oiIntensity: number;
    oiChange: number;
    fundingCrowding: number;
    annualizedBasis: number;
    leverageReset: number;
  }> | null;
  liquidations: BCTERAEvidenceBlock<{
    longLiquidationShock: number;
    shortLiquidationShock: number;
  }> | null;
  options: BCTERAEvidenceBlock<{
    downsideSkew: number;
    upsideSkew: number;
    panicVolatility: number;
    normalization: number;
  }> | null;
  stablecoinLiquidity: BCTERAEvidenceBlock<{
    stress: number;
    impulse: number;
  }> | null;
  unavailable: BCTERAEvidenceFamily[];
};

export type BCTERAEvidenceLedger = {
  valuationExtremity: number | null;
  buyerExhaustion: number | null;
  sellerExhaustion: number | null;
  spotAbsorption: number | null;
  leverageFragility: number | null;
  leverageReset: number | null;
  distributionPressure: number | null;
  capitulationPressure: number | null;
  bullishChangePoint: number | null;
  bearishChangePoint: number | null;
  optionsConfirmation: number | null;
};

export type BCTERAPoint = {
  time: number;
  confirmed: boolean;
  state: BCTERAState;
  topHazard: number;
  bottomHazard: number;
  buyerExhaustion: number | null;
  sellerExhaustion: number | null;
  leverageFragility: number | null;
  valuationExtremity: number | null;
  spotAbsorption: number | null;
  distributionPressure: number | null;
  capitulationPressure: number | null;
  changePointProbability: number;
  changeDirection: BCTERAChangeDirection;
  changePointRunLength: number;
  dataConfidence: number;
  evidence: BCTERAEvidenceLedger;
  unavailable: BCTERAEvidenceFamily[];
  provisional: boolean;
  episodeId: string | null;
};

export type BCTERAEvent = {
  id: string;
  modelVersion: typeof BC_TERA_MODEL_VERSION;
  datasetProfile: BCTERADataProfile;
  exchangeScope: string;
  symbol: string;
  timeframe: BCTERADecisionTimeframe;
  eventType: BCTERAEventType;
  confirmedCandleTimestamp: number;
  terminalEpisodeId: string;
  state: BCTERAState;
  topHazard: number;
  bottomHazard: number;
  dataConfidence: number;
  evidence: BCTERAEvidenceLedger;
  unavailable: BCTERAEvidenceFamily[];
};

export type BCTERASourceStatus = {
  family: BCTERAEvidenceFamily;
  quality: BCTERADataQuality;
  sourceCount: number;
  latestSourceCutoff: number | null;
  explanation: string;
};

export type BCTERASnapshot = {
  modelVersion: typeof BC_TERA_MODEL_VERSION;
  featureSchemaVersion: typeof BC_TERA_FEATURE_SCHEMA_VERSION;
  automationState: "RESEARCH_ONLY";
  liveExecutionLocked: true;
  profile: BCTERADataProfile;
  symbol: string;
  exchangeScope: string;
  timeframe: BCTERADecisionTimeframe;
  generatedAt: number;
  revisionId: string;
  points: BCTERAPoint[];
  events: BCTERAEvent[];
  sourceStatus: BCTERASourceStatus[];
};

export type BCTERASettings = {
  version: 1;
  dataSources: {
    useOnChain: boolean;
    useSpotFlow: boolean;
    useOrderBook: boolean;
    useDerivatives: boolean;
    useLiquidations: boolean;
    useOptions: boolean;
    requireMultiVenue: boolean;
    minimumConfidence: number;
  };
  timeHorizon: {
    decisionTimeframe: BCTERADecisionTimeframe;
    confirmationTimeframe: BCTERADecisionTimeframe;
    hazardHorizon: number;
    featureLookback: number;
    regimeLookback: number;
  };
  extremity: {
    valuationWeight: number;
    costBasisWeight: number;
    holderDistributionWeight: number;
    robustZLookback: number;
    percentile: number;
  };
  leverage: {
    oiWeight: number;
    fundingWeight: number;
    basisWeight: number;
    liquidationWeight: number;
    fragilityThreshold: number;
  };
  exhaustion: {
    flowLookback: number;
    minimumAggressiveFlow: number;
    impactLookback: number;
    impactCollapseThreshold: number;
    absorptionPersistence: number;
    multiVenueAgreement: number;
  };
  changePoint: {
    method: BCTERAChangePointMethod;
    sensitivity: number;
    minimumRunLength: number;
    confirmationProbability: number;
    requireStructureBreak: boolean;
  };
  confirmation: {
    topHazardThreshold: number;
    bottomHazardThreshold: number;
    directionalEvidenceMargin: number;
    minimumStateDuration: number;
    confirmedCandlesOnly: true;
    oneSignalPerEpisode: true;
    cooldownBars: number;
  };
  display: {
    developingThreshold: number;
    elevatedThreshold: number;
    terminalThreshold: number;
    showConfidence: boolean;
    showLeverage: boolean;
    showChangePoint: boolean;
    showMarkers: boolean;
  };
  automationReadiness: {
    researchOnly: true;
    alertsCertified: false;
    shadowStrategyCertified: false;
    paperStrategyCertified: false;
    liveExecutionLocked: true;
  };
};
