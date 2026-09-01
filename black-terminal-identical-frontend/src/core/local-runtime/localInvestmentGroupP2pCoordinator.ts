import {
  announceLocalInvestmentGroups,
  flushProfessionalNetworkStore,
  ingestLocalP2pInvestmentGroupDecision,
  ingestLocalP2pInvestmentGroupDirectory,
  ingestLocalP2pInvestmentGroupJoinRequest,
  ingestLocalP2pInvestmentGroupMessage,
} from "../../modules/profile/professionalNetworkStore";
import { getLocalDocument, putLocalDocument } from "./localDocumentStore";
import { listLocalP2pInbox, sendLocalP2pDirect } from "./localP2pClient";
import { isLocalOnlyRuntime } from "./localRuntimeClient";
import { announceLocalInvestmentGroupMandates } from "./localInvestmentGroupMandateStore";
import { ingestRemoteInvestmentGroupExecutionReceipt, ingestRemoteInvestmentGroupMandate } from "./localInvestmentGroupRemoteStore";
import { executeRemoteInvestmentGroupEvaluation } from "./localStrategyCoordinator";

const NAMESPACE = "investment-group-p2p";
const STATE_KEY = "inbox-state-v1";
const POLL_MS = 4_000;

type GroupP2pState = {
  schemaVersion: 1;
  processedMessageIds: string[];
  updatedAt: number;
};

let stopCoordinator: (() => void) | null = null;
let lastDirectoryAnnouncementAt = 0;
let lastMandateAnnouncementAt = 0;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readState() {
  const document = await getLocalDocument<GroupP2pState>(NAMESPACE, STATE_KEY);
  const value = document?.value;
  return {
    document,
    state: value?.schemaVersion === 1
      ? { ...value, processedMessageIds: Array.isArray(value.processedMessageIds) ? value.processedMessageIds.slice(-4_000) : [] }
      : { schemaVersion: 1 as const, processedMessageIds: [], updatedAt: Date.now() },
  };
}

function safeError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 180) || "REMOTE_GROUP_EXECUTION_REJECTED";
}

async function applyMessage(messageId: string, sourcePeerId: string, payloadValue: unknown) {
  const envelope = object(payloadValue);
  const event = object(envelope.payload);
  if (Number(event.schemaVersion) !== 1) return false;
  const kind = String(event.kind || "");
  if (kind === "group-directory-entry") {
    return ingestLocalP2pInvestmentGroupDirectory(sourcePeerId, event.group);
  }
  if (kind === "group-join-request") {
    return ingestLocalP2pInvestmentGroupJoinRequest(sourcePeerId, String(event.groupId || ""), event.request);
  }
  if (kind === "group-join-decision") {
    const action = event.action === "approve" ? "approve" : event.action === "decline" ? "decline" : null;
    return action ? ingestLocalP2pInvestmentGroupDecision(sourcePeerId, event.group, String(event.requestId || ""), action) : false;
  }
  if (kind === "group-room-message") {
    return ingestLocalP2pInvestmentGroupMessage(sourcePeerId, String(event.groupId || ""), event.message);
  }
  if (kind === "group-mandate-state") {
    return ingestRemoteInvestmentGroupMandate(sourcePeerId, event.mandate);
  }
  if (kind === "group-strategy-evaluation") {
    let result: Awaited<ReturnType<typeof executeRemoteInvestmentGroupEvaluation>> | null = null;
    let errorCode: string | undefined;
    try {
      result = await executeRemoteInvestmentGroupEvaluation(sourcePeerId, event);
    } catch (error) {
      errorCode = safeError(error);
    }
    await sendLocalP2pDirect(sourcePeerId, `${messageId}:ack`, {
      schemaVersion: 1,
      kind: "group-strategy-ack",
      requestMessageId: messageId,
      groupId: String(event.groupId || ""),
      publicMandateId: String(event.publicMandateId || ""),
      strategyId: String(event.strategyId || ""),
      strategyVersion: Number(event.strategyVersion || 0),
      latestClosedCandleTime: Number(object(event.evaluation).latestClosedCandleTime || 0),
      status: result?.status || "REJECTED",
      ...(errorCode ? { safeErrorCode: errorCode } : {}),
    });
    return true;
  }
  if (kind === "group-strategy-ack") {
    return ingestRemoteInvestmentGroupExecutionReceipt(sourcePeerId, event);
  }
  return false;
}

export function startLocalInvestmentGroupP2pCoordinator() {
  if (!isLocalOnlyRuntime() || stopCoordinator) return () => undefined;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (Date.now() - lastDirectoryAnnouncementAt >= 60_000) {
        announceLocalInvestmentGroups();
        lastDirectoryAnnouncementAt = Date.now();
      }
      if (Date.now() - lastMandateAnnouncementAt >= 30_000) {
        await announceLocalInvestmentGroupMandates();
        lastMandateAnnouncementAt = Date.now();
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { document, state } = await readState();
        const processed = new Set(state.processedMessageIds);
        const inbox = await listLocalP2pInbox(500).catch(() => []);
        const accepted: string[] = [];
        for (const message of inbox.slice().reverse()) {
          if (processed.has(message.messageId)) continue;
          if (!message.topic.includes("investment-groups") && !message.topic.includes("direct")) continue;
          try {
            if (await applyMessage(message.messageId, message.sourcePeerId, message.payload)) accepted.push(message.messageId);
          } catch (error) {
            console.warn("Rejected local Investment Group P2P event", error);
          }
        }
        if (!accepted.length) break;
        await flushProfessionalNetworkStore();
        const next: GroupP2pState = {
          schemaVersion: 1,
          processedMessageIds: [...state.processedMessageIds, ...accepted].slice(-4_000),
          updatedAt: Date.now(),
        };
        try {
          await putLocalDocument(NAMESPACE, STATE_KEY, next, document?.revision ?? 0);
          break;
        } catch (error) {
          if (!String(error).includes("LOCAL_DOCUMENT_REVISION_CONFLICT") || attempt === 2) throw error;
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), POLL_MS);
  window.setTimeout(() => void tick(), 1_000);
  stopCoordinator = () => {
    stopped = true;
    window.clearInterval(timer);
    stopCoordinator = null;
  };
  return stopCoordinator;
}
