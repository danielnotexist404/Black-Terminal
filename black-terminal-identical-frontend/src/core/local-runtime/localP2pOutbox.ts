import { deleteLocalDocument, getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { sendLocalP2pDirect } from "./localP2pClient";
import { isLocalOnlyRuntime } from "./localRuntimeClient";

const NAMESPACE = "p2p-direct-outbox";
const POLL_MS = 5_000;

export type LocalP2pOutboxMessage = {
  schemaVersion: 1;
  messageId: string;
  peerId: string;
  payload: Record<string, unknown>;
  category: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastSafeError?: string;
};

let stopOutbox: (() => void) | null = null;

function safeError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 180) || "P2P_DIRECT_DELIVERY_FAILED";
}

function assertNoBrokerSecrets(value: unknown, path = "payload") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoBrokerSecrets(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/api.?secret|api.?key|private.?key|credential/i.test(key)) {
      throw new Error(`Broker secrets are forbidden in the P2P outbox (${path}.${key}).`);
    }
    assertNoBrokerSecrets(nested, `${path}.${key}`);
  }
}

function documentKey(peerId: string, messageId: string) {
  return `${peerId}:${messageId}`;
}

async function deliver(message: LocalP2pOutboxMessage) {
  const key = documentKey(message.peerId, message.messageId);
  try {
    await sendLocalP2pDirect(message.peerId, message.messageId, message.payload);
    await deleteLocalDocument(NAMESPACE, key);
    return true;
  } catch (error) {
    const current = await getLocalDocument<LocalP2pOutboxMessage>(NAMESPACE, key);
    if (!current) return false;
    const attempts = current.value.attempts + 1;
    const next: LocalP2pOutboxMessage = {
      ...current.value,
      attempts,
      nextAttemptAt: Date.now() + Math.min(300_000, 2_000 * (2 ** Math.min(8, attempts))),
      updatedAt: Date.now(),
      lastSafeError: safeError(error),
    };
    await putLocalDocument(NAMESPACE, key, next, current.revision).catch(() => undefined);
    return false;
  }
}

export async function enqueueLocalP2pDirectMessage(input: {
  peerId: string;
  messageId: string;
  payload: Record<string, unknown>;
  category: string;
}) {
  if (!isLocalOnlyRuntime()) throw new Error("The encrypted P2P outbox is available only in the installed local runtime.");
  assertNoBrokerSecrets(input.payload);
  const peerId = input.peerId.trim();
  const messageId = input.messageId.trim();
  if (!peerId || !messageId || messageId.length > 160) throw new Error("The P2P outbox destination or message identity is invalid.");
  const key = documentKey(peerId, messageId);
  const current = await getLocalDocument<LocalP2pOutboxMessage>(NAMESPACE, key);
  const timestamp = Date.now();
  const message: LocalP2pOutboxMessage = current?.value || {
    schemaVersion: 1,
    peerId,
    messageId,
    payload: structuredClone(input.payload),
    category: input.category.slice(0, 80),
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (current && JSON.stringify(current.value.payload) !== JSON.stringify(input.payload)) {
    throw new Error("P2P outbox idempotency collision: the message identifier already protects a different payload.");
  }
  const saved = current || await putLocalDocument(NAMESPACE, key, message, 0);
  if (!saved) throw new Error("The encrypted P2P outbox is unavailable.");
  await deliver(message);
  return { queued: true as const, messageId };
}

export async function listLocalP2pOutbox() {
  return (await listLocalDocuments<LocalP2pOutboxMessage>(NAMESPACE)).map((document) => document.value);
}

export async function localP2pOutboxSummary() {
  const messages = await listLocalP2pOutbox();
  const ordered = [...messages].sort((left, right) => left.createdAt - right.createdAt);
  const latestFailure = [...messages]
    .filter((message) => message.lastSafeError)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return {
    pending: messages.length,
    retrying: messages.filter((message) => message.attempts > 0).length,
    oldestCreatedAt: ordered[0]?.createdAt ?? null,
    lastSafeError: latestFailure?.lastSafeError ?? null,
  };
}

export function startLocalP2pOutbox() {
  if (!isLocalOnlyRuntime() || stopOutbox) return () => undefined;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const pending = (await listLocalP2pOutbox())
        .filter((message) => message.schemaVersion === 1 && message.nextAttemptAt <= Date.now())
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, 25);
      for (const message of pending) await deliver(message);
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), POLL_MS);
  window.setTimeout(() => void tick(), 1_500);
  stopOutbox = () => {
    stopped = true;
    window.clearInterval(timer);
    stopOutbox = null;
  };
  return stopOutbox;
}
