import assert from "node:assert/strict";
import { TokenUnlockSourceAdapter } from "../server/event-alpha/token-unlock-adapter.js";

const disabled = new TokenUnlockSourceAdapter();
assert.deepEqual(disabled.health(), { status: "DISABLED", reasonCode: "SOURCE_CONFIGURATION_MISSING" });

const calls = [];
const adapter = new TokenUnlockSourceAdapter({
  sourceKey: "TOKEN_PROVIDER",
  url: "https://events.example.test/unlocks",
  apiToken: "secret-token",
  allowedHosts: ["events.example.test"]
}, async (url, options) => {
  calls.push({ url: String(url), authorization: options.headers.authorization });
  return new Response(JSON.stringify({
    events: [{
      id: "event-1",
      observedAt: "2026-08-01T00:00:00Z",
      firstActionableAt: "2026-08-01T00:00:00Z",
      publishedAt: "2026-08-01T00:00:00Z",
      sequence: 7,
      payload: { assetId: "ABC", symbol: "ABCUSDT", eventTime: "2026-08-02T00:00:00Z", unlockTokens: 10, circulatingSupply: 100, beneficiaryClass: "TEAM" }
    }],
    nextCursor: "cursor-2",
    watermarkAt: "2026-08-01T00:00:01Z"
  }), { status: 200, headers: { "content-type": "application/json" } });
});
assert.deepEqual(adapter.health(), { status: "READY", reasonCode: null });
const result = await adapter.poll({ cursorValue: "cursor-1" });
assert.equal(result.envelopes.length, 1);
assert.equal(result.checkpoint.cursorValue, "cursor-2");
assert.match(calls[0].url, /cursor=cursor-1/);
assert.equal(calls[0].authorization, "Bearer secret-token");
assert.throws(() => new TokenUnlockSourceAdapter({ url: "http://events.example.test", apiToken: "x", allowedHosts: ["events.example.test"] }).assertUrl("http://events.example.test"), /HTTPS/);
assert.throws(() => adapter.assertUrl("https://evil.example.test/unlocks"), /allowlisted/);
assert.throws(() => new TokenUnlockSourceAdapter({ url: "https://127.0.0.1/events", apiToken: "x", allowedHosts: ["127.0.0.1"] }).assertUrl("https://127.0.0.1/events"), /private infrastructure/);

const invalidContentType = new TokenUnlockSourceAdapter({
  url: "https://events.example.test/unlocks", apiToken: "x", allowedHosts: ["events.example.test"]
}, async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
await assert.rejects(() => invalidContentType.poll(), /must return JSON/);

const missingEvidenceTime = new TokenUnlockSourceAdapter({
  url: "https://events.example.test/unlocks", apiToken: "x", allowedHosts: ["events.example.test"]
}, async () => new Response(JSON.stringify({ events: [{ id: "event-2", payload: { assetId: "ABC", symbol: "ABCUSDT", eventTime: "2026-08-02T00:00:00Z", unlockTokens: 10, circulatingSupply: 100 } }] }), { status: 200, headers: { "content-type": "application/json" } }));
await assert.rejects(() => missingEvidenceTime.poll(), /required provider evidence/);

console.log("Event Alpha source adapter tests PASS — disabled mode, checkpoint, schema, HTTPS, and host allowlist verified.");
