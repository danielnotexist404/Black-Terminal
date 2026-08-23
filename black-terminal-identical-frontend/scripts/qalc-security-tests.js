import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleQalcRequest } from "../server/qalc/service.js";

const files = [
  "server/qalc/engine.ts", "server/qalc/paper-broker.ts", "scripts/qalc-worker.ts",
  "server/qalc/service.js", "src/modules/strategy-lab/qalc/QalcExperience.tsx",
];
const source = (await Promise.all(files.map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")))).join("\n");
assert.doesNotMatch(source, /createCloudExchangeAdapter|bybitRequest\([^)]*(create|amend|cancel)|\/v5\/order\/(create|amend|cancel)/i, "QALC must have no broker mutation path");
assert.doesNotMatch(source, /\/withdraw|withdraw\s*\(|withdrawalCapability:\s*true/i, "QALC implementation must not introduce withdrawal capability");
assert.match(source, /liveExecutionEnabled:\s*false/);
assert.match(source, /groupFanoutEnabled:\s*false/);

const response = mockResponse();
await assert.rejects(
  () => handleQalcRequest({ method: "POST", body: { state: "ACTIVE" } }, response, securityFixture(), ["strategies", "00000000-0000-4000-8000-000000000001", "state"]),
  /Event replay certification is required/,
);
console.log("QALC security contracts passed: no live broker mutation path, no withdrawal surface, fail-closed certification gate.");

function securityFixture() {
  const row = { id: "00000000-0000-4000-8000-000000000001", user_id: "user-1", mode: "PAPER", certification_state: "RESEARCH" };
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
  return { user: { id: "user-1" }, identity: { role: "user" }, supabase: { from: () => chain } };
}
function mockResponse() { return { status() { return this; }, json(value) { this.body = value; return this; } }; }
