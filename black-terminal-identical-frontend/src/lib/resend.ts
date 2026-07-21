import { supabase } from "./supabase";

type EmailTemplate =
  | "investment_group_invite"
  | "security_alert"
  | "broker_connection_notice"
  | "trade_execution_notification"
  | "account_verification";

async function sendTemplate(type: EmailTemplate, data: Record<string, string | number | boolean> = {}) {
  if (!supabase) return { success: false, error: "Authenticated email delivery is unavailable." };
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { success: false, error: "Sign in before requesting an email notification." };
  const response = await fetch("/api/email/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type, data })
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok ? { success: true } : { success: false, error: payload.error || "Email delivery failed." };
}

export function sendResendEmail(payload: Record<string, unknown>) {
  return sendTemplate("trade_execution_notification", {
    symbol: String(payload.symbol || ""), side: String(payload.side || payload.condition || ""), status: String(payload.message || "alert").slice(0, 80)
  });
}

export function sendSecurityAlertEmail(username: string) {
  return sendTemplate("security_alert", { eventLabel: `blocked AI request by ${username}` });
}

export function sendVerificationEmail() {
  return sendTemplate("account_verification");
}
