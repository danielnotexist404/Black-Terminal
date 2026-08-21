import assert from "node:assert/strict";
import { resolveEventAlphaReadiness } from "../src/modules/event-alpha/readiness.ts";
import type { EventAlphaRuntimeConfig } from "../src/modules/event-alpha/eventAlphaApi.ts";

const disabled = config();
assert.equal(resolveEventAlphaReadiness({ config: disabled, eventCount: 0, sources: [] }).state, "NOT_CONFIGURED");
assert.equal(resolveEventAlphaReadiness({ config: disabled, eventCount: 2, sources: [] }).state, "DISABLED");

const engineOnly = config({ engineEnabled: true });
assert.equal(resolveEventAlphaReadiness({ config: engineOnly, eventCount: 0, sources: [] }).state, "WAITING_FOR_SOURCE");

const sourceConfigured = config({
  engineEnabled: true,
  ingestionEnabled: true,
  tokenSupplyEnabled: true,
  tokenUnlockSourceConfigured: true
});
assert.equal(resolveEventAlphaReadiness({ config: sourceConfigured, eventCount: 0, sources: [] }).state, "WAITING_FOR_WORKER");
assert.equal(resolveEventAlphaReadiness({
  config: sourceConfigured,
  eventCount: 1,
  sources: [source("HEALTHY")]
}).state, "ACTIVE");
assert.equal(resolveEventAlphaReadiness({
  config: sourceConfigured,
  eventCount: 1,
  sources: [source("DEGRADED")]
}).state, "DEGRADED");

function config(overrides: Partial<EventAlphaRuntimeConfig> = {}): EventAlphaRuntimeConfig {
  return {
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
    llmExtractionConfigurationRejected: false,
    architecture: "SERVER_AUTHORITY",
    executionMode: "DISABLED",
    directBrokerFanout: false,
    llmOrderAuthority: false,
    ...overrides
  };
}

function source(health_status: string) {
  return {
    source_key: "TOKEN_UNLOCK_PRIMARY",
    event_family: "TOKEN_SUPPLY",
    enabled: true,
    health_status,
    last_success_at: null,
    last_error_at: null,
    safe_error_code: null,
    updated_at: "2026-08-21T00:00:00.000Z"
  };
}

console.log("Event Alpha deployment-readiness state tests PASS.");
