import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { preview } from "vite";

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? pending?.reject(new Error(message.error.message)) : pending?.resolve(message.result);
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
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  close() { this.ws?.close(); }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const requestedMs = Math.max(10_000, Number(args.hours ?? 0) * 3_600_000 || Number(args.minutes ?? 30) * 60_000);
const baseline = args.baseline === "true";
const outputDir = join(root, "docs", "performance");
const outputFile = join(outputDir, baseline ? "dom-pro-final-baseline.json" : `dom-pro-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const profile = join(root, ".dom-pro-perf-profile");
const port = Number(process.env.DOM_PRO_PERF_PORT ?? 4186);
mkdirSync(outputDir, { recursive: true });
remove(profile);

const server = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true } });
let browser;
let cdp;
try {
  const debugPort = 9850 + Math.floor(Math.random() * 80);
  browser = spawn(findBrowser(), [
    "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    "--window-size=1920,1080", "--force-device-scale-factor=1", "--enable-precise-memory-info",
    "--no-first-run", "--disable-background-networking", "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } }, 30_000);
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?perfHarness=1&domPerfTrace=1` });
  await sleep(1200);
  await cdp.evaluate(`localStorage.setItem("bt_current_user", JSON.stringify({username:"dom_perf",displayName:"DOM Performance",role:"admin",productTier:"admin",permissions:["admin.override"],allowedIndicators:["aif","volumeProfile"],emailVerified:true,authSessionReady:false})); localStorage.setItem("bt_active_nav","CHART")`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`), 45_000);
  const samples = [];
  let scenario = "A_DOM_ALONE";
  let cycle = 0;
  await openDom();
  await sleep(1500);
  await cdp.evaluate(`window.__BLACK_TERMINAL_PERFORMANCE__?.resetCounters?.(); window.__DOM_PRO_PERFORMANCE__?.reset?.()`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < requestedMs) {
    cycle += 1;
    const phase = cycle % 8;
    if (phase === 1) { scenario = "B_CHART_DOM"; await wheelAndPan(); }
    if (phase === 2) { scenario = "D_MACRO_3D"; await clickPreset("Macro"); await clickCamera("3D"); }
    if (phase === 3) { scenario = "E_PRESET_SWITCH"; await clickPreset(cycle % 2 ? "Scalper" : "Institutional"); }
    if (phase === 4) { scenario = "F_SETTINGS"; await toggleSettings(); }
    if (phase === 5) { scenario = "G_PAN_ZOOM"; await wheelAndPan(); }
    if (phase === 6) { scenario = "H_MOUNT_UNMOUNT"; await closeDom(); await openDom(); }
    if (phase === 7) { scenario = "C_AIF_DOM"; await ensureAif(); await openDom(); }
    if (phase === 0) { scenario = "VISIBILITY_RECOVERY"; await cdp.send("Emulation.setPageVisibilityState", { visibilityState: "hidden" }).catch(() => {}); await sleep(250); await cdp.send("Emulation.setPageVisibilityState", { visibilityState: "visible" }).catch(() => {}); }
    await sleep(750);
    samples.push(await sample(cycle, scenario));
    process.stdout.write(`\r${scenario} ${Math.min(100, (Date.now() - startedAt) / requestedMs * 100).toFixed(0)}% p95=${format(samples.at(-1)?.telemetry?.p95FrameMs)}ms nodes=${samples.at(-1)?.domNodes}`);
  }
  const report = summarize(samples, { baseline, requestedMs, startedAt });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nDOM Pro performance report: ${relative(root, outputFile)}`);
  if (!baseline && !report.pass) process.exitCode = 1;
} finally {
  cdp?.close();
  browser?.kill();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await sleep(500);
  remove(profile);
}

async function openDom() {
  if (await cdp.evaluate(`Boolean(document.querySelector(".dom-pro-window"))`)) return;
  await cdp.evaluate(`document.querySelector('button[title="Open DOM Pro+"]')?.click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".dom-pro-window"))`), 15_000);
}
async function closeDom() {
  await cdp.evaluate(`document.querySelector('.dom-pro-window button[title="Close DOM Pro+"]')?.click()`);
  await sleep(200);
}
async function clickPreset(label) {
  await cdp.evaluate(`([...document.querySelectorAll(".dom-pro-preset-strip button")].find((node)=>node.textContent?.trim()===${JSON.stringify(label)}))?.click()`);
}
async function clickCamera(label) {
  await cdp.evaluate(`([...document.querySelectorAll(".dom-pro-horizon-controls button")].find((node)=>node.textContent?.trim()===${JSON.stringify(label)}))?.click()`);
}
async function toggleSettings() {
  await cdp.evaluate(`document.querySelector(".dom-pro-panel-cog")?.click()`);
  await sleep(100);
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
}
async function wheelAndPan() {
  const rect = await cdp.evaluate(`(() => { const r=document.querySelector(".dom-pro-heatmap-canvas")?.getBoundingClientRect(); return r ? {x:r.left+r.width*.5,y:r.top+r.height*.5} : null })()`);
  if (!rect) return;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaY: -240, deltaX: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y + 80, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y + 80, button: "left", buttons: 0, clickCount: 1 });
}
async function ensureAif() {
  await closeDom();
  if (await cdp.evaluate(`Boolean(document.querySelector(".aif-overlay"))`)) return;
  await cdp.evaluate(`([...document.querySelectorAll(".nav")].find((node)=>node.textContent?.includes("INDICATORS")))?.click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".indicator-library"))`), 10_000);
  await cdp.evaluate(`([...document.querySelectorAll(".library-row")].find((node)=>node.textContent?.includes("A.I.F."))?.querySelector(".library-row-main"))?.click(); document.querySelector('[aria-label="Close indicators"]')?.click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".aif-overlay"))`), 15_000);
}
async function sample(index, scenario) {
  const runtime = await cdp.evaluate(`(() => { const p=window.__BLACK_TERMINAL_PERFORMANCE__?.snapshot?.()??null; const trace=window.__DOM_PRO_PERFORMANCE__?.snapshot?.()??null; const resources=p?.resources?.active??{}; return { telemetry:p, trace, heapUsedMb:performance.memory?.usedJSHeapSize/1048576??null, domNodes:document.getElementsByTagName("*").length, heatmapCells:document.querySelectorAll(".dom-pro-heatmap-cell").length, heatmapFrames:Number(document.querySelector(".dom-pro-heatmap-layer")?.dataset.heatmapFrames||0), canvasCount:document.querySelectorAll("canvas").length, workerCount:resources.worker??0, websocketCount:resources.websocket??0, listenerCount:resources.listener??0, timerCount:(resources.interval??0)+(resources.timeout??0), workerQueue:p?.workerQueueDepth??0, cockpit:Boolean(document.querySelector(".dom-pro-window")), aifActive:Boolean(document.querySelector(".aif-overlay")) }; })()`);
  const performanceMetrics = await cdp.send("Performance.getMetrics");
  return { time: new Date().toISOString(), index, scenario, ...runtime, cdp: Object.fromEntries(performanceMetrics.metrics.map((metric) => [metric.name, metric.value])) };
}
function summarize(samples, context) {
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  const scenarios = Object.fromEntries([...new Set(samples.map((item) => item.scenario))].map((name) => {
    const subset = samples.filter((item) => item.scenario === name);
    return [name, { samples: subset.length, frameP95Ms: percentile(subset.map((item) => item.telemetry?.p95FrameMs).filter(Number.isFinite), .95), maxLongTaskMs: Math.max(0, ...subset.map((item) => item.telemetry?.longestTaskMs ?? 0)) }];
  }));
  const heapGrowthMb = finite(last.heapUsedMb) - finite(first.heapUsedMb);
  const domGrowth = finite(last.domNodes) - finite(first.domNodes);
  const resourceGrowth = {
    workers: finite(last.workerCount) - finite(first.workerCount),
    websockets: finite(last.websocketCount) - finite(first.websocketCount),
    listeners: finite(last.listenerCount) - finite(first.listenerCount),
    timers: finite(last.timerCount) - finite(first.timerCount)
  };
  const workerQueuePeak = Math.max(0, ...samples.map((item) => item.workerQueue ?? 0));
  // Telemetry percentiles are cumulative for the run; percentile-of-percentiles
  // overweights startup snapshots and is not a valid aggregate percentile.
  const p95FrameMs = finite(last.telemetry?.p95FrameMs);
  const p99FrameMs = finite(last.telemetry?.p99FrameMs);
  const checks = {
    samplesCollected: samples.length >= 3,
    cockpitStayedReady: samples.every((item) => item.cockpit),
    aifExercised: samples.some((item) => item.aifActive),
    heapBounded: heapGrowthMb < 128,
    domBounded: domGrowth < 500,
    heatmapHistoryBounded: samples.every((item) => (item.heatmapFrames ?? 0) <= 180),
    noPerCellReactNodes: samples.every((item) => item.heatmapCells === 0),
    workerQueueBounded: workerQueuePeak <= 2,
    workersBounded: resourceGrowth.workers <= 1,
    websocketsBounded: resourceGrowth.websockets <= 1,
    listenersBounded: resourceGrowth.listeners <= 5,
    timersBounded: resourceGrowth.timers <= 5,
    frameP95Bounded: p95FrameMs < 75,
    noMultiSecondLock: Math.max(0, ...samples.map((item) => item.telemetry?.longestTaskMs ?? 0)) < 500
  };
  const pass = Object.values(checks).every(Boolean);
  const retainedSamples = samples.length <= 24
    ? samples
    : samples.filter((_, index) => index % Math.ceil(samples.length / 24) === 0 || index === samples.length - 1);
  return {
    generatedAt: new Date().toISOString(), mode: context.baseline ? "baseline" : "recovery-validation",
    requestedDurationMs: context.requestedMs, actualDurationMs: Date.now() - context.startedAt, sampleCount: samples.length,
    p95FrameMs, p99FrameMs, longestTaskMs: Math.max(0, ...samples.map((item) => item.telemetry?.longestTaskMs ?? 0)),
    heapGrowthMb, domGrowth, resourceGrowth, workerQueuePeak, peakHeatmapDomCells: Math.max(0, ...samples.map((item) => item.heatmapCells ?? 0)),
    messagesPerSecondPeak: Math.max(0, ...samples.map((item) => (item.telemetry?.publicMessagesPerSecond ?? 0) + (item.telemetry?.privateMessagesPerSecond ?? 0))),
    scenarios, checks, pass, retainedSampleCount: retainedSamples.length, samples: retainedSamples.map(compactSample)
  };
}
function compactSample(sample) {
  const telemetry = sample.telemetry ?? {};
  return {
    time: sample.time, index: sample.index, scenario: sample.scenario,
    heapUsedMb: sample.heapUsedMb, domNodes: sample.domNodes, heatmapCells: sample.heatmapCells,
    heatmapFrames: sample.heatmapFrames, canvasCount: sample.canvasCount, workerCount: sample.workerCount,
    websocketCount: sample.websocketCount, listenerCount: sample.listenerCount, timerCount: sample.timerCount,
    workerQueue: sample.workerQueue, cockpit: sample.cockpit, aifActive: sample.aifActive,
    telemetry: {
      fps: telemetry.fps, averageFrameMs: telemetry.averageFrameMs, p95FrameMs: telemetry.p95FrameMs,
      p99FrameMs: telemetry.p99FrameMs, longestTaskMs: telemetry.longestTaskMs,
      publicMessagesPerSecond: telemetry.publicMessagesPerSecond,
      privateMessagesPerSecond: telemetry.privateMessagesPerSecond,
      workerQueueDepth: telemetry.workerQueueDepth, resources: telemetry.resources
    },
    trace: sample.trace
  };
}
function percentile(values, pct) { if (!values.length) return 0; const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*pct)-1))]; }
function finite(value) { return Number.isFinite(value) ? value : 0; }
function format(value) { return Number.isFinite(value) ? value.toFixed(1) : "n/a"; }
function findBrowser() { const paths=[`${process.env.PROGRAMFILES??"C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,`${process.env["PROGRAMFILES(X86)"]??"C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,`${process.env.PROGRAMFILES??"C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`]; const found=paths.find(existsSync); if(!found) throw new Error("Chromium browser not found"); return found; }
async function waitFor(check, timeout) { const started=Date.now(); while(Date.now()-started<timeout){ if(await check()) return; await sleep(200); } throw new Error("DOM Pro performance state timed out"); }
function remove(path) { try { rmSync(path,{recursive:true,force:true,maxRetries:3}); } catch {} }
function sleep(ms) { return new Promise((resolve)=>setTimeout(resolve,ms)); }
