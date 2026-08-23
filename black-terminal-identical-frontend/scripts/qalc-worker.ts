import { randomUUID } from "node:crypto";
import { QalcEventArchive } from "../server/qalc/archive.ts";
import { QalcBybitGateway, type QalcGatewayStatus } from "../server/qalc/bybit-gateway.ts";
import type { QalcConfig, QalcMarketEvent, QalcSymbol } from "../server/qalc/contracts.ts";
import { QalcEngine } from "../server/qalc/engine.ts";
import { QalcStateStore } from "../server/qalc/state-store.ts";

const symbol = requiredSymbol(process.env.QALC_SYMBOL || "BTCUSDT");
const mode = modeValue(process.env.QALC_MODE || "RESEARCH");
const paperEnabled = process.env.QALC_PAPER_ENABLED === "true";
const archiveRoot = process.env.QALC_ARCHIVE_ROOT || "/var/lib/black-terminal/qalc/events";
const statePath = process.env.QALC_STATE_PATH || "/var/lib/black-terminal/qalc/state/current.json";
const runId = process.env.QALC_RUN_ID || randomUUID();

if (process.env.QALC_LIVE_EXECUTION_ENABLED === "true" || process.env.QALC_GROUP_FANOUT_ENABLED === "true") {
  throw new Error("QALC_SECURITY_BOUNDARY: live execution and group fanout are not implemented and must remain false.");
}
if (mode === "PAPER" && !paperEnabled) throw new Error("QALC_PAPER_MODE_REQUIRES_EXPLICIT_ENABLE");

let gatewayStatus: QalcGatewayStatus | undefined;
let stopped = false;
let flushInFlight = false;
let instrument = { tickSize: 0, quantityStep: 0 };
const config: Partial<QalcConfig> = {
  strategyId: process.env.QALC_STRATEGY_ID || "qalc-vps-research",
  runId, symbol, mode, paperEnabled: mode === "PAPER" && paperEnabled,
  shadowEnabled: mode === "SHADOW", liveExecutionEnabled: false, groupFanoutEnabled: false,
};
let engine = new QalcEngine(config, instrument);
const archive = new QalcEventArchive(archiveRoot, symbol, runId);
const stateStore = new QalcStateStore(statePath);
const gateway = new QalcBybitGateway({
  symbol,
  onState: (status) => {
    gatewayStatus = status;
    if (["CONNECTING", "RECONNECTING", "STALE"].includes(status.state)) engine.book.markSnapshotPending();
    if (status.state === "FAILED") engine.book.markFailed();
  },
  onEvent: async (event) => {
    await archive.append(event);
    const telemetry = engine.process(event);
    if (telemetry.runtimeState === "BOOK_GAP") gateway.resynchronize("QALC_BOOK_GAP");
  },
});

try {
  const discovered = await gateway.fetchInstrument();
  instrument = { tickSize: discovered.tickSize, quantityStep: discovered.quantityStep };
  engine = new QalcEngine(config, instrument);
  await ingestInstrument(discovered);
} catch (error) {
  log("warn", "qalc_instrument_discovery_failed", { message: safeError(error) });
}

await sampleClock();
const clockTimer = setInterval(() => void sampleClock(), 10_000);
const instrumentTimer = setInterval(() => void refreshInstrument(), 6 * 60 * 60 * 1_000);
const stateTimer = setInterval(() => void flushState(), 250);
gateway.start();
log("info", "qalc_worker_started", { symbol, mode, paperEnabled: config.paperEnabled, runId });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(signal));
process.on("uncaughtException", (error) => { log("critical", "qalc_uncaught_exception", { message: safeError(error) }); void shutdown("uncaughtException", 1); });
process.on("unhandledRejection", (error) => { log("critical", "qalc_unhandled_rejection", { message: safeError(error) }); void shutdown("unhandledRejection", 1); });

async function sampleClock() {
  try {
    const sample = await gateway.fetchServerTime();
    const health = engine.observeClock(sample.serverTimeMs, sample.sentAt, sample.receivedAt);
    if (health.state !== "CLOCK_SAFE") log("warn", "qalc_clock_not_safe", { state: health.state, offsetMs: rounded(health.offsetMs), driftMsPerMinute: rounded(health.driftMsPerMinute) });
  } catch (error) { log("error", "qalc_clock_probe_failed", { message: safeError(error) }); }
}

async function refreshInstrument() {
  try { await ingestInstrument(await gateway.fetchInstrument()); }
  catch (error) { log("error", "qalc_instrument_refresh_failed", { message: safeError(error) }); }
}

async function ingestInstrument(payload: QalcMarketEvent["payload"]) {
  const now = Date.now();
  const event: QalcMarketEvent = { id: `bybit:${symbol}:instrument:${(payload as { version?: string }).version || now}`, venue: "BYBIT", category: "linear", symbol, eventType: "INSTRUMENT", exchangeTimestamp: now, receiveTimestamp: now, processTimestamp: now, payloadVersion: 1, payload };
  await archive.append(event);
  engine.process(event);
}

async function flushState() {
  if (flushInFlight || stopped) return;
  flushInFlight = true;
  try {
    const telemetry = engine.telemetry();
    telemetry.counters.gateway_reconnects = gatewayStatus?.reconnects || 0;
    telemetry.counters.gateway_live = gatewayStatus?.state === "LIVE" ? 1 : 0;
    await stateStore.write(telemetry);
  } catch (error) { log("error", "qalc_state_flush_failed", { message: safeError(error) }); }
  finally { flushInFlight = false; }
}

async function shutdown(signal: string, exitCode = 0) {
  if (stopped) return;
  stopped = true;
  clearInterval(clockTimer);
  clearInterval(instrumentTimer);
  clearInterval(stateTimer);
  gateway.stop();
  try { await stateStore.write(engine.telemetry()); await archive.close(); }
  catch (error) { log("error", "qalc_shutdown_flush_failed", { message: safeError(error) }); exitCode = 1; }
  log("info", "qalc_worker_stopped", { signal });
  process.exit(exitCode);
}

function requiredSymbol(value: string): QalcSymbol { const clean = value.toUpperCase(); if (clean !== "BTCUSDT" && clean !== "ETHUSDT") throw new Error("QALC_SYMBOL_NOT_ALLOWED"); return clean; }
function modeValue(value: string): QalcConfig["mode"] { const clean = value.toUpperCase(); if (!["RESEARCH", "REPLAY", "PAPER", "SHADOW"].includes(clean)) throw new Error("QALC_MODE_INVALID"); return clean as QalcConfig["mode"]; }
function safeError(error: unknown) { return String(error instanceof Error ? error.message : error || "QALC_ERROR").replace(/(authorization|password|secret|token|api.?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 240); }
function rounded(value: number) { return Number.isFinite(value) ? Number(value.toFixed(3)) : null; }
function log(level: string, event: string, fields: Record<string, unknown> = {}) { console.log(JSON.stringify({ level, event, service: "black-core-qalc", time: new Date().toISOString(), ...fields })); }
