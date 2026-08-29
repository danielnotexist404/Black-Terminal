import assert from "node:assert/strict";
import { apiRouteManifest, resolveApiRoute } from "../server/black-cloud/api-router.js";

assert.equal(resolveApiRoute("/api/claude").handler instanceof Function, true);
assert.equal(resolveApiRoute("/api/institutional-flow").handler instanceof Function, true);
assert.deepEqual(resolveApiRoute("/api/market-flow/cvd-bars").params, { action: "cvd-bars" });
assert.deepEqual(resolveApiRoute("/api/cloud-execution/status").params, { path: ["status"] });
assert.deepEqual(resolveApiRoute("/api/event-alpha/events/00000000-0000-0000-0000-000000000001").params, { path: ["events", "00000000-0000-0000-0000-000000000001"] });
assert.deepEqual(resolveApiRoute("/api/network/professional-center").params, { resource: "professional-center" });
assert.deepEqual(resolveApiRoute("/api/network/investment-groups/group-1/messages").params, { groupId: "group-1", action: "messages" });
assert.deepEqual(resolveApiRoute("/api/liquidation-intelligence/manifest").params, { action: "bclif", bclifAction: "manifest" });
assert.deepEqual(resolveApiRoute("/api/strategies/00000000-0000-4000-8000-000000000001/targets").params, { path: ["00000000-0000-4000-8000-000000000001", "targets"] });
assert.deepEqual(resolveApiRoute("/api/strategy-connections/connect").params, { path: ["connect"] });
assert.equal(resolveApiRoute("/api/strategy-connections").handler instanceof Function, true);
assert.deepEqual(resolveApiRoute("/api/qalc/strategies/00000000-0000-4000-8000-000000000001/state").params, { path: ["strategies", "00000000-0000-4000-8000-000000000001", "state"] });
assert.equal(resolveApiRoute("/api/not-real"), null);
assert.equal(apiRouteManifest().exact.length, 7);
assert.equal(apiRouteManifest().dynamic.length, 14);

console.log("Black Cloud central API route compatibility tests passed (18 route families mapped without serverless fan-out)." );
