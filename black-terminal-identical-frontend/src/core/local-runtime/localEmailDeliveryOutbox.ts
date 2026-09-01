import { deleteLocalDocument, getLocalDocument, listLocalDocuments, putLocalDocument } from "./localDocumentStore";
import { isLocalOnlyRuntime } from "./localRuntimeClient";
import { readLocalEmailProviderSettings, sendLocalEmail, type LocalEmailProviderSettings } from "./localEmailClient";
import { assertLocalEmailDelivery, buildLocalAlertEmail } from "./localEmailModel";

const NAMESPACE = "alert-email-outbox";
const POLL_MS = 5_000;

type LocalEmailDelivery = {
  schemaVersion: 1;
  messageId: string;
  provider: LocalEmailProviderSettings;
  to: string;
  subject: string;
  body: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastSafeError?: string;
};

let stopOutbox: (() => void) | null = null;

function safeError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n\t]+/g, " ").replace(/[^A-Za-z0-9:@_ .-]/g, "").slice(0, 180) || "LOCAL_EMAIL_DELIVERY_FAILED";
}

async function deliver(message: LocalEmailDelivery) {
  try {
    await sendLocalEmail({ provider: message.provider, to: message.to, subject: message.subject, body: message.body });
    await deleteLocalDocument(NAMESPACE, message.messageId);
    return true;
  } catch (cause) {
    const current = await getLocalDocument<LocalEmailDelivery>(NAMESPACE, message.messageId);
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

export async function enqueueLocalEmailDelivery(input: { messageId: string; to: string; payload: Record<string, unknown> }) {
  if (!isLocalOnlyRuntime()) throw new Error("The encrypted email outbox is available only in the installed local runtime.");
  const provider = await readLocalEmailProviderSettings();
  if (!provider.enabled) throw new Error("Configure and enable the local SMTP provider in Settings before using email alerts.");
  const messageId = input.messageId.trim();
  const to = input.to.trim();
  const { subject, body } = buildLocalAlertEmail(input.payload);
  if (!messageId || messageId.length > 160) throw new Error("The local email delivery identity is invalid.");
  assertLocalEmailDelivery(to, subject, body);
  const current = await getLocalDocument<LocalEmailDelivery>(NAMESPACE, messageId);
  const timestamp = Date.now();
  const message: LocalEmailDelivery = current?.value || {
    schemaVersion: 1,
    messageId,
    provider,
    to,
    subject,
    body,
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (current && (current.value.to !== to || current.value.subject !== subject || current.value.body !== body)) {
    throw new Error("Email outbox idempotency collision: this delivery ID protects a different message.");
  }
  const saved = current || await putLocalDocument(NAMESPACE, messageId, message, 0);
  if (!saved) throw new Error("The encrypted email outbox is unavailable.");
  await deliver(message);
  return { queued: true as const, messageId };
}

export async function localEmailOutboxSummary() {
  const messages = (await listLocalDocuments<LocalEmailDelivery>(NAMESPACE)).map((document) => document.value);
  const latestFailure = [...messages].filter((message) => message.lastSafeError).sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return { pending: messages.length, retrying: messages.filter((message) => message.attempts > 0).length, lastSafeError: latestFailure?.lastSafeError ?? null };
}

export function startLocalEmailDeliveryOutbox() {
  if (!isLocalOnlyRuntime() || stopOutbox) return () => undefined;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const pending = (await listLocalDocuments<LocalEmailDelivery>(NAMESPACE))
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
  window.setTimeout(() => void tick(), 1_500);
  stopOutbox = () => { stopped = true; window.clearInterval(timer); stopOutbox = null; };
  return stopOutbox;
}
