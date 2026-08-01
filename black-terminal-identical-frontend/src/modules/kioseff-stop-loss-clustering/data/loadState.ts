import type { KioseffUnavailableReason } from "./types.ts";

export type KioseffLoadState =
  | { stage: "idle" }
  | { stage: "requesting-symbol-metadata" }
  | { stage: "fetching-chart-history"; loaded: number; target: number }
  | { stage: "fetching-intrabar-history"; loaded: number; target?: number }
  | { stage: "grouping-intrabars"; bars: number; intrabars: number }
  | { stage: "starting-worker" }
  | { stage: "calculating"; bars: number; intrabars: number }
  | { stage: "rendering"; clusters: number }
  | { stage: "warming"; completedBars: number; targetBars: number }
  | { stage: "ready" }
  | { stage: "unavailable"; reason: KioseffUnavailableReason }
  | { stage: "error"; message: string };

export type KioseffRuntimeDiagnostics = {
  exchange: string;
  rawSymbol: string;
  normalizedSymbol: string;
  marketCategory: string;
  tickSize: string | null;
  chartTimeframe: string;
  requestedLowerTimeframe: string;
  chartHistoryCount: number;
  minuteHistoryCount: number;
  requestStart: number | null;
  requestEnd: number | null;
  firstMinute: number | null;
  lastMinute: number | null;
  groupedChartBarCount: number;
  completeCoverage: number;
  partialCoverage: number;
  missingCoverage: number;
  currentProvisionalIntrabars: number;
  sourceVersion: string | null;
  generation: number;
  workerStatus: string;
  chartBarsSent: number;
  intrabarsSent: number;
  groupOffsetsSent: number;
  workerChartBarsReceived: number;
  workerIntrabarsReceived: number;
  activeClusterCount: number;
  violatedClusterCount: number;
  panePointCount: number;
  renderActiveZones: number;
  renderViolatedZones: number;
  renderPanePoints: number;
  renderGeometryCommands: number;
  renderContainerVisible: boolean;
  outputDiagnostics: number;
  lastDiagnostic: string | null;
  loadStage: KioseffLoadState["stage"];
  calculationMilliseconds: number | null;
};

export function emptyKioseffRuntimeDiagnostics(): KioseffRuntimeDiagnostics {
  return {
    exchange: "",
    rawSymbol: "",
    normalizedSymbol: "",
    marketCategory: "",
    tickSize: null,
    chartTimeframe: "",
    requestedLowerTimeframe: "",
    chartHistoryCount: 0,
    minuteHistoryCount: 0,
    requestStart: null,
    requestEnd: null,
    firstMinute: null,
    lastMinute: null,
    groupedChartBarCount: 0,
    completeCoverage: 0,
    partialCoverage: 0,
    missingCoverage: 0,
    currentProvisionalIntrabars: 0,
    sourceVersion: null,
    generation: 0,
    workerStatus: "idle",
    chartBarsSent: 0,
    intrabarsSent: 0,
    groupOffsetsSent: 0,
    workerChartBarsReceived: 0,
    workerIntrabarsReceived: 0,
    activeClusterCount: 0,
    violatedClusterCount: 0,
    panePointCount: 0,
    renderActiveZones: 0,
    renderViolatedZones: 0,
    renderPanePoints: 0,
    renderGeometryCommands: 0,
    renderContainerVisible: false,
    outputDiagnostics: 0,
    lastDiagnostic: null,
    loadStage: "idle",
    calculationMilliseconds: null
  };
}
