import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { preview } from "vite";

class CdpClient {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws?.close(); }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const hours = Math.max(0.001, Number(args.hours ?? process.env.PERF_SOAK_HOURS ?? 1));
const intervalMs = Math.max(1000, Number(args.intervalMs ?? process.env.PERF_SOAK_INTERVAL_MS ?? 10_000));
const port = Number(process.env.PERF_SOAK_PORT ?? 4173);
const url = args.url ?? process.env.PERF_SOAK_URL ?? `http://127.0.0.1:${port}/?perfHarness=1`;
const startedAt = Date.now();
const outputDir = join(root, "docs", "performance");
const runId = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
const outputFile = join(outputDir, `soak-${runId}.jsonl`);
const summaryFile = join(outputDir, `soak-${runId}-summary.json`);
const browserProfile = join(root, ".perf-browser-profile");
mkdirSync(outputDir, { recursive: true });
safeRemove(browserProfile);
writeFileSync(outputFile, "");

const server = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true } });

let browser;
let cdp;
try {
  await waitForHttp(url, 45_000);
  const browserPath = findBrowser();
  const debuggingPort = 9400 + Math.floor(Math.random() * 300);
  browser = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${browserProfile}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, 30_000);
  const page = await createPage(debuggingPort, url);
  cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await sleep(3000);
  await installHarnessSession(cdp);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForCockpit(cdp, 45_000);

  const measurementStartedAt = Date.now();
  let sampleIndex = 0;
  while (Date.now() - measurementStartedAt < hours * 3600000) {
    await performSafeInteraction(cdp, sampleIndex);
    const sample = await collectBrowserSample(cdp, sampleIndex);
    appendFileSync(outputFile, `${JSON.stringify(sample)}\n`);
    process.stdout.write(`\r${sample.time} heap=${format(sample.heapUsedMb)}MB dom=${sample.domNodes} p95=${format(sample.telemetry?.p95FrameMs)}ms status=${sample.telemetry?.status ?? "n/a"}`);
    sampleIndex += 1;
    await sleep(intervalMs);
  }

  const samples = readJsonLines(outputFile);
  const summary = buildSummary(samples, { hours, intervalMs, url, startedAt: measurementStartedAt });
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSoak report: ${relative(root, summaryFile)}`);
  if (!summary.pass) process.exitCode = 1;
} finally {
  cdp?.close();
  browser?.kill();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await sleep(1500);
  safeRemove(browserProfile);
}

async function installHarnessSession(client) {
  const user = {
    username: "performance_harness",
    displayName: "Performance Harness",
    role: "admin",
    productTier: "admin",
    permissions: ["admin.override"],
    allowedIndicators: ["volumeProfile"],
    emailVerified: true,
    authSessionReady: false
  };
  await client.evaluate(`localStorage.setItem("bt_current_user", ${JSON.stringify(JSON.stringify(user))}); localStorage.setItem("bt_active_nav", "CHART");`);
}

async function performSafeInteraction(client, index) {
  const actions = [
    `document.querySelector("canvas")?.dispatchEvent(new WheelEvent("wheel", { deltaY: ${index % 2 ? 120 : -120}, clientX: 500, clientY: 300, bubbles: true, cancelable: true }))`,
    `document.querySelector("canvas")?.dispatchEvent(new PointerEvent("pointermove", { clientX: ${300 + index % 400}, clientY: ${180 + index % 260}, bubbles: true }))`,
    `(() => { const labels=["POSITIONS","CHART","MARKET OVERVIEW","CHART"]; const text=labels[${index} % labels.length]; [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)?.click(); })()`,
    `document.querySelector('button[title="Open DOM Pro+"]')?.click()`,
    `document.querySelector('button[title="Close DOM Pro+"]')?.click()`,
    `window.dispatchEvent(new Event("black-terminal-layout-resize"))`
  ];
  await client.evaluate(actions[index % actions.length]);
}

async function collectBrowserSample(client, index) {
  const value = await client.evaluate(`(() => {
    const memory = performance.memory;
    const telemetry = window.__BLACK_TERMINAL_PERFORMANCE__?.snapshot?.() ?? null;
    return {
      time: new Date().toISOString(),
      index: ${index},
      heapUsedMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      heapTotalMb: memory ? memory.totalJSHeapSize / 1048576 : null,
      domNodes: document.getElementsByTagName("*").length,
      cockpitReady: Boolean(document.querySelector("canvas") && document.querySelector(".app-shell")),
      telemetry
    };
  })()`);
  return value;
}

function buildSummary(samples, context) {
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  const p95Frames = samples.map((sample) => sample.telemetry?.p95FrameMs).filter(Number.isFinite).sort((a, b) => a - b);
  const heapGrowthMb = finite(last.heapUsedMb) - finite(first.heapUsedMb);
  const domGrowth = finite(last.domNodes) - finite(first.domNodes);
  const resourceGrowth = resourceDelta(first.telemetry?.resources?.active, last.telemetry?.resources?.active);
  const checks = {
    samplesCollected: samples.length >= Math.max(2, Math.floor(context.hours * 3600000 / context.intervalMs * 0.8)),
    cockpitStayedReady: samples.length > 0 && samples.every((sample) => sample.cockpitReady),
    heapBounded: heapGrowthMb < 128,
    domBounded: domGrowth < 1000,
    websocketBounded: (resourceGrowth.websocket ?? 0) <= 1,
    workerBounded: (resourceGrowth.worker ?? 0) <= 1,
    listenersBounded: (resourceGrowth.listener ?? 0) <= 2,
    p95FrameBounded: percentile(p95Frames, 0.95) < 100
  };
  return {
    generatedAt: new Date().toISOString(),
    requestedHours: context.hours,
    actualDurationMs: Date.now() - context.startedAt,
    url: context.url,
    sampleCount: samples.length,
    heapGrowthMb,
    domGrowth,
    resourceGrowth,
    p95OfFrameP95Ms: percentile(p95Frames, 0.95),
    checks,
    pass: Object.values(checks).every(Boolean),
    note: "The harness performs chart/panel interactions and never invokes order submission."
  };
}

function findBrowser() {
  const candidates = process.platform === "win32"
    ? [
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`
      ]
    : ["google-chrome", "chromium", "brave-browser"];
  const found = candidates.find((candidate) => process.platform !== "win32" || exists(candidate));
  if (!found) throw new Error("A Chromium browser is required for perf:soak.");
  return found;
}

async function createPage(port, targetUrl) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`CDP page creation failed: ${response.status}`);
  return response.json();
}

async function waitForCockpit(client, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await client.evaluate(`Boolean(document.querySelector("canvas") && document.querySelector(".app-shell"))`);
    if (ready) return;
    await sleep(500);
  }
  const diagnostic = await client.evaluate(`({
    href: location.href,
    storedUser: localStorage.getItem("bt_current_user"),
    body: document.body?.innerText?.slice(0, 500)
  })`);
  throw new Error(`Performance cockpit did not become ready: ${JSON.stringify(diagnostic)}`);
}

async function waitForHttp(target, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(target); if (response.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

function readJsonLines(file) {
  return readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function resourceDelta(first = {}, last = {}) {
  const result = {};
  for (const key of new Set([...Object.keys(first), ...Object.keys(last)])) result[key] = finite(last[key]) - finite(first[key]);
  return result;
}
function percentile(values, pct) { return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * pct) - 1)] : 0; }
function finite(value) { return Number.isFinite(value) ? value : 0; }
function format(value) { return Number.isFinite(value) ? value.toFixed(1) : "n/a"; }
function exists(path) { try { return existsSync(path); } catch { return false; } }
function safeRemove(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
