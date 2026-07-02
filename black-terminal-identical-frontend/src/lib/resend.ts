// Resend email integration for Black Terminal alerts

const RESEND_API_KEY = import.meta.env.VITE_RESEND_API_KEY || "";
const RESEND_FROM = import.meta.env.VITE_RESEND_FROM || "Black Terminal <onboarding@resend.dev>";

export const isResendConfigured = !!RESEND_API_KEY;

interface AlertEmailPayload {
  to: string;
  alertName: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  price: string | number;
  message: string;
  indicator?: string;
  condition?: string;
  level?: string | number;
  timestamp?: string;
}

function buildAlertEmailHtml(payload: AlertEmailPayload): string {
  const ts = payload.timestamp || new Date().toISOString();
  const formattedTime = new Date(ts).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium"
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0c0f;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c0f;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#12161c;border-radius:12px;border:1px solid #1e2530;overflow:hidden;">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#ff0044 0%,#cc0033 100%);padding:20px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">⚡ BLACK TERMINAL</div>
                    <div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Price Alert Triggered</div>
                  </td>
                  <td align="right" style="vertical-align:top;">
                    <div style="background:rgba(0,0,0,0.3);border-radius:6px;padding:6px 12px;font-size:11px;color:#fff;font-weight:600;">${formattedTime}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Alert Name -->
          <tr>
            <td style="padding:24px 28px 12px;">
              <div style="font-size:20px;font-weight:700;color:#ffffff;">${payload.alertName}</div>
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td style="padding:0 28px 20px;">
              <div style="font-size:14px;color:#a8b2c1;line-height:1.6;">${payload.message}</div>
            </td>
          </tr>

          <!-- Info Grid -->
          <tr>
            <td style="padding:0 28px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1017;border-radius:8px;border:1px solid #1a1f2a;">
                <tr>
                  <td style="padding:14px 18px;border-bottom:1px solid #1a1f2a;width:50%;">
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Symbol</div>
                    <div style="font-size:15px;color:#ffffff;font-weight:700;margin-top:4px;">${payload.symbol}</div>
                  </td>
                  <td style="padding:14px 18px;border-bottom:1px solid #1a1f2a;border-left:1px solid #1a1f2a;width:50%;">
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Exchange</div>
                    <div style="font-size:15px;color:#ffffff;font-weight:700;margin-top:4px;">${payload.exchange}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 18px;border-bottom:1px solid #1a1f2a;width:50%;">
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Price</div>
                    <div style="font-size:15px;color:#00ff66;font-weight:700;margin-top:4px;">$${payload.price}</div>
                  </td>
                  <td style="padding:14px 18px;border-bottom:1px solid #1a1f2a;border-left:1px solid #1a1f2a;width:50%;">
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Timeframe</div>
                    <div style="font-size:15px;color:#ffffff;font-weight:700;margin-top:4px;">${payload.timeframe}</div>
                  </td>
                </tr>
                ${payload.indicator ? `
                <tr>
                  <td style="padding:14px 18px;width:50%;" ${payload.level !== undefined ? '' : 'colspan="2"'}>
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Indicator</div>
                    <div style="font-size:15px;color:#ffffff;font-weight:700;margin-top:4px;">${payload.indicator}</div>
                  </td>
                  ${payload.level !== undefined ? `
                  <td style="padding:14px 18px;border-left:1px solid #1a1f2a;width:50%;">
                    <div style="font-size:10px;color:#6b7585;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Level</div>
                    <div style="font-size:15px;color:#f59f18;font-weight:700;margin-top:4px;">$${payload.level}</div>
                  </td>` : ''}
                </tr>` : ''}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 28px;border-top:1px solid #1a1f2a;">
              <div style="font-size:11px;color:#4a5568;text-align:center;">
                Sent by Black Terminal Alert Engine &bull; Do not reply to this email
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendResendEmail(payload: AlertEmailPayload): Promise<{ success: boolean; error?: string }> {
  if (!isResendConfigured) {
    return { success: false, error: "Resend API key not configured" };
  }

  if (!payload.to?.trim()) {
    return { success: false, error: "No recipient email provided" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [payload.to.trim()],
        subject: `🔔 Alert: ${payload.alertName} — ${payload.symbol} @ $${payload.price}`,
        html: buildAlertEmailHtml(payload)
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = (errBody as any)?.message || response.statusText;
      console.error("Resend API error:", errMsg);
      return { success: false, error: errMsg };
    }

    const result = await response.json();
    console.log("Resend email sent:", (result as any)?.id);
    return { success: true };
  } catch (err) {
    console.error("Resend email failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function sendVerificationEmail(to: string, username: string, code: string): Promise<{ success: boolean; error?: string }> {
  if (!isResendConfigured) {
    return { success: false, error: "Resend API key not configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to.trim()],
        subject: `🔐 Black Terminal - Verify Your Registration`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0c0f;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c0f;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#12161c;border-radius:12px;border:1px solid #1e2530;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#ff0044 0%,#cc0033 100%);padding:20px 28px;">
              <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">⚡ BLACK TERMINAL</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">Security & Account Verification</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 28px;">
              <div style="font-size:22px;font-weight:700;color:#ffffff;margin-bottom:16px;">Verify Your Identity</div>
              <div style="font-size:14px;color:#a8b2c1;line-height:1.6;margin-bottom:24px;">
                Hi <strong>${username}</strong>,<br><br>
                Thank you for signing up to Black Terminal. To complete your registration and secure your node connection, please use the 6-digit verification code below:
              </div>
              <!-- Code Box -->
              <div style="background:#0d1017;border:1px solid #1a1f2a;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
                <span style="font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;color:#00ff66;letter-spacing:6px;">${code}</span>
              </div>
              <div style="font-size:12px;color:#6b7585;line-height:1.5;">
                This code is valid for 10 minutes. If you did not request this verification, you can safely ignore this email.
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 28px;border-top:1px solid #1a1f2a;">
              <div style="font-size:11px;color:#4a5568;text-align:center;">
                Sent by Black Terminal Security Engine &bull; Do not reply to this email
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = (errBody as any)?.message || response.statusText;
      return { success: false, error: errMsg };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

