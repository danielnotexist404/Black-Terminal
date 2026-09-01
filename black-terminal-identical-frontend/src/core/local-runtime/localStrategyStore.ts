import type {
  EligibleBrokerTarget,
  EligibleGroupTarget,
  StrategyAutomationDefinition,
  StrategyCapitalPolicy,
  StrategyGroupExecutionDesk,
  StrategyPaperAccount,
  StrategySummary,
  StrategyTargetBinding,
  StrategyTargetSnapshot,
  StrategyTargetType,
  StrategyWorkspace,
} from "../../modules/strategy-lab/automation/strategyAutomation.types";
import type { BlackScriptCloudEvaluation } from "../../modules/strategy-lab/adapters/blackScriptCloudRuntime";
import { defaultWizardPaperPolicy } from "../../modules/strategy-lab/my-strategy/state/strategyDraftStore";
import {
  getLocalBrokerRecord,
  getLocalBrokerSymbolExposure,
  getLocalBrokerPortfolioSnapshot,
  listLocalBrokerAccounts,
  refreshLocalBrokerAccount,
} from "./localBrokerStore";
import { deleteLocalDocument, getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { getLocalBybitInstrumentRules } from "./localBybitClient";
import {
  activeLocalInvestmentGroupMandates,
  eligibleLocalInvestmentGroupTargets,
  listLocalInvestmentGroupMandates,
  validateLocalInvestmentGroupPolicy,
} from "./localInvestmentGroupMandateStore";
import {
  activeRemoteInvestmentGroupMandates,
  listRemoteInvestmentGroupExecutionReceipts,
  listRemoteInvestmentGroupMandates,
} from "./localInvestmentGroupRemoteStore";

const STRATEGY_NAMESPACE = "strategies";
const STRATEGY_STATUS_NAMESPACE = "strategy-runtime-status";
const STRATEGY_PAPER_LEDGER_NAMESPACE = "strategy-paper-ledgers";

type LocalStrategyPaperLedger = {
  schemaVersion: 1;
  strategyId: string;
  strategyVersion: number;
  initialCapital: number;
  checkpoint: BlackScriptCloudEvaluation["checkpoint"];
  lastClosedCandleTime: number;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  analytics: Record<string, unknown>;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function strategyId() {
  return `local-strategy-${crypto.randomUUID()}`;
}

function bindingId() {
  return `local-target-${crypto.randomUUID()}`;
}

function embeddedCapitalPolicy(definition: StrategyAutomationDefinition): StrategyCapitalPolicy {
  const candidate = definition.paper?.capitalPolicy;
  return candidate && typeof candidate === "object" && "strategyAllocationMode" in candidate
    ? copy(candidate as StrategyCapitalPolicy)
    : defaultWizardPaperPolicy(definition.marketType);
}

function summary(workspace: StrategyWorkspace): StrategySummary {
  const paper = workspace.paper;
  return {
    ...workspace.strategy,
    definition: undefined,
    draftDefinition: undefined,
    draftName: undefined,
    draftBaseVersion: undefined,
    globalCapitalPolicy: undefined,
    indicatorName: workspace.strategy.definition.indicator?.name,
    paperEquity: paper?.demoEquity,
    paperPnl: paper ? paper.realizedPnl + paper.unrealizedPnl - paper.fees - paper.funding : undefined,
    paperDrawdown: paper?.maximumDrawdownPercent,
    paperTrades: 0,
    connectedTargets: workspace.bindings.filter((binding) => !["DISCONNECTED", "DISCONNECTING"].includes(binding.status)).length,
    runtimeState: workspace.runtime?.state,
    lastSignalAt: workspace.runtime?.lastSignalAt,
    lastHeartbeatAt: workspace.runtime?.lastHeartbeatAt,
  } as StrategySummary;
}

async function readWorkspace(id: string) {
  const document = await getLocalDocument<StrategyWorkspace>(STRATEGY_NAMESPACE, id);
  if (!document) throw new Error("The local strategy does not exist.");
  return copy(document.value);
}

async function writeWorkspace(workspace: StrategyWorkspace) {
  workspace.strategy.updatedAt = nowIso();
  const saved = await putLocalDocument(STRATEGY_NAMESPACE, workspace.strategy.id, workspace);
  if (!saved) throw new Error("The encrypted local strategy store is unavailable.");
  return copy(saved.value);
}

function audit(workspace: StrategyWorkspace, event: string, message: string, bindingIdValue?: string) {
  const last = workspace.audit.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0);
  workspace.audit.unshift({
    id: last + 1,
    event_type: event,
    severity: "INFO",
    message,
    safe_metadata: {},
    created_at: nowIso(),
    ...(bindingIdValue ? { binding_id: bindingIdValue } : {}),
  });
  workspace.audit = workspace.audit.slice(0, 500);
}

function paperAccount(strategyIdValue: string, version: number, definition: StrategyAutomationDefinition, policy: StrategyCapitalPolicy, equityOverride?: number): StrategyPaperAccount {
  const equity = Math.max(0, Number(equityOverride ?? definition.paper?.demoEquity ?? 10_000));
  const allocation = policy.strategyAllocationMode === "FIXED_USDT"
    ? Math.min(equity, Math.max(0, policy.strategyAllocationValue))
    : equity * Math.max(0, policy.strategyAllocationValue) / 100;
  const entryCapital = policy.tradeAmountMode === "FIXED_USDT"
    ? Math.min(allocation, Math.max(0, policy.tradeAmountValue))
    : allocation * Math.max(0, policy.tradeAmountValue) / 100;
  const leverage = Math.max(1, Number(policy.requestedLeverage || 1));
  return {
    id: `local-paper-${strategyIdValue}`,
    strategyId: strategyIdValue,
    strategyVersion: version,
    marketType: definition.marketType,
    status: "ACTIVE",
    demoEquity: equity,
    availableBalance: equity,
    usedStrategyCapital: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    fees: 0,
    funding: 0,
    capitalPolicyVersion: 1,
    rowVersion: 1,
    capitalPolicy: copy(policy),
    maximumDrawdownPercent: 0,
    preview: {
      allocatedStrategyCapital: allocation,
      entryCapital,
      requestedLeverage: leverage,
      effectiveLeverage: leverage,
      estimatedNotional: entryCapital * leverage,
      estimatedMargin: entryCapital,
      remainingReserve: Math.max(0, allocation - entryCapital),
    },
    updatedAt: nowIso(),
  };
}

function createWorkspace(name: string, definition: StrategyAutomationDefinition): StrategyWorkspace {
  const timestamp = nowIso();
  const id = strategyId();
  const policy = embeddedCapitalPolicy(definition);
  return {
    strategy: {
      id,
      name: name.trim(),
      runtimeKind: definition.runtimeKind,
      symbol: definition.symbol,
      timeframe: definition.timeframe,
      marketType: definition.marketType,
      exchange: definition.exchange,
      currentVersion: 0,
      publishedVersion: null,
      runningVersion: null,
      draftRevision: 1,
      draftUpdatedAt: timestamp,
      hasDraftChanges: true,
      status: "DRAFT",
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: copy(definition),
      draftDefinition: copy(definition),
      draftName: name.trim(),
      draftBaseVersion: null,
      globalCapitalPolicy: policy,
    },
    versions: [],
    paper: null,
    bindings: [],
    snapshots: [],
    runtime: { state: "STOPPED" },
    audit: [],
  };
}

export async function listLocalStrategies() {
  const documents = await listLocalDocuments<StrategyWorkspace>(STRATEGY_NAMESPACE);
  return Promise.all(documents.map(async (document) => {
    const ledger = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, document.value.strategy.id);
    const item = summary(document.value);
    item.paperTrades = ledger && ledger.value.strategyVersion === document.value.paper?.strategyVersion ? ledger.value.trades.length : 0;
    return item;
  })).then((items) => items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
}

export async function getLocalStrategy(id: string) {
  const workspace = await readWorkspace(id);
  const paperLedger = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  if (workspace.paper && paperLedger?.value.strategyVersion === workspace.paper.strategyVersion) {
    reconcilePaperAccount(workspace.paper, paperLedger.value);
  }
  const status = await getLocalDocument<NonNullable<StrategyWorkspace["runtime"]>>(STRATEGY_STATUS_NAMESPACE, id);
  if (status) workspace.runtime = status.value;
  return refreshWorkspaceSnapshots(workspace, false);
}

export async function setLocalStrategyRuntimeStatus(id: string, runtime: NonNullable<StrategyWorkspace["runtime"]>) {
  const saved = await putLocalDocument(STRATEGY_STATUS_NAMESPACE, id, runtime);
  if (!saved) throw new Error("The local strategy runtime status store is unavailable.");
  return saved.value;
}

export async function createLocalStrategyDraft(name: string, definition: StrategyAutomationDefinition) {
  const workspace = createWorkspace(name, definition);
  audit(workspace, "LOCAL_STRATEGY_DRAFT_CREATED", "Strategy draft created in the encrypted local store.");
  return writeWorkspace(workspace);
}

export async function saveLocalStrategyDraft(id: string, name: string, definition: StrategyAutomationDefinition, expectedRevision?: number) {
  const workspace = await readWorkspace(id);
  if (expectedRevision !== undefined && Number(workspace.strategy.draftRevision || 0) !== expectedRevision) {
    throw Object.assign(new Error("The local strategy draft changed in another operation. Reload it and try again."), { code: "STRATEGY_DRAFT_REVISION_CONFLICT" });
  }
  workspace.strategy.draftName = name.trim();
  workspace.strategy.draftDefinition = copy(definition);
  workspace.strategy.draftRevision = Number(workspace.strategy.draftRevision || 0) + 1;
  workspace.strategy.draftUpdatedAt = nowIso();
  workspace.strategy.hasDraftChanges = true;
  workspace.strategy.runtimeKind = definition.runtimeKind;
  workspace.strategy.symbol = definition.symbol;
  workspace.strategy.timeframe = definition.timeframe;
  workspace.strategy.marketType = definition.marketType;
  workspace.strategy.exchange = definition.exchange;
  audit(workspace, "LOCAL_STRATEGY_DRAFT_SAVED", "Strategy settings were durably saved on this device.");
  return writeWorkspace(workspace);
}

export async function publishLocalStrategy(id: string, expectedRevision: number) {
  const workspace = await readWorkspace(id);
  if (Number(workspace.strategy.draftRevision || 0) !== expectedRevision) {
    throw Object.assign(new Error("The local strategy draft revision is stale."), { code: "STRATEGY_DRAFT_REVISION_CONFLICT" });
  }
  const definition = copy(workspace.strategy.draftDefinition || workspace.strategy.definition);
  const version = Math.max(0, ...((workspace.versions || []).map((item) => item.version))) + 1;
  workspace.strategy.name = workspace.strategy.draftName || workspace.strategy.name;
  workspace.strategy.definition = definition;
  workspace.strategy.currentVersion = version;
  workspace.strategy.publishedVersion = version;
  workspace.strategy.draftBaseVersion = version;
  workspace.strategy.hasDraftChanges = false;
  workspace.strategy.status = workspace.strategy.runningVersion ? "PAPER_ACTIVE" : "PUBLISHED";
  workspace.versions = [...(workspace.versions || []), { version, name: workspace.strategy.name, definition, status: "PUBLISHED", createdAt: nowIso() }];
  audit(workspace, "LOCAL_STRATEGY_VERSION_PUBLISHED", `Immutable local strategy V${version} published.`);
  return writeWorkspace(workspace);
}

export async function startLocalStrategyVersion(id: string, version: number) {
  const workspace = await readWorkspace(id);
  const published = workspace.versions?.find((item) => item.version === version);
  if (!published) throw new Error("The requested local strategy version is not published.");
  workspace.strategy.definition = copy(published.definition);
  workspace.strategy.runningVersion = version;
  workspace.strategy.currentVersion = version;
  workspace.strategy.status = "PAPER_ACTIVE";
  workspace.runtime = { state: "RUNNING", lastHeartbeatAt: nowIso() };
  await setLocalStrategyRuntimeStatus(id, workspace.runtime);
  const paperVersionChanged = Boolean(workspace.paper && workspace.paper.strategyVersion !== version);
  workspace.paper = workspace.paper || paperAccount(id, version, published.definition, workspace.strategy.globalCapitalPolicy);
  workspace.paper.status = "ACTIVE";
  workspace.paper.strategyVersion = version;
  workspace.paper.rowVersion += 1;
  workspace.paper.updatedAt = nowIso();
  if (paperVersionChanged) await deleteLocalDocument(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  audit(workspace, "LOCAL_STRATEGY_VERSION_STARTED", `Local strategy V${version} started. Live targets remain separately controlled.`);
  return writeWorkspace(workspace);
}

export async function updateLocalGlobalPolicy(id: string, expectedRevision: number, policy: StrategyCapitalPolicy) {
  const workspace = await readWorkspace(id);
  if (Number(workspace.strategy.draftRevision || 0) !== expectedRevision) throw new Error("The local strategy settings revision is stale.");
  workspace.strategy.globalCapitalPolicy = copy(policy);
  if (workspace.paper) {
    workspace.paper.capitalPolicy = copy(policy);
    workspace.paper.capitalPolicyVersion += 1;
    workspace.paper.rowVersion += 1;
    workspace.paper.updatedAt = nowIso();
  }
  audit(workspace, "LOCAL_STRATEGY_POLICY_UPDATED", "Strategy allocation, sizing, and leverage policy saved locally.");
  return writeWorkspace(workspace);
}

export async function removeLocalStrategy(input: Pick<StrategySummary, "id" | "name" | "draftRevision">) {
  const workspace = await readWorkspace(input.id);
  if (workspace.strategy.name !== input.name || Number(workspace.strategy.draftRevision || 0) !== Number(input.draftRevision || 0)) {
    throw Object.assign(new Error("The local strategy changed before deletion. Reload it and confirm again."), { code: "STRATEGY_DELETE_REVISION_CONFLICT" });
  }
  if (workspace.bindings.some((binding) => binding.status !== "DISCONNECTED")) {
    throw Object.assign(new Error("Pause and disconnect local execution targets before deleting this strategy."), { code: "STRATEGY_DELETE_REQUIRES_SAFE_STATE" });
  }
  await deleteLocalDocument(STRATEGY_NAMESPACE, input.id);
  await deleteLocalDocument(STRATEGY_STATUS_NAMESPACE, input.id);
  await deleteLocalDocument(STRATEGY_PAPER_LEDGER_NAMESPACE, input.id);
  return { strategyId: input.id, archivedAt: nowIso(), idempotent: false };
}

function eligibleFromAccount(account: ReturnType<typeof listLocalBrokerAccounts>[number], maximumLeverage: number): EligibleBrokerTarget {
  const record = getLocalBrokerRecord(account.id);
  const reasons: string[] = [];
  if (!record?.lastSnapshot) reasons.push("Account has no authenticated snapshot.");
  if (!record?.lastSnapshot?.tradingEnabled) reasons.push("API key does not have derivatives trading permission.");
  if (record?.lastSnapshot?.withdrawalEnabled) reasons.push("Withdrawal permission must be disabled on a trading key.");
  if (record?.environment === "MAINNET" && !record.mainnetConfirmed) reasons.push("Real-funds Mainnet authority must be explicitly confirmed.");
  if (account.status === "degraded") reasons.push(record?.lastError || "Broker synchronization is degraded.");
  return {
    targetId: account.id,
    accountId: account.id,
    targetType: "BROKER_ACCOUNT",
    provider: "BYBIT",
    label: account.accountName,
    environment: record?.environment === "MAINNET" ? "MAINNET_LIVE" : record?.environment || "DEMO",
    marketCapabilities: ["FUTURES"],
    equity: account.equityUsd,
    availableBalance: account.availableMargin,
    connectionHealth: account.status === "connected" ? "CONNECTED_LOCAL" : account.status.toUpperCase(),
    privateStreamHealth: "REST_RECONCILED",
    reconciliationStatus: record?.lastSnapshot ? "SYNCHRONIZED" : "PENDING",
    maximumLeverage,
    validation: { eligible: reasons.length === 0, reasons },
  };
}

export async function eligibleLocalStrategyTargets(strategyId?: string) {
  const accounts = listLocalBrokerAccounts("STRATEGY_LAB");
  await Promise.allSettled(accounts.map((account) => refreshLocalBrokerAccount(account.id)));
  const symbol = strategyId ? (await readWorkspace(strategyId)).strategy.symbol : "BTCUSDT";
  const brokerAccounts = await Promise.all(listLocalBrokerAccounts("STRATEGY_LAB").map(async (account) => {
    const record = getLocalBrokerRecord(account.id);
    if (!record) return eligibleFromAccount(account, 1);
    try {
      const rules = await getLocalBybitInstrumentRules(record.environment, symbol);
      return eligibleFromAccount(account, Number(rules.maxLeverage) || 1);
    } catch {
      return eligibleFromAccount(account, 1);
    }
  }));
  const policy = strategyId ? (await readWorkspace(strategyId)).strategy.globalCapitalPolicy : undefined;
  const groups = await eligibleLocalInvestmentGroupTargets(symbol, policy);
  return { brokerAccounts, groups };
}

export async function addLocalStrategyTarget(id: string, slotIndex: number, targetType: StrategyTargetType, targetIdValue: string, marketType: "SPOT" | "FUTURES", policy?: StrategyCapitalPolicy) {
  if (marketType !== "FUTURES") throw new Error("The standalone Bybit executor currently certifies linear futures only. Spot targets remain locked until the spot order and balance adapters are complete.");
  const workspace = await readWorkspace(id);
  if (workspace.bindings.some((binding) => binding.slotIndex === slotIndex && binding.status !== "DISCONNECTED")) throw new Error("This local execution slot is already occupied.");
  if (workspace.bindings.filter((binding) => binding.status !== "DISCONNECTED").length >= 9) throw new Error("A local strategy supports at most nine active execution targets.");
  const eligibleTargets = await eligibleLocalStrategyTargets(id);
  if (targetType === "INVESTMENT_GROUP") {
    const target = eligibleTargets.groups.find((item) => item.targetId === targetIdValue);
    if (!target?.validation.eligible) throw new Error(target?.validation.reasons.join(" ") || "The local Investment Group is not eligible.");
    const capitalPolicy = copy(policy || workspace.strategy.globalCapitalPolicy);
    const activeMandates = await activeLocalInvestmentGroupMandates(targetIdValue, workspace.strategy.symbol, capitalPolicy);
    const remoteMandates = await activeRemoteInvestmentGroupMandates(targetIdValue, workspace.strategy.symbol, capitalPolicy);
    const rejected = [...activeMandates, ...remoteMandates].filter((item) => item.reasons.length > 0);
    if ((!activeMandates.length && !remoteMandates.length) || rejected.length) {
      throw new Error(rejected.flatMap((item) => item.reasons).join(" ") || "No active member execution mandate is ready for this strategy.");
    }
    const timestamp = nowIso();
    const binding: StrategyTargetBinding = {
      id: bindingId(),
      strategyId: id,
      strategyVersion: workspace.strategy.runningVersion || workspace.strategy.publishedVersion || 0,
      slotIndex,
      targetType,
      targetId: targetIdValue,
      targetLabel: target.label,
      targetProvider: "LOCAL_ENCRYPTED_GROUP",
      executionEnvironment: "INVESTMENT_GROUP",
      groupId: targetIdValue,
      marketType,
      status: "READY",
      capitalPolicyVersion: 1,
      capitalPolicy,
      validation: { eligible: true, reasons: [], checkedAt: timestamp, maximumLeverage: Math.min(...[...activeMandates, ...remoteMandates].map((item) => item.mandate.maxLeverage)) },
      rowVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    workspace.bindings.push(binding);
    audit(workspace, "LOCAL_STRATEGY_GROUP_TARGET_ADDED", `Investment Group ${target.label} linked with ${activeMandates.length} local and ${remoteMandates.length} authenticated P2P member mandate(s), but not armed.`, binding.id);
    await writeWorkspace(workspace);
    return { binding };
  }
  const target = eligibleTargets.brokerAccounts.find((item) => item.targetId === targetIdValue);
  if (!target?.validation.eligible) throw new Error(target?.validation.reasons.join(" ") || "The local broker target is not eligible.");
  const brokerRecord = getLocalBrokerRecord(targetIdValue);
  if (!brokerRecord) throw new Error("The local broker target is unavailable.");
  const instrument = await getLocalBybitInstrumentRules(brokerRecord.environment, workspace.strategy.symbol);
  const maximumLeverage = Number(instrument.maxLeverage);
  if (!(maximumLeverage >= 1)) throw new Error("Bybit returned an invalid maximum leverage for this symbol.");
  const timestamp = nowIso();
  const requestedPolicy = copy(policy || workspace.strategy.globalCapitalPolicy);
  const requestedLeveragedValues = [
    requestedPolicy.requestedLeverage || 1,
    requestedPolicy.requestedLongLeverage || requestedPolicy.requestedLeverage || 1,
    requestedPolicy.requestedShortLeverage || requestedPolicy.requestedLeverage || 1,
  ];
  if (requestedLeveragedValues.some((value) => value > maximumLeverage)) {
    throw new Error(`Requested leverage exceeds Bybit's ${maximumLeverage}x limit for ${workspace.strategy.symbol}. Change the strategy setting explicitly before linking this target.`);
  }
  const capitalPolicy = {
    ...requestedPolicy,
    requestedLeverage: requestedPolicy.requestedLeverage || 1,
    requestedLongLeverage: requestedPolicy.requestedLongLeverage || requestedPolicy.requestedLeverage || 1,
    requestedShortLeverage: requestedPolicy.requestedShortLeverage || requestedPolicy.requestedLeverage || 1,
    maximumLeverage,
  };
  const binding: StrategyTargetBinding = {
    id: bindingId(),
    strategyId: id,
    strategyVersion: workspace.strategy.runningVersion || workspace.strategy.publishedVersion || 0,
    slotIndex,
    targetType,
    targetId: targetIdValue,
    targetLabel: target.label,
    targetProvider: target.provider,
    executionEnvironment: target.environment === "MAINNET_LIVE" ? "MAINNET_LIVE" : target.environment === "TESTNET" ? "TESTNET" : "DEMO",
    connectionId: targetIdValue,
    accountId: target.accountId,
    marketType,
    status: "READY",
    capitalPolicyVersion: 1,
    capitalPolicy,
    validation: { eligible: true, reasons: [], checkedAt: timestamp, maximumLeverage },
    rowVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  workspace.bindings.push(binding);
  audit(workspace, "LOCAL_STRATEGY_TARGET_ADDED", `Local broker target ${target.label} added but not armed.`, binding.id);
  await writeWorkspace(workspace);
  return { binding };
}

function requireBinding(workspace: StrategyWorkspace, id: string, expectedVersion: number) {
  const binding = workspace.bindings.find((item) => item.id === id);
  if (!binding) throw new Error("The local strategy target does not exist.");
  if (binding.rowVersion !== expectedVersion) throw Object.assign(new Error("The local target changed. Reload it and try again."), { code: "STRATEGY_TARGET_VERSION_CONFLICT" });
  return binding;
}

export async function updateLocalStrategyTarget(strategyIdValue: string, source: StrategyTargetBinding, policy: StrategyCapitalPolicy) {
  const workspace = await readWorkspace(strategyIdValue);
  const binding = requireBinding(workspace, source.id, source.rowVersion);
  if (binding.targetType === "INVESTMENT_GROUP") {
    const mandates = await activeLocalInvestmentGroupMandates(binding.groupId || binding.targetId, workspace.strategy.symbol, policy);
    const remoteMandates = await activeRemoteInvestmentGroupMandates(binding.groupId || binding.targetId, workspace.strategy.symbol, policy);
    if (!mandates.length && !remoteMandates.length) throw new Error("This Investment Group has no active member execution mandates.");
    const reasons = [...mandates, ...remoteMandates].flatMap((item) => item.reasons);
    if (reasons.length) throw new Error([...new Set(reasons)].join(" "));
    binding.capitalPolicy = copy(policy);
    binding.validation.maximumLeverage = Math.min(...[...mandates, ...remoteMandates].map((item) => item.mandate.maxLeverage));
    binding.capitalPolicyVersion += 1;
    binding.rowVersion += 1;
    binding.updatedAt = nowIso();
    audit(workspace, "LOCAL_GROUP_TARGET_POLICY_UPDATED", "Group target sizing and leverage policy validated against every active member mandate and saved locally.", binding.id);
    await writeWorkspace(workspace);
    return { binding: copy(binding) };
  }
  const record = binding.accountId ? getLocalBrokerRecord(binding.accountId) : null;
  const rules = record ? await getLocalBybitInstrumentRules(record.environment, workspace.strategy.symbol) : null;
  const maximumLeverage = Number(rules?.maxLeverage || binding.validation.maximumLeverage || 0) || undefined;
  if (maximumLeverage && Math.max(policy.requestedLeverage || 1, policy.requestedLongLeverage || 1, policy.requestedShortLeverage || 1) > maximumLeverage) {
    throw new Error(`Bybit currently permits at most ${maximumLeverage}x leverage for ${workspace.strategy.symbol}.`);
  }
  binding.capitalPolicy = copy(policy);
  binding.validation.maximumLeverage = maximumLeverage;
  binding.capitalPolicyVersion += 1;
  binding.rowVersion += 1;
  binding.updatedAt = nowIso();
  audit(workspace, "LOCAL_TARGET_POLICY_UPDATED", "Target sizing and leverage policy saved locally.", binding.id);
  await writeWorkspace(workspace);
  return { binding: copy(binding) };
}

export async function localStrategyTargetAction(strategyIdValue: string, source: StrategyTargetBinding, action: "arm" | "pause" | "resume") {
  const workspace = await readWorkspace(strategyIdValue);
  const binding = requireBinding(workspace, source.id, source.rowVersion);
  if (action !== "pause") {
    if (!workspace.strategy.runningVersion) throw new Error("Publish and start a local strategy version before arming a broker.");
    if (binding.targetType === "INVESTMENT_GROUP") {
      const mandates = await activeLocalInvestmentGroupMandates(binding.groupId || binding.targetId, workspace.strategy.symbol, binding.capitalPolicy);
      const remoteMandates = await activeRemoteInvestmentGroupMandates(binding.groupId || binding.targetId, workspace.strategy.symbol, binding.capitalPolicy);
      if (!mandates.length && !remoteMandates.length) throw new Error("This Investment Group has no active member execution mandates.");
      const reasons = [...mandates, ...remoteMandates].flatMap((item) => item.reasons);
      if (reasons.length) throw new Error([...new Set(reasons)].join(" "));
      binding.validation.maximumLeverage = Math.min(...[...mandates, ...remoteMandates].map((item) => item.mandate.maxLeverage));
    } else {
      const target = (await eligibleLocalStrategyTargets(strategyIdValue)).brokerAccounts.find((item) => item.accountId === binding.accountId);
      if (!target?.validation.eligible) throw new Error(target?.validation.reasons.join(" ") || "The local broker target is not ready.");
      const record = binding.accountId ? getLocalBrokerRecord(binding.accountId) : null;
      if (!record) throw new Error("The local broker target is unavailable.");
      await refreshLocalBrokerAccount(record.account.id, true);
      const exposure = getLocalBrokerSymbolExposure(record.account.id, workspace.strategy.symbol);
      if (action === "arm" && (exposure.positions || exposure.openOrders)) {
        throw new Error(`Cannot arm this target while ${workspace.strategy.symbol} has ${exposure.positions} open position(s) or ${exposure.openOrders} open order(s). Close or cancel them first so Strategy Lab never inherits manual exposure.`);
      }
      const rules = await getLocalBybitInstrumentRules(record.environment, workspace.strategy.symbol);
      const maximumLeverage = Number(rules.maxLeverage);
      const requestedLeverage = Math.max(binding.capitalPolicy.requestedLeverage || 1, binding.capitalPolicy.requestedLongLeverage || 1, binding.capitalPolicy.requestedShortLeverage || 1);
      if (!(maximumLeverage >= 1) || requestedLeverage > maximumLeverage) {
        throw new Error(`Bybit currently permits at most ${maximumLeverage || "the venue-advertised limit"}x leverage for ${workspace.strategy.symbol}.`);
      }
      binding.validation.maximumLeverage = maximumLeverage;
    }
    binding.status = "LIVE";
    binding.armedAt = nowIso();
  } else {
    binding.status = "PAUSED";
  }
  binding.validation = { ...binding.validation, eligible: true, reasons: [], checkedAt: nowIso() };
  binding.rowVersion += 1;
  binding.updatedAt = nowIso();
  audit(workspace, action === "pause" ? "LOCAL_TARGET_PAUSED" : "LOCAL_TARGET_ARMED", action === "pause" ? "Local target paused; existing exchange exposure was not changed." : "Local target explicitly armed for device-hosted execution.", binding.id);
  await writeWorkspace(workspace);
  return { binding: copy(binding) };
}

export async function disconnectLocalStrategyTarget(strategyIdValue: string, source: StrategyTargetBinding) {
  const workspace = await readWorkspace(strategyIdValue);
  const binding = requireBinding(workspace, source.id, source.rowVersion);
  if (binding.status === "LIVE") throw new Error("Pause the local target before disconnecting it.");
  binding.status = "DISCONNECTED";
  binding.rowVersion += 1;
  binding.updatedAt = nowIso();
  audit(workspace, "LOCAL_TARGET_DISCONNECTED", "Local target disconnected without mutating exchange orders or positions.", binding.id);
  await writeWorkspace(workspace);
  return { binding: copy(binding) };
}

export async function reorderLocalStrategyTargets(strategyIdValue: string, assignments: Array<{ bindingId: string; slotIndex: number; expectedVersion: number }>) {
  const workspace = await readWorkspace(strategyIdValue);
  if (new Set(assignments.map((item) => item.slotIndex)).size !== assignments.length) throw new Error("Local target slots must be unique.");
  for (const assignment of assignments) {
    const binding = requireBinding(workspace, assignment.bindingId, assignment.expectedVersion);
    binding.slotIndex = assignment.slotIndex;
    binding.rowVersion += 1;
    binding.updatedAt = nowIso();
  }
  const saved = await writeWorkspace(workspace);
  return { bindings: saved.bindings, snapshots: saved.snapshots };
}

function rawList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function snapshotForBinding(binding: StrategyTargetBinding): StrategyTargetSnapshot {
  const record = binding.accountId ? getLocalBrokerRecord(binding.accountId) : null;
  const account = record?.account;
  const venue = record?.lastSnapshot;
  const positions = rawList((venue?.positions as { list?: unknown[] } | null)?.list);
  const orders = rawList((venue?.openOrders as { list?: unknown[] } | null)?.list);
  const equity = account?.equityUsd || 0;
  const allocation = binding.capitalPolicy.strategyAllocationMode === "FIXED_USDT"
    ? Math.min(equity, binding.capitalPolicy.strategyAllocationValue)
    : equity * binding.capitalPolicy.strategyAllocationValue / 100;
  const used = account?.marginUsed || 0;
  const live = Boolean(venue && !record?.lastError && Date.now() - venue.capturedAt < 35_000);
  return {
    bindingId: binding.id,
    slotIndex: binding.slotIndex,
    timestamp: venue?.capturedAt || Date.now(),
    freshness: live ? "LIVE" : "DEGRADED",
    equity,
    availableBalance: account?.availableMargin || 0,
    allocatedStrategyCapital: allocation,
    usedStrategyCapital: used,
    freeStrategyCapital: Math.max(0, allocation - used),
    requestedLeverage: binding.capitalPolicy.requestedLeverage,
    effectiveLeverage: account?.leverage || binding.capitalPolicy.requestedLeverage || 1,
    openPositions: positions.length,
    openOrders: orders.length,
    walletBalance: account?.balanceUsd || 0,
    marginUsed: used,
    marginUtilization: equity > 0 ? used / equity * 100 : 0,
    realizedPnl: 0,
    unrealizedPnl: account?.dailyPnl || 0,
    grossPnl: account?.dailyPnl || 0,
    fees: 0,
    funding: 0,
    netPnl: account?.dailyPnl || 0,
    currentDrawdownPercent: 0,
    maximumDrawdownPercent: 0,
    strategyState: binding.status,
    connectionHealth: live ? "CONNECTED_LOCAL" : "DEGRADED",
    protectionHealth: "MONITORED",
  };
}

async function snapshotForGroupBinding(binding: StrategyTargetBinding, symbol: string): Promise<StrategyTargetSnapshot> {
  const all = await listLocalInvestmentGroupMandates(binding.groupId || binding.targetId);
  const active = await activeLocalInvestmentGroupMandates(binding.groupId || binding.targetId, symbol, binding.capitalPolicy);
  const allRemote = await listRemoteInvestmentGroupMandates(binding.groupId || binding.targetId);
  const activeRemote = await activeRemoteInvestmentGroupMandates(binding.groupId || binding.targetId, symbol, binding.capitalPolicy);
  const remoteReceipts = await listRemoteInvestmentGroupExecutionReceipts(binding.groupId || binding.targetId);
  const eligible = active.filter((item) => item.reasons.length === 0);
  const eligibleRemote = activeRemote.filter((item) => item.reasons.length === 0);
  const accountIds = eligible.map((item) => item.mandate.accountId);
  const portfolio = await getLocalBrokerPortfolioSnapshot(accountIds);
  const accounts = accountIds.map((accountId) => getLocalBrokerRecord(accountId)?.account).filter(Boolean);
  const equity = accounts.reduce((sum, account) => sum + Number(account?.equityUsd || 0), 0);
  const available = accounts.reduce((sum, account) => sum + Number(account?.availableMargin || 0), 0);
  const used = accounts.reduce((sum, account) => sum + Number(account?.marginUsed || 0), 0);
  const allocation = accounts.reduce((sum, account) => {
    if (!account) return sum;
    return sum + (binding.capitalPolicy.strategyAllocationMode === "FIXED_USDT"
      ? Math.min(account.equityUsd, binding.capitalPolicy.strategyAllocationValue)
      : account.equityUsd * binding.capitalPolicy.strategyAllocationValue / 100);
  }, 0);
  const localHealthy = eligible.length === 0 || portfolio.freshness.status === "live";
  const live = eligible.length + eligibleRemote.length > 0 && localHealthy;
  const latestRemoteReceipt = remoteReceipts.sort((left, right) => right.receivedAt - left.receivedAt)[0];
  return {
    bindingId: binding.id,
    slotIndex: binding.slotIndex,
    timestamp: portfolio.freshness.fetchedAt,
    freshness: live ? "LIVE" : eligible.length ? "DEGRADED" : "UNAVAILABLE",
    equity,
    availableBalance: available,
    allocatedStrategyCapital: allocation,
    usedStrategyCapital: used,
    freeStrategyCapital: Math.max(0, allocation - used),
    requestedLeverage: binding.capitalPolicy.requestedLeverage,
    effectiveLeverageRange: eligible.length + eligibleRemote.length
      ? [Math.min(...[...eligible, ...eligibleRemote].map((item) => item.mandate.maxLeverage)), Math.max(...[...eligible, ...eligibleRemote].map((item) => item.mandate.maxLeverage))]
      : undefined,
    members: all.length + allRemote.length,
    eligibleMembers: eligible.length + eligibleRemote.length,
    pausedMembers: [...all, ...allRemote].filter((mandate) => mandate.status === "PAUSED").length,
    degradedMembers: active.filter((item) => item.reasons.length > 0).length + activeRemote.filter((item) => item.reasons.length > 0).length,
    openPositions: portfolio.positions.length,
    openOrders: portfolio.orders.length,
    walletBalance: portfolio.summary.totalBalance,
    marginUsed: used,
    marginUtilization: equity > 0 ? used / equity * 100 : 0,
    realizedPnl: portfolio.summary.realizedPnl,
    unrealizedPnl: portfolio.summary.unrealizedPnl,
    grossPnl: portfolio.summary.realizedPnl + portfolio.summary.unrealizedPnl,
    fees: 0,
    funding: 0,
    netPnl: portfolio.summary.realizedPnl + portfolio.summary.unrealizedPnl,
    currentDrawdownPercent: 0,
    maximumDrawdownPercent: 0,
    strategyState: binding.status,
    connectionHealth: live ? eligibleRemote.length ? "LOCAL_P2P_GROUP_CONNECTED" : "LOCAL_GROUP_CONNECTED" : eligible.length + eligibleRemote.length ? "DEGRADED" : "NO_ELIGIBLE_MANDATES",
    protectionHealth: "MEMBER_MANDATE_ENFORCED",
    latestExecutionStatus: latestRemoteReceipt?.status,
    latestExecutionAt: latestRemoteReceipt?.receivedAt,
    latestExecutionErrorCode: latestRemoteReceipt?.safeErrorCode,
    latestExecutionVenueOrderSubmitted: latestRemoteReceipt?.status === "ENQUEUED",
  };
}

async function refreshWorkspaceSnapshots(workspace: StrategyWorkspace, persist: boolean) {
  await Promise.allSettled(workspace.bindings.filter((item) => item.accountId).map((item) => refreshLocalBrokerAccount(item.accountId!, false)));
  workspace.snapshots = await Promise.all(workspace.bindings
    .filter((binding) => binding.status !== "DISCONNECTED")
    .map((binding) => binding.targetType === "INVESTMENT_GROUP"
      ? snapshotForGroupBinding(binding, workspace.strategy.symbol)
      : Promise.resolve(snapshotForBinding(binding))));
  if (workspace.runtime?.state === "RUNNING") workspace.runtime.lastHeartbeatAt = nowIso();
  return persist ? writeWorkspace(workspace) : workspace;
}

export async function localStrategySnapshot(id: string) {
  const workspace = await refreshWorkspaceSnapshots(await getLocalStrategy(id), true);
  return { strategyId: id, timestamp: Date.now(), paper: workspace.paper, targets: workspace.snapshots, runtime: workspace.runtime };
}

export async function localStrategyPaperData(id: string) {
  const workspace = await readWorkspace(id);
  const ledger = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  return ledger?.value || { positions: [], orders: [], trades: [], executions: [], analytics: { equity: workspace.paper?.demoEquity || 0, status: workspace.paper?.status || "NOT_CONFIGURED" } };
}

export async function getLocalStrategyPaperRuntime(id: string) {
  const workspace = await readWorkspace(id);
  if (!workspace.paper) return null;
  const ledger = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  if (!ledger || ledger.value.strategyVersion !== workspace.paper.strategyVersion) {
    return { initialCapital: workspace.paper.demoEquity, checkpoint: null };
  }
  return { initialCapital: ledger.value.initialCapital, checkpoint: copy(ledger.value.checkpoint) };
}

function reconcilePaperAccount(account: StrategyPaperAccount, ledger: LocalStrategyPaperLedger) {
  const analytics = ledger.analytics;
  const equity = Number(analytics.equity || ledger.initialCapital);
  const used = Number(analytics.usedStrategyCapital || 0);
  account.demoEquity = ledger.initialCapital;
  account.availableBalance = Math.max(0, equity - used);
  account.usedStrategyCapital = used;
  account.realizedPnl = Number(analytics.realizedPnl || 0);
  account.unrealizedPnl = Number(analytics.unrealizedPnl || 0);
  account.fees = Number(analytics.fees || 0);
  account.funding = Number(analytics.funding || 0);
  account.maximumDrawdownPercent = Number(analytics.maxDrawdownPercent || analytics.maximumDrawdown || 0);
  account.updatedAt = ledger.updatedAt;
}

function paperTradeRecord(trade: NonNullable<BlackScriptCloudEvaluation["paperReport"]>["trades"][number]) {
  return {
    id: trade.id,
    side: trade.side.toUpperCase(),
    direction: trade.side,
    quantity: trade.quantity,
    entry_time: trade.entryTime,
    entry_price: trade.entryPrice,
    exit_time: trade.exitTime,
    exit_price: trade.exitPrice,
    gross_pnl: trade.grossPnl,
    commission: trade.commission,
    net_pnl: trade.netPnl,
    exit_reason: trade.exitReason,
  };
}

function paperFillRecord(fill: NonNullable<BlackScriptCloudEvaluation["paperReport"]>["fills"][number]) {
  return {
    id: fill.id,
    instruction_id: fill.instructionId,
    entry_id: fill.entryId,
    lot_uid: fill.lotUid,
    action: fill.action.toUpperCase(),
    direction: fill.side,
    side: fill.side.toUpperCase(),
    price: fill.price,
    quantity: fill.quantity,
    time: fill.time,
    placed_time: fill.placedTime,
    commission: fill.commission,
    realized_pnl: fill.realizedPnl,
    reason: fill.reason,
  };
}

export async function applyLocalStrategyPaperEvaluation(
  id: string,
  strategyVersion: number,
  evaluation: BlackScriptCloudEvaluation,
  initialCapital: number,
) {
  const report = evaluation.paperReport;
  if (!report) return null;
  const workspace = await readWorkspace(id);
  if (!workspace.paper || workspace.paper.status !== "ACTIVE") return null;
  const current = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  const previous = current?.value?.strategyVersion === strategyVersion ? current.value : null;
  const tradesById = new Map((previous?.trades || []).map((trade) => [String(trade.id), trade]));
  report.trades.map(paperTradeRecord).forEach((trade) => tradesById.set(String(trade.id), trade));
  const executionsById = new Map((previous?.executions || []).map((execution) => [String(execution.id), execution]));
  report.fills.map(paperFillRecord).forEach((execution) => executionsById.set(String(execution.id), execution));
  const grossRealized = Number(evaluation.checkpoint.engine.realizedPnl || 0);
  const unrealized = Number(report.openPosition?.unrealizedPnl || 0);
  const trades = [...tradesById.values()].sort((left, right) => Number(left.exit_time || 0) - Number(right.exit_time || 0)).slice(-10_000);
  const executions = [...executionsById.values()].sort((left, right) => Number(left.time || 0) - Number(right.time || 0)).slice(-20_000);
  const wins = trades.filter((trade) => Number(trade.net_pnl || 0) > 0);
  const losses = trades.filter((trade) => Number(trade.net_pnl || 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.net_pnl || 0), 0));
  const positions = report.openPosition ? [{
    id: `paper-position:${id}:${report.openPosition.side}`,
    side: report.openPosition.side.toUpperCase(),
    direction: report.openPosition.side,
    quantity: report.openPosition.quantity,
    size: report.openPosition.quantity,
    average_price: report.openPosition.averagePrice,
    unrealized_pnl: report.openPosition.unrealizedPnl,
    updated_at: evaluation.latestClosedCandleTime,
  }] : [];
  const orders = report.pendingOrders.map((order) => ({
    id: order.key,
    instruction_id: order.instructionId,
    action: order.action.toUpperCase(),
    side: order.side.toUpperCase(),
    direction: order.side,
    quantity: order.quantity,
    quantity_percent: order.quantityPercent,
    limit_price: order.limit,
    stop_price: order.stop,
    trailing_activation: order.trailActivation,
    trailing_stop: order.trailStop,
    placed_at: order.placedTime,
    status: "WORKING",
  }));
  const timestamp = nowIso();
  const usedStrategyCapital = positions.reduce((sum, position) => sum + Number(position.quantity || 0) * Number(position.average_price || 0) / Math.max(1, Number(workspace.paper?.capitalPolicy.requestedLeverage || 1)), 0);
  const peakEquity = Math.max(0, Number(evaluation.checkpoint.engine.peakEquity || report.endingEquity));
  const currentDrawdown = peakEquity > 0 ? Math.max(0, (peakEquity - report.endingEquity) / peakEquity * 100) : 0;
  const ledger: LocalStrategyPaperLedger = {
    schemaVersion: 1,
    strategyId: id,
    strategyVersion,
    initialCapital,
    checkpoint: copy(evaluation.checkpoint),
    lastClosedCandleTime: evaluation.latestClosedCandleTime,
    positions,
    orders,
    executions,
    trades,
    analytics: {
      status: workspace.paper.status,
      equity: report.endingEquity,
      realizedPnl: grossRealized,
      unrealizedPnl: unrealized,
      grossPnl: grossRealized + unrealized,
      fees: report.totalCommission,
      funding: 0,
      netPnl: grossRealized + unrealized - report.totalCommission,
      maximumDrawdown: report.maxDrawdown,
      maxDrawdownPercent: report.maxDrawdown,
      currentDrawdown,
      currentDrawdownPercent: currentDrawdown,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      tradeCount: trades.length,
      openPositions: positions.length,
      openOrders: orders.length,
      usedStrategyCapital,
      latestClosedCandleTime: evaluation.latestClosedCandleTime,
    },
    updatedAt: timestamp,
  };
  const saved = await putLocalDocument(STRATEGY_PAPER_LEDGER_NAMESPACE, id, ledger, current?.revision ?? 0);
  if (!saved) throw new Error("The encrypted local Paper ledger is unavailable.");
  workspace.paper.demoEquity = initialCapital;
  workspace.paper.usedStrategyCapital = usedStrategyCapital;
  workspace.paper.availableBalance = Math.max(0, report.endingEquity - usedStrategyCapital);
  workspace.paper.realizedPnl = grossRealized;
  workspace.paper.unrealizedPnl = unrealized;
  workspace.paper.fees = report.totalCommission;
  workspace.paper.maximumDrawdownPercent = report.maxDrawdown;
  workspace.paper.updatedAt = timestamp;
  if (!previous || previous.lastClosedCandleTime !== evaluation.latestClosedCandleTime) workspace.paper.rowVersion += 1;
  await writeWorkspace(workspace);
  return ledger;
}

export async function localStrategyTargetData(strategyIdValue: string, bindingIdValue: string, resource: string) {
  const workspace = await readWorkspace(strategyIdValue);
  const binding = workspace.bindings.find((item) => item.id === bindingIdValue);
  if (!binding) return { [resource]: resource === "analytics" || resource === "risk" ? {} : [] };
  const accountIds = binding.targetType === "INVESTMENT_GROUP"
    ? (await activeLocalInvestmentGroupMandates(binding.groupId || binding.targetId, workspace.strategy.symbol, binding.capitalPolicy))
      .filter((item) => item.reasons.length === 0)
      .map((item) => item.mandate.accountId)
    : binding.accountId ? [binding.accountId] : [];
  if (!accountIds.length) return { [resource]: resource === "analytics" || resource === "risk" ? {} : [] };
  const portfolio = await getLocalBrokerPortfolioSnapshot(accountIds);
  const value = resource === "positions" ? portfolio.positions
    : resource === "orders" ? portfolio.orders
      : resource === "analytics" ? portfolio.summary
        : resource === "risk" ? binding.capitalPolicy
          : [];
  return { [resource]: value };
}

export async function localStrategyGroupExecutionDesks(groupId: string): Promise<{ groupId: string; desks: StrategyGroupExecutionDesk[] }> {
  const documents = await listLocalDocuments<StrategyWorkspace>(STRATEGY_NAMESPACE);
  const desks: StrategyGroupExecutionDesk[] = [];
  for (const document of documents) {
    const workspace = await refreshWorkspaceSnapshots(copy(document.value), false);
    for (const binding of workspace.bindings.filter((item) => item.targetType === "INVESTMENT_GROUP" && (item.groupId || item.targetId) === groupId && item.status !== "DISCONNECTED")) {
      const resources = await Promise.all(["positions", "orders", "executions", "trades", "analytics"].map((resource) => localStrategyTargetData(workspace.strategy.id, binding.id, resource)));
      desks.push({
        strategy: workspace.strategy,
        binding,
        snapshot: workspace.snapshots.find((snapshot) => snapshot.bindingId === binding.id) || null,
        data: {
          positions: (resources[0].positions || []) as Array<Record<string, unknown>>,
          orders: (resources[1].orders || []) as Array<Record<string, unknown>>,
          executions: (resources[2].executions || []) as Array<Record<string, unknown>>,
          trades: (resources[3].trades || []) as Array<Record<string, unknown>>,
          analytics: (resources[4].analytics || {}) as Record<string, unknown>,
        },
      });
    }
  }
  return { groupId, desks };
}

export async function configureLocalStrategyPaper(id: string, expectedVersion: number, policy: StrategyCapitalPolicy) {
  const workspace = await readWorkspace(id);
  if (workspace.paper && workspace.paper.rowVersion !== expectedVersion) throw new Error("The local Paper account changed. Reload it and try again.");
  if (workspace.paper) {
    const recalculated = paperAccount(id, workspace.strategy.runningVersion || workspace.strategy.publishedVersion || 0, workspace.strategy.definition, policy, workspace.paper.demoEquity);
    workspace.paper = {
      ...workspace.paper,
      strategyVersion: recalculated.strategyVersion,
      capitalPolicy: copy(policy),
      capitalPolicyVersion: workspace.paper.capitalPolicyVersion + 1,
      preview: recalculated.preview,
      rowVersion: workspace.paper.rowVersion + 1,
      updatedAt: nowIso(),
    };
  } else {
    workspace.paper = paperAccount(id, workspace.strategy.runningVersion || workspace.strategy.publishedVersion || 0, workspace.strategy.definition, policy);
  }
  audit(workspace, "LOCAL_PAPER_CONFIGURED", "Local isolated Paper account configured.");
  await writeWorkspace(workspace);
  return { paper: copy(workspace.paper) };
}

export async function localStrategyPaperAction(id: string, action: "start" | "pause" | "top-up" | "reset", expectedVersion: number, body: Record<string, unknown> = {}) {
  const workspace = await readWorkspace(id);
  if (!workspace.paper) throw new Error("This local strategy has no Paper account.");
  if (workspace.paper.rowVersion !== expectedVersion) throw new Error("The local Paper account changed. Reload it and try again.");
  if (action === "start") workspace.paper.status = "ACTIVE";
  if (action === "pause") workspace.paper.status = "PAUSED";
  if (action === "top-up") {
    const amount = Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a positive Paper top-up amount.");
    if (workspace.paper.status !== "PAUSED") throw new Error("Pause Paper Trading before changing its virtual capital.");
    const current = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
    if (current?.value.strategyVersion === workspace.paper.strategyVersion) {
      const ledger = copy(current.value);
      ledger.initialCapital += amount;
      ledger.checkpoint.engine.peakEquity += amount;
      ledger.analytics.equity = Number(ledger.analytics.equity || workspace.paper.demoEquity) + amount;
      ledger.updatedAt = nowIso();
      const saved = await putLocalDocument(STRATEGY_PAPER_LEDGER_NAMESPACE, id, ledger, current.revision);
      if (!saved) throw new Error("The encrypted Paper ledger changed before the top-up could be committed.");
    }
    workspace.paper.demoEquity += amount;
    workspace.paper.availableBalance += amount;
  }
  if (action === "reset") {
    if (workspace.paper.status !== "PAUSED") throw new Error("Pause Paper Trading before resetting its virtual account.");
    const current = await getLocalDocument<LocalStrategyPaperLedger>(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
    if (current && (current.value.positions.length > 0 || current.value.orders.length > 0)) throw new Error("Close the Paper position and cancel its working orders before reset.");
    const demoEquity = Number(body.demoEquity ?? workspace.paper.demoEquity);
    if (!Number.isFinite(demoEquity) || demoEquity <= 0 || demoEquity > 1_000_000_000) throw new Error("Enter Paper equity between 0 and 1,000,000,000 USDT.");
    workspace.paper = paperAccount(id, workspace.paper.strategyVersion, workspace.strategy.definition, workspace.paper.capitalPolicy, demoEquity);
    workspace.paper.status = "PAUSED";
    await deleteLocalDocument(STRATEGY_PAPER_LEDGER_NAMESPACE, id);
  } else {
    workspace.paper.rowVersion += 1;
    workspace.paper.updatedAt = nowIso();
  }
  audit(workspace, `LOCAL_PAPER_${action.toUpperCase().replace("-", "_")}`, `Local Paper action ${action} completed.`);
  await writeWorkspace(workspace);
  return { paper: copy(workspace.paper) };
}
