import type { StrategyCapitalPolicy } from "../../modules/strategy-lab/automation/strategyAutomation.types";
import { getLocalProfessionalNetworkState, userIdFromUsername } from "../../modules/profile/professionalNetworkStore";
import { getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { readLocalP2pStatus } from "./localP2pClient";
import { getCachedLocalRuntimeStatus } from "./localRuntimeClient";

const REMOTE_MANDATE_NAMESPACE = "investment-group-remote-mandates";
const REMOTE_RECEIPT_NAMESPACE = "investment-group-remote-receipts";

export type RemoteInvestmentGroupMandate = {
  schemaVersion: 1;
  publicMandateId: string;
  groupId: string;
  memberUsername: string;
  memberPeerId: string;
  provider: "BYBIT";
  environment: "DEMO" | "TESTNET" | "MAINNET";
  status: "ACTIVE" | "PAUSED" | "REVOKED";
  version: number;
  allowedMarketTypes: Array<"FUTURES">;
  allowedSymbols: string[];
  maxStrategyAllocationPercent: number;
  maxPerTradeAllocationPercent: number;
  maxLeverage: number;
  allowMainnet: boolean;
  memberUpdatedAt: string;
  lastReceivedAt: number;
};

export type RemoteInvestmentGroupExecutionReceipt = {
  schemaVersion: 1;
  requestMessageId: string;
  groupId: string;
  publicMandateId: string;
  memberPeerId: string;
  strategyId: string;
  strategyVersion: number;
  latestClosedCandleTime: number;
  status: "ENQUEUED" | "REJECTED";
  safeErrorCode?: string;
  receivedAt: number;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, lower: number, upper: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= lower && parsed <= upper ? parsed : null;
}

function key(groupId: string, memberPeerId: string, publicMandateId: string) {
  return `${groupId}:${memberPeerId}:${publicMandateId}`;
}

function localIdentity() {
  const config = getCachedLocalRuntimeStatus()?.config;
  if (!config) throw new Error("The local owner identity is unavailable.");
  return { userId: userIdFromUsername(config.profile.username), peerId: config.peerId };
}

export async function ingestRemoteInvestmentGroupMandate(sourcePeerId: string, value: unknown) {
  const raw = object(value);
  const groupId = String(raw.groupId || "");
  const publicMandateId = String(raw.publicMandateId || "").slice(0, 180);
  if (!groupId || !publicMandateId || String(raw.memberPeerId || "") !== sourcePeerId) return false;
  const identity = localIdentity();
  const network = getLocalProfessionalNetworkState();
  const group = network.groups.find((item) => item.id === groupId && item.ownerPeerId === identity.peerId && item.ownerUserId === identity.userId);
  const member = network.groupMembers.find((item) => item.groupId === groupId && item.peerId === sourcePeerId && item.status === "active");
  if (!group || !member) return false;
  const allocation = finite(raw.maxStrategyAllocationPercent, 0.01, 100);
  const perTrade = finite(raw.maxPerTradeAllocationPercent, 0.01, 100);
  const leverage = finite(raw.maxLeverage, 1, 100);
  if (allocation === null || perTrade === null || leverage === null) return false;
  const environment = ["DEMO", "TESTNET", "MAINNET"].includes(String(raw.environment)) ? raw.environment as RemoteInvestmentGroupMandate["environment"] : null;
  const status = ["ACTIVE", "PAUSED", "REVOKED"].includes(String(raw.status)) ? raw.status as RemoteInvestmentGroupMandate["status"] : null;
  if (!environment || !status || raw.provider !== "BYBIT") return false;
  const allowedSymbols = Array.isArray(raw.allowedSymbols)
    ? [...new Set(raw.allowedSymbols.map(String).map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol === "*" || /^[A-Z0-9]{5,24}$/.test(symbol)))].slice(0, 100)
    : [];
  if (!allowedSymbols.length) return false;
  const documentKey = key(groupId, sourcePeerId, publicMandateId);
  const current = await getLocalDocument<RemoteInvestmentGroupMandate>(REMOTE_MANDATE_NAMESPACE, documentKey);
  const version = Number(raw.version || 0);
  if (current && version < current.value.version) return true;
  const mandate: RemoteInvestmentGroupMandate = {
    schemaVersion: 1,
    publicMandateId,
    groupId,
    memberUsername: String(raw.memberUsername || member.username).slice(0, 100),
    memberPeerId: sourcePeerId,
    provider: "BYBIT",
    environment,
    status,
    version,
    allowedMarketTypes: ["FUTURES"],
    allowedSymbols,
    maxStrategyAllocationPercent: allocation,
    maxPerTradeAllocationPercent: perTrade,
    maxLeverage: leverage,
    allowMainnet: raw.allowMainnet === true,
    memberUpdatedAt: String(raw.updatedAt || new Date().toISOString()),
    lastReceivedAt: Date.now(),
  };
  const saved = await putLocalDocument(REMOTE_MANDATE_NAMESPACE, documentKey, mandate, current?.revision ?? 0);
  if (!saved) throw new Error("The encrypted remote mandate store is unavailable.");
  return true;
}

export async function listRemoteInvestmentGroupMandates(groupId?: string) {
  const documents = await listLocalDocuments<RemoteInvestmentGroupMandate>(REMOTE_MANDATE_NAMESPACE);
  return documents.map((document) => document.value)
    .filter((mandate) => mandate?.schemaVersion === 1 && (!groupId || mandate.groupId === groupId));
}

function policyReasons(mandate: RemoteInvestmentGroupMandate, policy: StrategyCapitalPolicy) {
  const reasons: string[] = [];
  if (policy.strategyAllocationMode !== "PERCENT_ACCOUNT_EQUITY") {
    reasons.push("Remote group members require percentage-of-equity strategy allocation so their private equity does not leave their device.");
  } else if (policy.strategyAllocationValue > mandate.maxStrategyAllocationPercent) {
    reasons.push(`Strategy allocation exceeds ${mandate.memberUsername}'s ${mandate.maxStrategyAllocationPercent}% mandate cap.`);
  }
  if (policy.tradeAmountMode === "PERCENT_STRATEGY_ALLOCATION") {
    if (policy.tradeAmountValue > mandate.maxPerTradeAllocationPercent) reasons.push(`Per-trade sizing exceeds ${mandate.memberUsername}'s ${mandate.maxPerTradeAllocationPercent}% mandate cap.`);
  } else if (policy.tradeAmountMode === "PERCENT_ACCOUNT_EQUITY") {
    const maximumAccountPercent = mandate.maxStrategyAllocationPercent * mandate.maxPerTradeAllocationPercent / 100;
    if (policy.tradeAmountValue > maximumAccountPercent) reasons.push(`Per-trade sizing exceeds ${mandate.memberUsername}'s ${maximumAccountPercent}% account-equity ceiling.`);
  } else {
    reasons.push("Remote group members require percentage-based per-trade sizing so private account equity never leaves their device.");
  }
  const leverage = Math.max(Number(policy.requestedLeverage || 1), Number(policy.requestedLongLeverage || 1), Number(policy.requestedShortLeverage || 1));
  if (leverage > mandate.maxLeverage) reasons.push(`Leverage exceeds ${mandate.memberUsername}'s ${mandate.maxLeverage}x mandate cap.`);
  return reasons;
}

export async function activeRemoteInvestmentGroupMandates(groupId: string, symbol: string, policy: StrategyCapitalPolicy) {
  const status = await readLocalP2pStatus().catch(() => null);
  const connected = new Set(status?.connectedPeers || []);
  return (await listRemoteInvestmentGroupMandates(groupId))
    .filter((mandate) => mandate.status === "ACTIVE")
    .map((mandate) => {
      const reasons: string[] = [];
      if (!mandate.allowedSymbols.includes("*") && !mandate.allowedSymbols.includes(symbol.toUpperCase())) reasons.push(`${symbol} is not authorized by ${mandate.memberUsername}.`);
      if (mandate.environment === "MAINNET" && !mandate.allowMainnet) reasons.push(`${mandate.memberUsername} did not authorize Mainnet.`);
      if (!connected.has(mandate.memberPeerId)) reasons.push(`${mandate.memberUsername}'s execution host is offline or not directly connected.`);
      if (Date.now() - mandate.lastReceivedAt > 90_000) reasons.push(`${mandate.memberUsername}'s execution mandate heartbeat is stale.`);
      reasons.push(...policyReasons(mandate, policy));
      return { mandate, reasons: [...new Set(reasons)] };
    });
}

export async function ingestRemoteInvestmentGroupExecutionReceipt(sourcePeerId: string, value: unknown) {
  const raw = object(value);
  const groupId = String(raw.groupId || "");
  const publicMandateId = String(raw.publicMandateId || "");
  const requestMessageId = String(raw.requestMessageId || "").slice(0, 180);
  const grant = (await listRemoteInvestmentGroupMandates(groupId)).find((mandate) => mandate.publicMandateId === publicMandateId && mandate.memberPeerId === sourcePeerId);
  if (!grant || !requestMessageId) return false;
  const receipt: RemoteInvestmentGroupExecutionReceipt = {
    schemaVersion: 1,
    requestMessageId,
    groupId,
    publicMandateId,
    memberPeerId: sourcePeerId,
    strategyId: String(raw.strategyId || "").slice(0, 180),
    strategyVersion: Number(raw.strategyVersion || 0),
    latestClosedCandleTime: Number(raw.latestClosedCandleTime || 0),
    status: raw.status === "ENQUEUED" ? "ENQUEUED" : "REJECTED",
    safeErrorCode: raw.safeErrorCode ? String(raw.safeErrorCode).replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 180) : undefined,
    receivedAt: Date.now(),
  };
  const documentKey = `${groupId}:${sourcePeerId}:${requestMessageId}`;
  const current = await getLocalDocument<RemoteInvestmentGroupExecutionReceipt>(REMOTE_RECEIPT_NAMESPACE, documentKey);
  const saved = await putLocalDocument(REMOTE_RECEIPT_NAMESPACE, documentKey, receipt, current?.revision ?? 0);
  if (!saved) throw new Error("The encrypted remote execution receipt store is unavailable.");
  return true;
}

export async function listRemoteInvestmentGroupExecutionReceipts(groupId?: string) {
  const documents = await listLocalDocuments<RemoteInvestmentGroupExecutionReceipt>(REMOTE_RECEIPT_NAMESPACE);
  return documents.map((document) => document.value).filter((receipt) => receipt?.schemaVersion === 1 && (!groupId || receipt.groupId === groupId));
}
