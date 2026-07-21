import { invoke } from "@tauri-apps/api/core";
import { sendResendEmail } from "./resend";

export async function publicMarketGet<T = unknown>(url: string) {
  return await invoke<T>("public_market_get", { url });
}

export async function sendWebhook(payload: Record<string, unknown>, explicitUrl?: string) {
  try {
    const url = explicitUrl?.trim() || localStorage.getItem("bt_webhook_url") || "";
    if (!url) return { skipped: true, reason: "No webhook URL configured" };
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
    results.push(await sendWebhook({ ...payload, delivery: "p2p" }, p2pEndpoint));
  }

  if (sshTarget) {
    results.push(await sendSshAlert({ ...payload, delivery: "ssh" }, sshTarget));
  }

  if (delivery.email && delivery.emailTo?.trim()) {
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
