import assert from "node:assert/strict";
import { apiRouteManifest, resolveApiRoute } from "../server/black-cloud/api-router.js";

assert.equal(resolveApiRoute("/api/claude").handler instanceof Function, true);
assert.deepEqual(resolveApiRoute("/api/cloud-execution/status").params, { path: ["status"] });
assert.deepEqual(resolveApiRoute("/api/event-alpha/events/00000000-0000-0000-0000-000000000001").params, { path: ["events", "00000000-0000-0000-0000-000000000001"] });
assert.deepEqual(resolveApiRoute("/api/network/professional-center").params, { resource: "professional-center" });
assert.deepEqual(resolveApiRoute("/api/network/investment-groups/group-1/messages").params, { groupId: "group-1", action: "messages" });
assert.deepEqual(resolveApiRoute("/api/liquidation-intelligence/manifest").params, { action: "bclif", bclifAction: "manifest" });
assert.equal(resolveApiRoute("/api/not-real"), null);
assert.equal(apiRouteManifest().exact.length, 4);
assert.equal(apiRouteManifest().dynamic.length, 10);

console.log("Black Cloud central API route compatibility tests passed (13 Vercel functions mapped without serverless fan-out)." );
