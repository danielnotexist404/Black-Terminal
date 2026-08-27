import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "api/event-alpha/[...path].js",
  "server/event-alpha/domain.js",
    "server/event-alpha/engine.js",
    "server/event-alpha/pead-engine.js",
    "server/event-alpha/pead-source-adapter.js",
  "server/event-alpha/repository.js",
  "server/event-alpha/service.js",
  "server/event-alpha/token-unlock-adapter.js",
  "server/event-alpha/worker.js",
  "src/modules/event-alpha/eventAlphaApi.ts",
  "src/modules/event-alpha/EventAlphaWorkspace.tsx"
];
const source = files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const api = fs.readFileSync(path.join(root, "api/event-alpha/[...path].js"), "utf8");
const service = fs.readFileSync(path.join(root, "server/event-alpha/service.js"), "utf8");
assert.match(api, /requireApiSecurity/, "Event Alpha API must use the hardened auth/rate-limit boundary");
assert.match(service, /requireAdmin\(security\.identity\)/, "all Event Alpha mutations require server-verified admin authority");
assert.match(service, /resource === "paper-state"[\s\S]*?requireAdmin\(security\.identity\)/, "paper positions and orders require administrative read authority");
assert.match(service, /PAPER_FILL_ATTRIBUTION[\s\S]*?canonical_event_id/, "paper fill attribution retains the canonical event correlation chain");
assert.match(service, /EVENT_ALPHA_PAPER_FILL_IDENTITY_COLLISION/, "duplicate fill keys must be reconciled, never blindly acknowledged");
assert.match(service, /ADMIN_SECONDARY_/, "manual evidence cannot overwrite a configured provider identity");
assert.match(service, /mode:\s*"PAPER"/, "trade intent mode is paper only");
assert.doesNotMatch(source, /placeOrder|submitOrder|cancelOrder|modifyOrder|brokerAdapter|fetch\([^)]*bybit/i, "Event Alpha must not fan out directly to a broker");
assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|EVENT_ALPHA_TOKEN_UNLOCK_API_TOKEN[^\n]*console/i, "client/source must not expose server secrets");
assert.match(source, /llmOrderAuthority:\s*false/, "LLM order authority must be explicitly false");
assert.match(source, /liveExecutionEnabled:\s*false/, "live execution must be structurally false");
assert.doesNotMatch(source, /window\.prompt|\bprompt\s*\(/, "Event Alpha must not use blocking browser authorization prompts");

console.log("Event Alpha security contracts PASS — auth, admin mutation, paper-only, no broker fan-out, and no LLM/live authority verified.");
