const templates = {
  investment_group_invite: ({ displayName, groupName }) => ({
    subject: `Invitation to ${groupName || "a Black Terminal Investment Group"}`,
    title: "Investment Group Invitation",
    body: `${displayName || "A Black Terminal member"} invited you to join ${groupName || "an Investment Group"}. Open Black Terminal to review the invitation.`
  }),
  security_alert: ({ eventLabel }) => ({
    subject: "Black Terminal security alert",
    title: "Security Event Detected",
    body: `Black Terminal blocked a security-sensitive action${eventLabel ? ` (${eventLabel})` : ""}. Review the security audit ledger for non-sensitive details.`
  }),
  broker_connection_notice: ({ provider, status }) => ({
    subject: "Broker connection notice",
    title: "Broker Connection Update",
    body: `Your ${provider || "broker"} connection status changed to ${status || "updated"}. Open Black Terminal to review diagnostics.`
  }),
  trade_execution_notification: ({ symbol, side, status }) => ({
    subject: "Trade execution notification",
    title: "Execution Update",
    body: `Your ${symbol || "market"} ${side || "trade"} execution is ${status || "updated"}. Review the authenticated execution ledger for details.`
  }),
  account_verification: () => ({
    subject: "Verify your Black Terminal account",
    title: "Account Verification",
    body: "Open Black Terminal and follow the Supabase Auth verification link sent during registration. Black Terminal never asks you to send a verification code to another person."
  })
};

export const ALLOWED_EMAIL_TEMPLATES = Object.freeze(Object.keys(templates));

export function renderEmailTemplate(type, data = {}) {
  const factory = templates[type];
  if (!factory) throw Object.assign(new Error("Unsupported email template."), { statusCode: 400, code: "INVALID_TEMPLATE" });
  const template = factory(sanitizeTemplateData(data));
  return { subject: template.subject, html: renderShell(template.title, template.body) };
}

function sanitizeTemplateData(data) {
  return Object.fromEntries(Object.entries(data || {}).slice(0, 20).map(([key, value]) => [key, cleanText(value)]));
}

function cleanText(value) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function renderShell(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#0a0c0f;color:#fff;font-family:Arial,sans-serif"><table width="100%" role="presentation" style="padding:32px 16px"><tr><td align="center"><table width="520" role="presentation" style="background:#12161c;border:1px solid #252a33;border-radius:12px"><tr><td style="padding:20px 28px;background:#c90032;color:#fff;font-weight:700">BLACK TERMINAL</td></tr><tr><td style="padding:28px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1><p style="color:#b8c0cc;line-height:1.6;margin:0">${escapeHtml(body)}</p></td></tr><tr><td style="padding:16px 28px;border-top:1px solid #252a33;color:#6f7885;font-size:11px">Security-controlled notification. Do not reply.</td></tr></table></td></tr></table></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
