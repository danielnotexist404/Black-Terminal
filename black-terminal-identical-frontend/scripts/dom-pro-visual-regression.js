import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws?.close(); }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "docs", "visual-regression", "dom-pro-final");
const profile = join(root, ".visual-browser-profile");
const port = 4181;
const targetUrl = `http://127.0.0.1:${port}/?perfHarness=1`;
mkdirSync(output, { recursive: true });
safeRemove(profile);
const server = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true } });
let browser;
let cdp;
try {
  const browserPath = findBrowser();
  const debuggingPort = 9650 + Math.floor(Math.random() * 100);
  browser = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${profile}`, "--window-size=1920,1080", "--force-device-scale-factor=1", "--no-first-run", "about:blank"], { stdio: "ignore", windowsHide: true });
  await waitForHttp(`http://127.0.0.1:${debuggingPort}/json/version`, 30_000);
  const page = await createPage(debuggingPort, "about:blank");
  cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: targetUrl });
  await sleep(2000);
  await cdp.evaluate(`localStorage.setItem("bt_current_user", JSON.stringify({username:"visual_harness",displayName:"Visual Harness",role:"admin",productTier:"admin",permissions:["admin.override"],allowedIndicators:["volumeProfile"],emailVerified:true,authSessionReady:false})); localStorage.setItem("bt_active_nav", "CHART");`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`), 45_000);
  await cdp.evaluate(`document.querySelector('button[title="Open DOM Pro+"]')?.click()`);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(".dom-pro-window"))`), 20_000);
  await screenshot("panel-headers.png");

  const presetNames = ["Scalper", "Institutional", "Macro"];
  for (const preset of presetNames) {
    await cdp.evaluate(`(() => { const button=[...document.querySelectorAll(".dom-pro-preset-strip button")].find((node) => node.textContent?.trim() === ${JSON.stringify(preset)}); button?.click(); })()`);
    await sleep(500);
    await screenshot(`preset-${preset.toLowerCase()}.png`);
  }

  const labels = await cdp.evaluate(`[...document.querySelectorAll(".dom-pro-panel-cog")].map((node) => node.getAttribute("aria-label"))`);
  if (labels.length !== 10) throw new Error(`Expected 10 panel cogs, found ${labels.length}`);
  for (let index = 0; index < labels.length; index += 1) {
    await cdp.evaluate(`document.querySelectorAll(".dom-pro-panel-cog")[${index}]?.click()`);
    await sleep(120);
    const bounds = await cdp.evaluate(`(() => { const r=document.querySelector(".dom-pro-panel-popover")?.getBoundingClientRect(); return r ? {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} : null; })()`);
    if (!bounds || bounds.left < 0 || bounds.top < 0 || bounds.right > 1920 || bounds.bottom > 1080) throw new Error(`Popover ${index} escaped viewport: ${JSON.stringify(bounds)}`);
    await screenshot(`popover-${String(index + 1).padStart(2, "0")}.png`);
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))`);
  }

  writeFileSync(join(output, "summary.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: "1920x1080", panelCogs: labels.length, presets: presetNames, popovers: labels }, null, 2)}\n`);
  console.log(`DOM Pro visual regression captured ${labels.length + presetNames.length + 1} snapshots.`);
} finally {
  cdp?.close();
  browser?.kill();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await sleep(500);
  safeRemove(profile);
}

async function screenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, name), Buffer.from(result.data, "base64"));
}

function findBrowser() {
  const candidates = [`${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chromium browser not found.");
  return found;
}

async function createPage(debuggingPort, targetUrl) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`CDP page creation failed: ${response.status}`);
  return response.json();
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await check()) return; await sleep(250); }
  throw new Error("Timed out waiting for DOM Pro visual state.");
}

async function waitForHttp(url, timeoutMs) {
  await waitFor(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, timeoutMs);
}

function safeRemove(path) { try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
