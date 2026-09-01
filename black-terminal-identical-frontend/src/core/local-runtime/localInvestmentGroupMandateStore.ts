import type { EligibleGroupTarget, StrategyCapitalPolicy } from "../../modules/strategy-lab/automation/strategyAutomation.types";
import { getLocalProfessionalNetworkState, userIdFromUsername } from "../../modules/profile/professionalNetworkStore";
import type { InvestmentGroup } from "../../modules/profile/types";
import { getLocalBybitInstrumentRules } from "./localBybitClient";
import { getLocalBrokerRecord, listLocalBrokerAccounts, refreshLocalBrokerAccount } from "./localBrokerStore";
import { deleteLocalDocument, getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { getCachedLocalRuntimeStatus } from "./localRuntimeClient";
import { sendLocalP2pDirect } from "./localP2pClient";
import { activeRemoteInvestmentGroupMandates, listRemoteInvestmentGroupMandates } from "./localInvestmentGroupRemoteStore";

const MANDATE_NAMESPACE = "investment-group-mandates";

export type LocalInvestmentGroupMandateStatus = "ACTIVE" | "PAUSED" | "REVOKED";

export type LocalInvestmentGroupMandate = {
  schemaVersion: 1;
  id: string;
  publicMandateId: string;
  groupId: string;
  accountId: string;
  accountLabel: string;
  provider: "BYBIT";
  environment: "DEMO" | "TESTNET" | "MAINNET";
  memberUserId: string;
  memberUsername: string;
  memberPeerId: string;
  status: LocalInvestmentGroupMandateStatus;
  version: number;
  allowedMarketTypes: Array<"FUTURES">;
  allowedSymbols: string[];
  maxStrategyAllocationPercent: number;
  maxPerTradeAllocationPercent: number;
  maxLeverage: number;
  allowMainnet: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type LocalInvestmentGroupMandateDraft = {
  groupId: string;
  accountId: string;
  allowedSymbols: string[];
  maxStrategyAllocationPercent: number;
  maxPerTradeAllocationPercent: number;
  maxLeverage: number;
  allowMainnet: boolean;
};

function iso() {
  return new Date().toISOString();
}

function normalizeSymbols(values: readonly string[]) {
  const symbols = [...new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => value === "*" || /^[A-Z0-9]{5,24}$/.test(value)))];
  if (!symbols.length) throw new Error("Authorize at least one futures symbol, for example BTCUSDT.");
  return symbols.slice(0, 100);
}

function finitePercent(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`${label} must be above 0% and no greater than 100%.`);
  return value;
}

function finiteLeverage(value: number) {
  if (!Number.isFinite(value) || value < 1 || value > 100) throw new Error("Mandate leverage must be between 1x and 100x; the venue's lower symbol limit still applies.");
  return value;
}

function ownerIdentity() {
  const config = getCachedLocalRuntimeStatus()?.config;
  if (!config) throw new Error("The installed Black Terminal owner identity is unavailable.");
  return {
    userId: userIdFromUsername(config.profile.username),
    username: config.profile.username,
    peerId: config.peerId,
  };
}

function groupAndMembership(groupId: string) {
  const identity = ownerIdentity();
  const state = getLocalProfessionalNetworkState();
  const group = state.groups.find((item) => item.id === groupId);
  if (!group || group.status !== "active") throw new Error("The local Investment Group is unavailable or inactive.");
  const membership = state.groupMembers.find((item) => item.groupId === groupId && item.userId === identity.userId && item.status === "active");
  if (!membership && group.ownerUserId !== identity.userId) throw new Error("Only an active group member can authorize one of this device's broker accounts.");
  return { group, identity, membership };
}

function mandateId(groupId: string, accountId: string) {
  return `${groupId}:${accountId}`;
}

function publicMandateId() {
  return `group-mandate:${crypto.randomUUID()}`;
}

function notifyGroupOwner(mandate: LocalInvestmentGroupMandate) {
  const group = getLocalProfessionalNetworkState().groups.find((item) => item.id === mandate.groupId);
  if (!group?.ownerPeerId || group.ownerPeerId === mandate.memberPeerId) return;
  const messageId = `${mandate.publicMandateId}:v${mandate.version}:h${Math.floor(Date.now() / 30_000)}`;
  void sendLocalP2pDirect(group.ownerPeerId, messageId, {
    schemaVersion: 1,
    kind: "group-mandate-state",
    mandate: {
      publicMandateId: mandate.publicMandateId,
      groupId: mandate.groupId,
      memberUsername: mandate.memberUsername,
      memberPeerId: mandate.memberPeerId,
      provider: mandate.provider,
      environment: mandate.environment,
      status: mandate.status,
      version: mandate.version,
      allowedMarketTypes: mandate.allowedMarketTypes,
      allowedSymbols: mandate.allowedSymbols,
      maxStrategyAllocationPercent: mandate.maxStrategyAllocationPercent,
      maxPerTradeAllocationPercent: mandate.maxPerTradeAllocationPercent,
      maxLeverage: mandate.maxLeverage,
      allowMainnet: mandate.allowMainnet,
      updatedAt: mandate.updatedAt,
    },
  }).catch(() => undefined);
}

export async function announceLocalInvestmentGroupMandates() {
  const mandates = await listLocalInvestmentGroupMandates();
  mandates.filter((mandate) => mandate.status !== "REVOKED").forEach(notifyGroupOwner);
}

function validMandate(value: LocalInvestmentGroupMandate | null | undefined): value is LocalInvestmentGroupMandate {
  return Boolean(value?.schemaVersion === 1 && value.id && value.groupId && value.accountId);
}

export async function listLocalInvestmentGroupMandates(groupId?: string) {
  const documents = await listLocalDocuments<LocalInvestmentGroupMandate>(MANDATE_NAMESPACE);
  return documents
    .map((document) => document.value)
    .filter(validMandate)
    .filter((mandate) => !groupId || mandate.groupId === groupId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getLocalInvestmentGroupMandateByPublicId(publicId: string) {
  return (await listLocalInvestmentGroupMandates()).find((mandate) => mandate.publicMandateId === publicId) || null;
}

export async function authorizeLocalInvestmentGroupMandate(draft: LocalInvestmentGroupMandateDraft) {
  const { identity } = groupAndMembership(draft.groupId);
  const account = listLocalBrokerAccounts("STRATEGY_LAB").find((item) => item.id === draft.accountId);
  const record = getLocalBrokerRecord(draft.accountId);
  if (!account || !record) throw new Error("Select a dedicated Strategy Lab broker account on this device.");
  await refreshLocalBrokerAccount(account.id, true);
  const refreshed = getLocalBrokerRecord(account.id);
  if (!refreshed?.lastSnapshot || refreshed.lastError || !refreshed.lastSnapshot.tradingEnabled) {
    throw new Error("The broker account must authenticate with derivatives trading permission before it can be authorized.");
  }
  if (refreshed.lastSnapshot.withdrawalEnabled) throw new Error("Investment Group automation requires a trade-only API key with withdrawal permission disabled.");
  if (refreshed.environment === "MAINNET" && (!refreshed.mainnetConfirmed || draft.allowMainnet !== true)) {
    throw new Error("Mainnet group authority requires both the broker connection confirmation and this mandate's explicit Mainnet permission.");
  }
  const allowedSymbols = normalizeSymbols(draft.allowedSymbols);
  const requestedLeverage = finiteLeverage(Number(draft.maxLeverage));
  for (const symbol of allowedSymbols.filter((item) => item !== "*")) {
    const rules = await getLocalBybitInstrumentRules(refreshed.environment, symbol);
    if (requestedLeverage > Number(rules.maxLeverage)) {
      throw new Error(`Bybit permits at most ${rules.maxLeverage}x leverage for ${symbol}.`);
    }
  }
  const id = mandateId(draft.groupId, account.id);
  const current = await getLocalDocument<LocalInvestmentGroupMandate>(MANDATE_NAMESPACE, id);
  const timestamp = iso();
  const mandate: LocalInvestmentGroupMandate = {
    schemaVersion: 1,
    id,
    publicMandateId: current?.value.publicMandateId || publicMandateId(),
    groupId: draft.groupId,
    accountId: account.id,
    accountLabel: account.accountName,
    provider: "BYBIT",
    environment: refreshed.environment,
    memberUserId: identity.userId,
    memberUsername: identity.username,
    memberPeerId: identity.peerId,
    status: "ACTIVE",
    version: Number(current?.value.version || 0) + 1,
    allowedMarketTypes: ["FUTURES"],
    allowedSymbols,
    maxStrategyAllocationPercent: finitePercent(Number(draft.maxStrategyAllocationPercent), "Maximum strategy allocation"),
    maxPerTradeAllocationPercent: finitePercent(Number(draft.maxPerTradeAllocationPercent), "Maximum per-trade allocation"),
    maxLeverage: requestedLeverage,
    allowMainnet: refreshed.environment === "MAINNET" ? true : draft.allowMainnet === true,
    createdAt: current?.value.createdAt || timestamp,
    updatedAt: timestamp,
  };
  const saved = await putLocalDocument(MANDATE_NAMESPACE, id, mandate, current?.revision ?? 0);
  if (!saved) throw new Error("The encrypted local mandate store is unavailable.");
  notifyGroupOwner(saved.value);
  return saved.value;
}

export async function setLocalInvestmentGroupMandateStatus(
  mandateIdValue: string,
  status: Exclude<LocalInvestmentGroupMandateStatus, "REVOKED">,
) {
  const current = await getLocalDocument<LocalInvestmentGroupMandate>(MANDATE_NAMESPACE, mandateIdValue);
  if (!current || !validMandate(current.value)) throw new Error("The local execution mandate was not found.");
  const { identity } = groupAndMembership(current.value.groupId);
  if (current.value.memberUserId !== identity.userId || current.value.memberPeerId !== identity.peerId) {
    throw new Error("Only the account owner on the authorizing device can change this mandate.");
  }
  const next: LocalInvestmentGroupMandate = {
    ...current.value,
    status,
    version: current.value.version + 1,
    updatedAt: iso(),
    revokedAt: undefined,
  };
  const saved = await putLocalDocument(MANDATE_NAMESPACE, mandateIdValue, next, current.revision);
  if (!saved) throw new Error("The encrypted local mandate store is unavailable.");
  notifyGroupOwner(saved.value);
  return saved.value;
}

export async function revokeLocalInvestmentGroupMandate(mandateIdValue: string) {
  const current = await getLocalDocument<LocalInvestmentGroupMandate>(MANDATE_NAMESPACE, mandateIdValue);
  if (!current || !validMandate(current.value)) return;
  const identity = ownerIdentity();
  if (current.value.memberUserId !== identity.userId || current.value.memberPeerId !== identity.peerId) {
    throw new Error("Only the account owner on the authorizing device can revoke this mandate.");
  }
  const timestamp = iso();
  const next: LocalInvestmentGroupMandate = {
    ...current.value,
    status: "REVOKED",
    version: current.value.version + 1,
    updatedAt: timestamp,
    revokedAt: timestamp,
  };
  const saved = await putLocalDocument(MANDATE_NAMESPACE, mandateIdValue, next, current.revision);
  if (!saved) throw new Error("The encrypted local mandate store is unavailable.");
  notifyGroupOwner(saved.value);
  return saved.value;
}

export async function deleteRevokedLocalInvestmentGroupMandate(mandateIdValue: string) {
  const current = await getLocalDocument<LocalInvestmentGroupMandate>(MANDATE_NAMESPACE, mandateIdValue);
  if (!current) return;
  if (current.value.status !== "REVOKED") throw new Error("Revoke the execution mandate before deleting its audit record.");
  await deleteLocalDocument(MANDATE_NAMESPACE, mandateIdValue);
}

function symbolAllowed(mandate: LocalInvestmentGroupMandate, symbol: string) {
  return mandate.allowedSymbols.includes("*") || mandate.allowedSymbols.includes(symbol.toUpperCase());
}

export function validateLocalInvestmentGroupPolicy(
  mandate: LocalInvestmentGroupMandate,
  policy: StrategyCapitalPolicy,
  equity: number,
) {
  const reasons: string[] = [];
  const allocation = policy.strategyAllocationMode === "FIXED_USDT"
    ? policy.strategyAllocationValue
    : equity * policy.strategyAllocationValue / 100;
  const maximumAllocation = equity * mandate.maxStrategyAllocationPercent / 100;
  if (allocation > maximumAllocation + 1e-9) reasons.push(`Strategy allocation exceeds this member's ${mandate.maxStrategyAllocationPercent}% mandate cap.`);
  if (policy.tradeAmountMode === "FIXED_QUANTITY") {
    reasons.push("Fixed-quantity sizing is not eligible for group fanout because it cannot be bounded by the member's equity mandate before price resolution.");
  } else {
    const tradeMargin = policy.tradeAmountMode === "FIXED_USDT"
      ? policy.tradeAmountValue
      : policy.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY"
        ? equity * policy.tradeAmountValue / 100
        : allocation * policy.tradeAmountValue / 100;
    const maximumTradeMargin = allocation * mandate.maxPerTradeAllocationPercent / 100;
    if (tradeMargin > maximumTradeMargin + 1e-9) reasons.push(`Per-trade margin exceeds this member's ${mandate.maxPerTradeAllocationPercent}% allocation cap.`);
  }
  const leverage = Math.max(
    Number(policy.requestedLeverage || 1),
    Number(policy.requestedLongLeverage || policy.requestedLeverage || 1),
    Number(policy.requestedShortLeverage || policy.requestedLeverage || 1),
  );
  if (leverage > mandate.maxLeverage) reasons.push(`Requested leverage exceeds this member's ${mandate.maxLeverage}x mandate cap.`);
  return reasons;
}

export async function activeLocalInvestmentGroupMandates(groupId: string, symbol: string, policy?: StrategyCapitalPolicy) {
  const mandates = (await listLocalInvestmentGroupMandates(groupId)).filter((mandate) => mandate.status === "ACTIVE");
  const resolved: Array<{ mandate: LocalInvestmentGroupMandate; reasons: string[] }> = [];
  for (const mandate of mandates) {
    const reasons: string[] = [];
    const account = listLocalBrokerAccounts("STRATEGY_LAB").find((item) => item.id === mandate.accountId);
    const record = getLocalBrokerRecord(mandate.accountId);
    if (!account || !record) reasons.push("The authorized broker account is not present on its owner device.");
    if (!symbolAllowed(mandate, symbol)) reasons.push(`${symbol} is not included in this member's mandate.`);
    if (record?.environment === "MAINNET" && (!record.mainnetConfirmed || !mandate.allowMainnet)) reasons.push("Mainnet authority is not confirmed by this member.");
    if (record?.lastSnapshot?.withdrawalEnabled) reasons.push("Withdrawal-enabled API keys cannot participate in group automation.");
    if (!record?.lastSnapshot?.tradingEnabled) reasons.push("The broker key does not have derivatives trading permission.");
    if (record?.lastError || account?.status === "degraded") reasons.push(record?.lastError || "The broker account is degraded.");
    if (policy && account) reasons.push(...validateLocalInvestmentGroupPolicy(mandate, policy, account.equityUsd));
    try {
      if (record) {
        const rules = await getLocalBybitInstrumentRules(record.environment, symbol);
        if (mandate.maxLeverage > Number(rules.maxLeverage)) reasons.push(`The mandate exceeds Bybit's current ${rules.maxLeverage}x limit for ${symbol}.`);
      }
    } catch {
      reasons.push("Bybit instrument rules could not be authenticated for this member.");
    }
    resolved.push({ mandate, reasons: [...new Set(reasons)] });
  }
  return resolved;
}

function managedGroup(group: InvestmentGroup, localUserId: string) {
  if (group.ownerUserId === localUserId) return true;
  const state = getLocalProfessionalNetworkState();
  return state.groupMembers.some((member) => member.groupId === group.id && member.userId === localUserId && member.status === "active" && ["owner", "manager"].includes(member.role));
}

export async function eligibleLocalInvestmentGroupTargets(symbol: string, policy?: StrategyCapitalPolicy): Promise<EligibleGroupTarget[]> {
  const identity = ownerIdentity();
  const state = getLocalProfessionalNetworkState();
  const targets: EligibleGroupTarget[] = [];
  for (const group of state.groups.filter((item) => item.status === "active" && managedGroup(item, identity.userId))) {
    const allMandates = await listLocalInvestmentGroupMandates(group.id);
    const active = await activeLocalInvestmentGroupMandates(group.id, symbol, policy);
    const allRemoteMandates = await listRemoteInvestmentGroupMandates(group.id);
    const activeRemote = policy ? await activeRemoteInvestmentGroupMandates(group.id, symbol, policy) : [];
    const eligible = active.filter((item) => item.reasons.length === 0);
    const eligibleRemote = activeRemote.filter((item) => item.reasons.length === 0);
    const accounts = eligible.map((item) => getLocalBrokerRecord(item.mandate.accountId)?.account).filter(Boolean);
    const reasons: string[] = [];
    if (!allMandates.length && !allRemoteMandates.length) reasons.push("No member has authorized a dedicated broker account.");
    if (!eligible.length && !eligibleRemote.length && (allMandates.length || allRemoteMandates.length)) reasons.push("No active mandate currently satisfies the strategy symbol, sizing, leverage, host-connectivity, and broker-health requirements.");
    targets.push({
      targetId: group.id,
      targetType: "INVESTMENT_GROUP",
      label: group.firmName,
      activeAuthorizedMembers: eligible.length + eligibleRemote.length,
      connectedAllocatedEquity: accounts.reduce((sum, account) => sum + Number(account?.equityUsd || 0), 0),
      copyTradingReadiness: eligible.length && eligibleRemote.length ? "LOCAL_AND_P2P_READY" : eligibleRemote.length ? "P2P_DIRECT_READY" : eligible.length ? "LOCAL_DEVICE_READY" : "NOT_READY",
      blackCloudReadiness: "LOCAL_BACKGROUND_RUNTIME",
      riskState: reasons.length ? "BLOCKED" : "WITHIN_MEMBER_MANDATES",
      pausedMembers: [...allMandates, ...allRemoteMandates].filter((mandate) => mandate.status === "PAUSED").length,
      degradedMembers: active.filter((item) => item.reasons.length > 0).length + activeRemote.filter((item) => item.reasons.length > 0).length,
      validation: { eligible: reasons.length === 0, reasons },
    });
  }
  return targets;
}
