import { createServer, type Server } from "node:http";
import type { BclifCollectorPhase, BclifDegradedState, BclifSourceHealth } from "../contracts.ts";
import type { BclifMetricRegistry } from "../metrics/registry.ts";

export type BclifReadinessPrerequisite = "configuration" | "database" | "schema" | "storage" | "adapters" | "checkpoint" | "identity" | "clock";
const REQUIRED: BclifReadinessPrerequisite[] = ["configuration", "database", "schema", "storage", "adapters", "checkpoint", "identity", "clock"];
const TERMINAL = new Set<BclifCollectorPhase>(["CONFIGURATION_ERROR", "SCHEMA_MISMATCH", "STORAGE_UNAVAILABLE", "CHECKPOINT_CORRUPT", "MODEL_VERSION_UNSUPPORTED", "FATAL", "STOPPED"]);

export class BclifHealthState {
  private phaseValue: BclifCollectorPhase = "PROCESS_STARTING";
  private readonly prerequisites = new Map<BclifReadinessPrerequisite, { ok: boolean; detail: string | null }>();
  private readonly sources = new Map<string, BclifSourceHealth>();
  private readonly degraded = new Map<BclifDegradedState, Set<string>>();
  private startedAt = Date.now();
  private safeMetadata: Record<string, unknown> = {};

  phase() { return this.phaseValue; }
  setPhase(phase: BclifCollectorPhase) { this.phaseValue = phase; }
  prerequisite(name: BclifReadinessPrerequisite, ok: boolean, detail: string | null = null) { this.prerequisites.set(name, { ok, detail }); }
  source(name: string, health: BclifSourceHealth) { this.sources.set(name, { ...health }); }
  degrade(state: BclifDegradedState, active = true, scope = "GLOBAL") {
    const scopes = this.degraded.get(state) || new Set<string>();
    if (active) scopes.add(scope);
    else scopes.delete(scope);
    if (scopes.size) this.degraded.set(state, scopes);
    else this.degraded.delete(state);
  }
  metadata(value: Record<string, unknown>) { this.safeMetadata = { ...value }; }

  live() { return !TERMINAL.has(this.phaseValue); }
  ready() {
    return !TERMINAL.has(this.phaseValue)
      && REQUIRED.every((name) => this.prerequisites.get(name)?.ok === true)
      // SOURCE_SYNCHRONIZING is deliberately not ready. A listening socket is
      // not evidence that subscriptions were acknowledged, an order-book
      // snapshot was applied, or an as-of frame was successfully produced.
      && this.phaseValue === "LIVE";
  }

  snapshot() {
    return {
      status: this.ready() ? (this.degraded.size ? "degraded" : "ready") : this.live() ? "starting" : "stopped",
      phase: this.phaseValue,
      live: this.live(),
      ready: this.ready(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt),
      degraded: [...this.degraded.keys()].sort(),
      degradedScopes: Object.fromEntries([...this.degraded.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([state, scopes]) => [state, [...scopes].sort()])),
      prerequisites: Object.fromEntries(REQUIRED.map((name) => [name, this.prerequisites.get(name) || { ok: false, detail: "not checked" }])),
      sources: Object.fromEntries([...this.sources.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...this.safeMetadata
    };
  }
}

export function createBclifHealthServer(state: BclifHealthState, metrics: BclifMetricRegistry): Server {
  return createServer((request, response) => {
    const path = (request.url || "").split("?", 1)[0];
    if (path === "/metrics") {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
      response.end(metrics.prometheus());
      return;
    }
    if (path !== "/health/live" && path !== "/health/ready" && path !== "/live" && path !== "/ready") {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const readyRequest = path.endsWith("/ready") || path === "/ready";
    const ok = readyRequest ? state.ready() : state.live();
    response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(state.snapshot()));
  });
}
