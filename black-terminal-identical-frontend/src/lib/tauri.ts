import { invoke } from "@tauri-apps/api/core";

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
  try {
    const sshTarget = target?.trim() || localStorage.getItem("bt_alert_ssh_target") || "";
    if (!sshTarget) return { skipped: true, reason: "No SSH target configured" };
    return await invoke("send_ssh_alert", { target: sshTarget, payload });
  } catch (err) {
    console.error("SSH alert failed", err);
    return { error: String(err) };
  }
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
    results.push(await sendWebhook({
      ...payload,
      delivery: "email",
      emailTo: delivery.emailTo.trim()
    }, webhookUrl));
  }

  return results;
}
