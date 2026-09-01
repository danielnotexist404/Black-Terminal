import { invoke } from "@tauri-apps/api/core";
import { deleteLocalDocument, getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { isLocalOnlyRuntime } from "./localRuntimeClient";

const NAMESPACE = "alert-webhook-outbox";
const POLL_MS = 5_000;

type LocalWebhookDelivery = {
  schemaVersion: 1;
  messageId: string;
  url: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastSafeError?: string;
};

let stopOutbox: (() => void) | null = null;

function safeError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n\t]+/g, " ").replace(/[^A-Za-z0-9:_ .-]/g, "").slice(0, 180) || "LOCAL_WEBHOOK_DELIVERY_FAILED";
}

function assertPayload(value: Record<string, unknown>) {
  const encoded = JSON.stringify(value);
  if (encoded.length > 64 * 1024) throw new Error("The local webhook payload exceeds 64 KiB.");
  if (/"(?:api.?secret|api.?key|private.?key|credential)"\s*:/i.test(encoded)) {
    throw new Error("Broker secrets are forbidden in the alert delivery outbox.");
  }
}

async function deliver(message: LocalWebhookDelivery) {
  try {
    await invoke("send_webhook", { url: message.url, payload: message.payload });
    await deleteLocalDocument(NAMESPACE, message.messageId);
    return true;
  } catch (cause) {
    const current = await getLocalDocument<LocalWebhookDelivery>(NAMESPACE, message.messageId);
    if (!current) return false;
    const attempts = current.value.attempts + 1;
    await putLocalDocument(NAMESPACE, message.messageId, {
      ...current.value,
      attempts,
      nextAttemptAt: Date.now() + Math.min(300_000, 2_000 * (2 ** Math.min(8, attempts))),
      updatedAt: Date.now(),
      lastSafeError: safeError(cause),
    }, current.revision).catch(() => undefined);
    return false;
  }
}

export async function enqueueLocalWebhookDelivery(input: { messageId: string; url: string; payload: Record<string, unknown> }) {
  if (!isLocalOnlyRuntime()) throw new Error("The encrypted alert outbox is available only in the installed local runtime.");
  assertPayload(input.payload);
  const messageId = input.messageId.trim();
  const url = input.url.trim();
  if (!messageId || messageId.length > 160 || !url) throw new Error("The local webhook delivery identity is invalid.");
  const current = await getLocalDocument<LocalWebhookDelivery>(NAMESPACE, messageId);
  const timestamp = Date.now();
  const message: LocalWebhookDelivery = current?.value || {
    schemaVersion: 1,
    messageId,
    url,
    payload: structuredClone(input.payload),
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (current && (current.value.url !== url || JSON.stringify(current.value.payload) !== JSON.stringify(input.payload))) {
    throw new Error("Alert outbox idempotency collision: this delivery ID protects a different payload.");
  }
  const saved = current || await putLocalDocument(NAMESPACE, messageId, message, 0);
  if (!saved) throw new Error("The encrypted alert outbox is unavailable.");
  await deliver(message);
  return { queued: true as const, messageId };
}

export async function localAlertOutboxSummary() {
  const messages = (await listLocalDocuments<LocalWebhookDelivery>(NAMESPACE)).map((document) => document.value);
  const latestFailure = [...messages].filter((message) => message.lastSafeError).sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return { pending: messages.length, retrying: messages.filter((message) => message.attempts > 0).length, lastSafeError: latestFailure?.lastSafeError ?? null };
}

export function startLocalAlertDeliveryOutbox() {
  if (!isLocalOnlyRuntime() || stopOutbox) return () => undefined;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const pending = (await listLocalDocuments<LocalWebhookDelivery>(NAMESPACE))
        .map((document) => document.value)
        .filter((message) => message.schemaVersion === 1 && message.nextAttemptAt <= Date.now())
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, 25);
      for (const message of pending) await deliver(message);
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), POLL_MS);
  window.setTimeout(() => void tick(), 1_250);
  stopOutbox = () => { stopped = true; window.clearInterval(timer); stopOutbox = null; };
  return stopOutbox;
}
