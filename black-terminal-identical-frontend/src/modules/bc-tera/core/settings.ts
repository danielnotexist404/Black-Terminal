import type { BCTERASettings } from "./types.ts";

export const DEFAULT_BC_TERA_SETTINGS: BCTERASettings = {
  version: 1,
  dataSources: {
    useOnChain: true,
    useSpotFlow: true,
    useOrderBook: true,
    useDerivatives: true,
    useLiquidations: true,
    useOptions: true,
    requireMultiVenue: true,
    minimumConfidence: 62
  },
  timeHorizon: {
    decisionTimeframe: "1D",
    confirmationTimeframe: "1D",
    hazardHorizon: 10,
    featureLookback: 180,
    regimeLookback: 90
  },
  extremity: {
    valuationWeight: 1,
    costBasisWeight: 1,
    holderDistributionWeight: 0.8,
    robustZLookback: 180,
    percentile: 80
  },
  leverage: {
    oiWeight: 1,
    fundingWeight: 0.8,
    basisWeight: 0.8,
    liquidationWeight: 1,
    fragilityThreshold: 68
  },
  exhaustion: {
    flowLookback: 30,
    minimumAggressiveFlow: 55,
    impactLookback: 21,
    impactCollapseThreshold: 65,
    absorptionPersistence: 2,
    multiVenueAgreement: 60
  },
  changePoint: {
    method: "DIRECTIONAL_CUSUM",
    sensitivity: 1.35,
    minimumRunLength: 2,
    confirmationProbability: 70,
    requireStructureBreak: true
  },
  confirmation: {
    topHazardThreshold: 72,
    bottomHazardThreshold: 72,
    directionalEvidenceMargin: 10,
    minimumStateDuration: 2,
    confirmedCandlesOnly: true,
    oneSignalPerEpisode: true,
    cooldownBars: 8
  },
  display: {
    developingThreshold: 40,
    elevatedThreshold: 65,
    terminalThreshold: 80,
    showConfidence: true,
    showLeverage: true,
    showChangePoint: true,
    showMarkers: true
  },
  automationReadiness: {
    researchOnly: true,
    alertsCertified: false,
    shadowStrategyCertified: false,
    paperStrategyCertified: false,
    liveExecutionLocked: true
  }
};

const finite = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
};

const TIMEFRAMES = new Set(["4H", "12H", "1D", "3D", "1W"]);

export function migrateBCTERASettings(value?: Partial<BCTERASettings> | null): BCTERASettings {
  const source = value ?? {};
  const merged: BCTERASettings = {
    ...DEFAULT_BC_TERA_SETTINGS,
    ...source,
    dataSources: { ...DEFAULT_BC_TERA_SETTINGS.dataSources, ...(source.dataSources ?? {}) },
    timeHorizon: { ...DEFAULT_BC_TERA_SETTINGS.timeHorizon, ...(source.timeHorizon ?? {}) },
    extremity: { ...DEFAULT_BC_TERA_SETTINGS.extremity, ...(source.extremity ?? {}) },
    leverage: { ...DEFAULT_BC_TERA_SETTINGS.leverage, ...(source.leverage ?? {}) },
    exhaustion: { ...DEFAULT_BC_TERA_SETTINGS.exhaustion, ...(source.exhaustion ?? {}) },
    changePoint: { ...DEFAULT_BC_TERA_SETTINGS.changePoint, ...(source.changePoint ?? {}) },
    confirmation: {
      ...DEFAULT_BC_TERA_SETTINGS.confirmation,
      ...(source.confirmation ?? {}),
      confirmedCandlesOnly: true,
      oneSignalPerEpisode: true
    },
    display: { ...DEFAULT_BC_TERA_SETTINGS.display, ...(source.display ?? {}) },
    automationReadiness: DEFAULT_BC_TERA_SETTINGS.automationReadiness,
    version: 1
  };
  merged.dataSources.minimumConfidence = finite(merged.dataSources.minimumConfidence, 62, 0, 100);
  if (!TIMEFRAMES.has(merged.timeHorizon.decisionTimeframe)) merged.timeHorizon.decisionTimeframe = "1D";
  if (!TIMEFRAMES.has(merged.timeHorizon.confirmationTimeframe)) merged.timeHorizon.confirmationTimeframe = "1D";
  merged.timeHorizon.hazardHorizon = Math.round(finite(merged.timeHorizon.hazardHorizon, 10, 1, 100));
  merged.timeHorizon.featureLookback = Math.round(finite(merged.timeHorizon.featureLookback, 180, 30, 2000));
  merged.timeHorizon.regimeLookback = Math.round(finite(merged.timeHorizon.regimeLookback, 90, 10, 1000));
  merged.extremity.valuationWeight = finite(merged.extremity.valuationWeight, 1, 0, 3);
  merged.extremity.costBasisWeight = finite(merged.extremity.costBasisWeight, 1, 0, 3);
  merged.extremity.holderDistributionWeight = finite(merged.extremity.holderDistributionWeight, 0.8, 0, 3);
  merged.extremity.robustZLookback = Math.round(finite(merged.extremity.robustZLookback, 180, 20, 2000));
  merged.extremity.percentile = finite(merged.extremity.percentile, 80, 50, 99);
  merged.leverage.oiWeight = finite(merged.leverage.oiWeight, 1, 0, 3);
  merged.leverage.fundingWeight = finite(merged.leverage.fundingWeight, 0.8, 0, 3);
  merged.leverage.basisWeight = finite(merged.leverage.basisWeight, 0.8, 0, 3);
  merged.leverage.liquidationWeight = finite(merged.leverage.liquidationWeight, 1, 0, 3);
  merged.leverage.fragilityThreshold = finite(merged.leverage.fragilityThreshold, 68, 0, 100);
  merged.exhaustion.flowLookback = Math.round(finite(merged.exhaustion.flowLookback, 30, 5, 500));
  merged.exhaustion.minimumAggressiveFlow = finite(merged.exhaustion.minimumAggressiveFlow, 55, 0, 100);
  merged.exhaustion.impactLookback = Math.round(finite(merged.exhaustion.impactLookback, 21, 5, 500));
  merged.exhaustion.impactCollapseThreshold = finite(merged.exhaustion.impactCollapseThreshold, 65, 0, 100);
  merged.exhaustion.absorptionPersistence = Math.round(finite(merged.exhaustion.absorptionPersistence, 2, 1, 20));
  merged.exhaustion.multiVenueAgreement = finite(merged.exhaustion.multiVenueAgreement, 60, 0, 100);
  merged.changePoint.method = "DIRECTIONAL_CUSUM";
  merged.changePoint.sensitivity = finite(merged.changePoint.sensitivity, 1.35, 0.25, 8);
  merged.changePoint.minimumRunLength = Math.round(finite(merged.changePoint.minimumRunLength, 2, 1, 20));
  merged.changePoint.confirmationProbability = finite(merged.changePoint.confirmationProbability, 70, 1, 100);
  merged.confirmation.minimumStateDuration = Math.round(finite(merged.confirmation.minimumStateDuration, 2, 1, 20));
  merged.confirmation.cooldownBars = Math.round(finite(merged.confirmation.cooldownBars, 8, 0, 100));
  merged.confirmation.topHazardThreshold = finite(merged.confirmation.topHazardThreshold, 72, 1, 100);
  merged.confirmation.bottomHazardThreshold = finite(merged.confirmation.bottomHazardThreshold, 72, 1, 100);
  merged.confirmation.directionalEvidenceMargin = finite(merged.confirmation.directionalEvidenceMargin, 10, 0, 100);
  merged.display.developingThreshold = finite(merged.display.developingThreshold, 40, 0, 100);
  merged.display.elevatedThreshold = finite(merged.display.elevatedThreshold, 65, 0, 100);
  merged.display.terminalThreshold = finite(merged.display.terminalThreshold, 80, 0, 100);
  return merged;
}
