import assert from "node:assert/strict";
import { normalizePath } from "../api/event-alpha/[...path].js";
import { eventAlphaRuntimeConfig } from "../server/event-alpha/domain.js";

assert.deepEqual(normalizePath(["events", "abc", "assess"], { url: "" }), ["events", "abc", "assess"]);
assert.deepEqual(normalizePath(undefined, { url: "/api/event-alpha/feed?limit=10" }), ["feed"]);
assert.deepEqual(normalizePath(undefined, { url: "/api/event-alpha/%E0%A4%A" }), [], "malformed URL encoding fails closed");

assert.deepEqual(eventAlphaRuntimeConfig({}), {
  engineEnabled: false,
  ingestionEnabled: false,
  tokenSupplyEnabled: false,
  paperExecutionEnabled: false,
  paperExecutionConfigurationRejected: false,
  liveExecutionEnabled: false,
  liveExecutionConfigurationRejected: false,
  manualApprovalRequired: true,
  manualApprovalConfigurationRejected: false,
  strategyKillSwitchEngaged: true,
  globalExecutionKillSwitchEngaged: true,
  tokenUnlockSourceConfigured: false,
  governanceAdapterEnabled: false,
  governanceConfigurationRequested: false,
  protocolEconomicsAdapterEnabled: false,
  protocolEconomicsConfigurationRequested: false,
  llmExtractionEnabled: false,
  llmExtractionConfigurationRejected: false
});
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_PAPER_EXECUTION_ENABLED: "true" }).paperExecutionEnabled, false, "paper cannot run while engine is disabled");
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_ENGINE_ENABLED: "true", EVENT_ALPHA_PAPER_EXECUTION_ENABLED: "true", EVENT_ALPHA_STRATEGY_KILL_SWITCH: "false", EVENT_ALPHA_GLOBAL_EXECUTION_KILL_SWITCH: "false" }).paperExecutionEnabled, true);
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_ENGINE_ENABLED: "true", EVENT_ALPHA_INGESTION_ENABLED: "true", EVENT_ALPHA_TOKEN_SUPPLY_ENABLED: "true" }).tokenSupplyEnabled, true);
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_LIVE_EXECUTION_ENABLED: "true" }).liveExecutionEnabled, false, "live remains structurally unavailable");
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_LIVE_EXECUTION_ENABLED: "true" }).liveExecutionConfigurationRejected, true);
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_MANUAL_APPROVAL_REQUIRED: "false" }).manualApprovalConfigurationRejected, true, "unsafe approval override is rejected");
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_REQUIRE_MANUAL_APPROVAL: "false" }).manualApprovalConfigurationRejected, true, "canonical unsafe approval override is rejected");
assert.equal(eventAlphaRuntimeConfig({ EVENT_ALPHA_LLM_EXTRACTION_ENABLED: "true" }).llmExtractionConfigurationRejected, true, "unimplemented LLM extraction cannot be enabled");

console.log("Event Alpha API/config tests PASS — route normalization and fail-closed rollout policy verified.");
