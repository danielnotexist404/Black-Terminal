export type LocalEmailTransport = "TLS" | "STARTTLS";

export type LocalEmailProviderSettings = {
  schemaVersion: 1;
  enabled: boolean;
  credentialId: string;
  smtpHost: string;
  smtpPort: number;
  transport: LocalEmailTransport;
  fromAddress: string;
  fromName: string;
};

export const defaultLocalEmailProvider: LocalEmailProviderSettings = {
  schemaVersion: 1,
  enabled: false,
  credentialId: "primary-alerts",
  smtpHost: "",
  smtpPort: 587,
  transport: "STARTTLS",
  fromAddress: "",
  fromName: "Black Terminal",
};

export function normalizeLocalEmailProviderSettings(value: Partial<LocalEmailProviderSettings>): LocalEmailProviderSettings {
  const credentialId = String(value.credentialId || defaultLocalEmailProvider.credentialId).trim().toLowerCase();
  const smtpHost = String(value.smtpHost || "").trim().toLowerCase();
  const fromAddress = String(value.fromAddress || "").trim();
  const fromName = String(value.fromName || "Black Terminal").trim();
  const smtpPort = Number(value.smtpPort);
  const transport: LocalEmailTransport = value.transport === "TLS" ? "TLS" : "STARTTLS";
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(credentialId)) throw new Error("The SMTP credential identifier is invalid.");
  if (value.enabled) {
    if (!smtpHost || smtpHost.length > 253 || !smtpHost.includes(".") || /\s/.test(smtpHost)) throw new Error("Enter a valid SMTP hostname.");
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || smtpPort === 25) throw new Error("Use an encrypted SMTP submission port such as 465, 587, or 2525.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) || fromAddress.length > 320) throw new Error("Enter a valid sender email address.");
  }
  if (fromName.length > 100 || /[\r\n]/.test(fromName)) throw new Error("The sender display name is invalid.");
  return { schemaVersion: 1, enabled: Boolean(value.enabled), credentialId, smtpHost, smtpPort: Number.isInteger(smtpPort) ? smtpPort : 587, transport, fromAddress, fromName };
}

export function assertLocalEmailDelivery(to: string, subject: string, body: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 320) throw new Error("The local email recipient is invalid.");
  if (!subject.trim() || subject.length > 200 || /[\r\n]/.test(subject)) throw new Error("The local email subject is invalid.");
  if (!body || new TextEncoder().encode(body).length > 64 * 1024 || body.includes("\0")) throw new Error("The local email body is invalid or exceeds 64 KiB.");
  if (/(?:api.?secret|api.?key|private.?key|credential)\s*[:=]/i.test(body)) throw new Error("Broker secrets are forbidden in the email outbox.");
}

function alertBody(payload: Record<string, unknown>) {
  const rows = [
    ["Alert", payload.alertName],
    ["Symbol", payload.symbol],
    ["Exchange", payload.exchange],
    ["Timeframe", payload.timeframe],
    ["Price", payload.price],
    ["Indicator", payload.indicator],
    ["Condition", payload.condition],
    ["Timestamp", payload.timestamp],
    ["Message", payload.message],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
  return ["Black Terminal local alert", "", ...rows.map(([label, value]) => `${label}: ${String(value)}`)].join("\n");
}

export function buildLocalAlertEmail(payload: Record<string, unknown>) {
  const alertName = String(payload.alertName || "Alert").replace(/[\r\n]/g, " ").trim().slice(0, 120) || "Alert";
  const symbol = String(payload.symbol || "").replace(/[\r\n]/g, " ").trim().slice(0, 32);
  return {
    subject: `[Black Terminal] ${alertName}${symbol ? ` · ${symbol}` : ""}`,
    body: alertBody(payload),
  };
}
