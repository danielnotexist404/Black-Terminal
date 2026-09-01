import assert from "node:assert/strict";
import { buildLocalAlertEmail, assertLocalEmailDelivery, defaultLocalEmailProvider, normalizeLocalEmailProviderSettings } from "../src/core/local-runtime/localEmailModel.ts";

const provider = normalizeLocalEmailProviderSettings({
  ...defaultLocalEmailProvider,
  enabled: true,
  smtpHost: " SMTP.Example.COM ",
  smtpPort: 587,
  transport: "STARTTLS",
  fromAddress: "alerts@example.com",
});
assert.equal(provider.smtpHost, "smtp.example.com");
assert.equal(provider.transport, "STARTTLS");
assert.throws(() => normalizeLocalEmailProviderSettings({ ...provider, smtpPort: 25 }), /encrypted SMTP submission port/);
assert.throws(() => normalizeLocalEmailProviderSettings({ ...provider, fromAddress: "not-an-address" }), /valid sender email/);

const rendered = buildLocalAlertEmail({
  alertName: "Breakout\r\nBcc: attacker@example.com",
  symbol: "BTCUSDT\nInjected",
  exchange: "Bybit",
  timeframe: "5m",
  price: 80_000,
  message: "Closed-candle breakout confirmed",
  timestamp: "2026-09-01T12:00:00.000Z",
});
assert.equal(rendered.subject, "[Black Terminal] Breakout  Bcc: attacker@example.com · BTCUSDT Injected");
assert.doesNotMatch(rendered.subject, /[\r\n]/);
assert.match(rendered.body, /Exchange: Bybit/);
assertLocalEmailDelivery("owner@example.com", rendered.subject, rendered.body);
assert.throws(() => assertLocalEmailDelivery("bad-address", rendered.subject, rendered.body), /recipient/);
assert.throws(() => assertLocalEmailDelivery("owner@example.com", "Subject\r\nBcc: bad@example.com", rendered.body), /subject/);
assert.throws(() => assertLocalEmailDelivery("owner@example.com", "Subject", "api_secret: forbidden"), /Broker secrets/);
assert.throws(() => assertLocalEmailDelivery("owner@example.com", "Subject", "x".repeat(65 * 1024)), /64 KiB/);

console.log("Local email runtime tests passed: provider validation, header injection defense, secret guard, body limit, and deterministic alert rendering.");
