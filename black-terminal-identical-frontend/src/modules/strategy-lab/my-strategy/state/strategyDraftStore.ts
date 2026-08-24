import type {
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyIndicatorBinding,
} from "../../automation/strategyAutomation.types";
import { definitionFingerprint } from "../../automation/strategyDefinitionModel";

export type StrategyWizardDraft = {
  strategyId?: string;
  name: string;
  description: string;
  tags: string[];
  definition: StrategyAutomationDefinition;
  paperPolicy: StrategyCapitalPolicy;
  draftRevision: number;
  draftBaseVersion?: number | null;
  publishedVersion?: number | null;
  runningVersion?: number | null;
  lastSavedAt?: string;
};

export const wizardSteps = [
  "Identity",
  "Indicator and Market",
  "Signal Mapping",
  "Execution Behavior",
  "Risk Management",
  "Filters and Schedule",
  "Take Profits and Exits",
  "Paper Account",
  "Execution Destination",
  "Activate Strategy & Save Configuration",
] as const;

export function createWizardDraft(definition: StrategyAutomationDefinition): StrategyWizardDraft {
  const blankDefinition: StrategyAutomationDefinition = {
    ...definition,
    runtimeKind: "external-signals",
    indicator: undefined,
    signals: {},
  };
  return {
    name: "",
    description: "",
    tags: [],
    definition: withWorkflowDefaults(blankDefinition),
    paperPolicy: defaultWizardPaperPolicy(definition.marketType),
    draftRevision: 0,
    publishedVersion: null,
    runningVersion: null,
  };
}

export function withWorkflowDefaults(definition: StrategyAutomationDefinition): StrategyAutomationDefinition {
  return {
    ...definition,
    signals: definition.signals || {},
    filters: {
      tradingDays: [1, 2, 3, 4, 5, 6, 0],
      timezone: "UTC",
      minimumBarsBetweenTrades: 1,
      cooldownAfterLoss: 0,
      ...definition.filters,
    },
    schedule: {
      startHour: 0,
      endHour: 24,
      ...definition.schedule,
    },
    exits: {
      takeProfits: [],
      trailingStop: false,
      breakEven: false,
      ...definition.exits,
    },
    paper: {
      demoEquity: 10_000,
      feesBps: 6,
      slippageBps: 5,
      modelFunding: definition.marketType === "FUTURES",
      ...definition.paper,
    },
    deployment: {
      targetType: "PAPER",
      authorizationAccepted: false,
      armOnActivation: false,
      ...definition.deployment,
    },
    metadata: {
      description: "",
      tags: [],
      templateId: "blank-indicator",
      ...definition.metadata,
    },
    execution: {
      ignoreDuplicateAlerts: true,
      sameDirectionPolicy: "IGNORE",
      signalTiming: "CONFIRMED_BAR",
      signalExpiryBars: 1,
      conflictResolution: "CLOSE_ONLY",
      maximumConsecutiveLosses: 3,
      maximumTotalExposurePercent: 100,
      stopReversalEnabled: false,
      maximumReversalChain: 1,
      maximumReversalsPerDay: 2,
      reversalCooldownBars: 0,
      perpetualSignalReversalEnabled: false,
      ...definition.execution,
    },
  };
}

export function defaultWizardPaperPolicy(marketType: StrategyAutomationDefinition["marketType"]): StrategyCapitalPolicy {
  return {
    strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
    strategyAllocationValue: 100,
    tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION",
    tradeAmountValue: 10,
    requestedLeverage: marketType === "FUTURES" ? 1 : undefined,
    maximumLeverage: marketType === "FUTURES" ? 3 : undefined,
    maximumPositionPercent: 25,
    maximumExposurePercent: 100,
    maximumDailyLoss: 500,
    maximumDrawdown: 20,
    maximumPositions: 1,
    slippageBps: 5,
    marginMode: marketType === "FUTURES" ? "CROSS" : undefined,
    quoteAssetReservePercent: marketType === "SPOT" ? 10 : undefined,
    maximumBaseAssetExposurePercent: marketType === "SPOT" ? 90 : undefined,
  };
}

export function bindIndicator(
  draft: StrategyWizardDraft,
  indicator: StrategyIndicatorBinding,
  runtimeKind: StrategyAutomationDefinition["runtimeKind"],
  settings?: Record<string, unknown>,
) {
  return {
    ...draft,
    definition: {
      ...draft.definition,
      runtimeKind,
      indicator,
      settings: settings ? { ...draft.definition.settings, ...settings } : draft.definition.settings,
      signals: {},
    },
  };
}

export function validateWizardStep(draft: StrategyWizardDraft, step: number): string[] {
  const issues: string[] = [];
  if (step === 0 || step === 9) {
    const name = draft.name.trim();
    if (name.length < 2) issues.push("Strategy name must contain at least 2 characters.");
    if (name.length > 80) issues.push("Strategy name cannot exceed 80 characters.");
  }
  if (step === 1 || step === 9) {
    if (!draft.definition.indicator) issues.push("Select an existing Black Terminal indicator or one of your saved scripts.");
    if (!draft.definition.symbol) issues.push("Select a signal-market instrument.");
    if (!draft.definition.timeframe) issues.push("Select a strategy timeframe.");
  }
  if (step === 2 || step === 9) {
    const signals = draft.definition.signals || {};
    if (draft.definition.marketType === "FUTURES") {
      if (!signals.longEntry) issues.push("Select a Long Trigger Entry alert.");
      if (!signals.shortEntry) issues.push("Select a Short Trigger Entry alert.");
    } else {
      if (!signals.buyEntry) issues.push("Select a Buy Trigger Entry alert.");
      if (!signals.sellExit) issues.push("Select a Sell Trigger Entry alert.");
    }
  }
  if (step === 4 || step === 9) {
    const execution = draft.definition.execution;
    const requested = numberValue(execution.requestedLeverage, draft.paperPolicy.requestedLeverage || 1);
    const maximum = numberValue(execution.maxLeverage, draft.paperPolicy.maximumLeverage || 1);
    if (draft.definition.marketType === "FUTURES" && requested > maximum) issues.push("Maximum leverage must be at least requested leverage.");
    if (numberValue(execution.maxDailyLoss, 0) <= 0) issues.push("Maximum daily loss must be greater than zero.");
    if (numberValue(execution.maxDrawdown, 0) <= 0) issues.push("Maximum strategy drawdown must be greater than zero.");
  }
  if (step === 6 || step === 9) {
    const targets = Array.isArray(draft.definition.exits?.takeProfits) ? draft.definition.exits?.takeProfits as Array<Record<string, unknown>> : [];
    const total = targets.reduce((sum, target) => sum + numberValue(target.closePercent, 0), 0);
    if (total > 100) issues.push(`Take-profit allocations total ${total.toFixed(0)}%. Reduce them to 100% or less.`);
    for (const [index, target] of targets.entries()) {
      const mode = String(target.mode || (target.alertId ? "ALERT" : "R_MULTIPLE"));
      if (mode === "ALERT" && !target.alertId) issues.push(`TP${index + 1} requires an indicator alert event.`);
      if (mode !== "ALERT" && numberValue(target.value, 0) <= 0) issues.push(`TP${index + 1} requires a positive trigger value.`);
      if (numberValue(target.closePercent, 0) <= 0) issues.push(`TP${index + 1} must close a positive percentage.`);
    }
  }
  if (step === 8 || step === 9) {
    const deployment = draft.definition.deployment;
    if (!deployment?.targetType) issues.push("Choose Paper, a broker account, or an Investment Group as the execution destination.");
    if (deployment?.targetType !== "PAPER" && !deployment?.targetId) issues.push("Select an eligible execution target.");
    if (deployment?.targetType !== "PAPER" && deployment?.authorizationAccepted !== true) issues.push("Explicitly approve the selected execution destination.");
  }
  if (step === 9 && draft.definition.indicator?.runtimeStatus !== "CERTIFIED") {
    issues.push("This indicator has no certified VPS runtime. Save the draft or choose a certified indicator before publishing.");
  }
  return [...new Set(issues)];
}

export function draftChanges(
  draft: StrategyWizardDraft,
  publishedName?: string,
  published?: StrategyAutomationDefinition | null,
) {
  if (!published) return [{ label: "Strategy", before: "Not published", after: "Draft version 1" }];
  const changes: Array<{ label: string; before: string; after: string }> = [];
  if (publishedName !== draft.name.trim()) changes.push({ label: "Name", before: publishedName || "—", after: draft.name.trim() });
  compare(changes, "Indicator", published.indicator?.name, draft.definition.indicator?.name);
  compare(changes, "Symbol", published.symbol, draft.definition.symbol);
  compare(changes, "Timeframe", published.timeframe, draft.definition.timeframe);
  compare(changes, "Market", published.marketType, draft.definition.marketType);
  compare(changes, "Signal mapping", JSON.stringify(published.signals || {}), JSON.stringify(draft.definition.signals || {}));
  compare(changes, "Execution and risk", definitionFingerprint({ ...published, indicator: undefined }), definitionFingerprint({ ...draft.definition, indicator: undefined }));
  return changes;
}

function compare(changes: Array<{ label: string; before: string; after: string }>, label: string, before: unknown, after: unknown) {
  if (String(before ?? "—") !== String(after ?? "—")) changes.push({ label, before: String(before ?? "—"), after: String(after ?? "—") });
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
