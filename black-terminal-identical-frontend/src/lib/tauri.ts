import { invoke } from "@tauri-apps/api/core";
import { sendResendEmail } from "./resend";
import { getLocalDocument } from "../core/local-runtime/localDocumentStore";
import { isLocalOnlyRuntime } from "../core/local-runtime/localRuntimeClient";
import { dialLocalP2pPeer } from "../core/local-runtime/localP2pClient";
import { enqueueLocalP2pDirectMessage } from "../core/local-runtime/localP2pOutbox";
import { enqueueLocalWebhookDelivery } from "../core/local-runtime/localAlertDeliveryOutbox";

export async function publicMarketGet<T = unknown>(url: string) {
  return await invoke<T>("public_market_get", { url });
}

export async function sendWebhook(payload: Record<string, unknown>, explicitUrl?: string) {
  try {
    const localDefaults = isLocalOnlyRuntime()
      ? await getLocalDocument<{ webhookUrl?: string }>("settings", "alert-delivery")
      : null;
    const url = explicitUrl?.trim() || localDefaults?.value.webhookUrl?.trim() || localStorage.getItem("bt_webhook_url") || "";
    if (!url) return { skipped: true, reason: "No webhook URL configured" };
    if (isLocalOnlyRuntime()) {
      return await enqueueLocalWebhookDelivery({ messageId: `webhook-${crypto.randomUUID()}`, url, payload });
    }
    return await invoke("send_webhook", { url, payload });
  } catch (err) {
    console.error("Webhook failed", err);
    return { error: String(err) };
  }
}

export async function sendSshAlert(payload: Record<string, unknown>, target?: string) {
  void payload;
  void target;
  return { skipped: true, reason: "SSH alert IPC is disabled by the Security Fortress policy." };
}

async function sendP2pAlert(payload: Record<string, unknown>, endpoint: string) {
  const target = endpoint.trim();
  if (!isLocalOnlyRuntime()) return { skipped: true, reason: "P2P alert delivery requires the installed local runtime." };
  let peerId = target;
  if (target.includes("/p2p/")) {
    peerId = target.slice(target.lastIndexOf("/p2p/") + 5);
    await dialLocalP2pPeer(target);
  }
  if (!peerId || peerId.includes("/")) throw new Error("Enter a peer ID or full /p2p/ multiaddress for P2P alert delivery.");
  const messageId = `alert-${crypto.randomUUID()}`;
  await enqueueLocalP2pDirectMessage({ peerId, messageId, category: "alert", payload: {
    schemaVersion: 1,
    kind: "alert",
    messageId,
    payload,
    sentAt: new Date().toISOString(),
  } });
  return { queued: true, peerId, messageId };
}

export async function sendIndicatorAlert(
  payload: Record<string, unknown>,
  delivery: {
    webhook: boolean;
    webhookUrl?: string;
    p2pEndpoint?: string;
    sshTarget?: string;
    email: boolean;
    emailTo?: string;
  }
) {
  const results: unknown[] = [];
  const webhookUrl = delivery.webhookUrl?.trim();
  const p2pEndpoint = delivery.p2pEndpoint?.trim();
  const sshTarget = delivery.sshTarget?.trim();

  if (delivery.webhook) {
    results.push(await sendWebhook({ ...payload, delivery: "webhook" }, webhookUrl));
  }

  if (p2pEndpoint) {
    results.push(await sendP2pAlert({ ...payload, delivery: "p2p" }, p2pEndpoint));
  }

  if (sshTarget) {
    results.push(await sendSshAlert({ ...payload, delivery: "ssh" }, sshTarget));
  }

  if (delivery.email && delivery.emailTo?.trim() && isLocalOnlyRuntime()) {
    results.push({ skipped: true, reason: "Local email delivery requires an SMTP credential adapter; no email was sent." });
  } else if (delivery.email && delivery.emailTo?.trim()) {
    results.push(await sendResendEmail({
      to: delivery.emailTo.trim(),
      alertName: String(payload.alertName || "Alert"),
      symbol: String(payload.symbol || ""),
      exchange: String(payload.exchange || ""),
      timeframe: String(payload.timeframe || ""),
      price: String(payload.price || ""),
      message: String(payload.message || ""),
      indicator: payload.indicator ? String(payload.indicator) : undefined,
      condition: payload.condition ? String(payload.condition) : undefined,
      level: payload.level !== undefined ? String(payload.level) : undefined,
      timestamp: String(payload.timestamp || new Date().toISOString())
    }));
  }

  return results;
}
