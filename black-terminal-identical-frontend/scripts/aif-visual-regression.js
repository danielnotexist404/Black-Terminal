import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { preview } from "vite";

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() { this.ws = new WebSocket(this.url); await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); }); this.ws.on("message", (raw) => { const value = JSON.parse(String(raw)); if (!value.id) return; const pending = this.pending.get(value.id); this.pending.delete(value.id); value.error ? pending?.reject(new Error(value.error.message)) : pending?.resolve(value.result); }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const value = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.text); return value.result.value; }
  close() { this.ws?.close(); }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "docs", "visual-regression", "aif");
const profile = join(root, ".aif-visual-profile");
mkdirSync(output, { recursive: true });
remove(profile);
const port = 4183;
const server = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true } });
let browser; let cdp;
try {
  const debugPort = 9750 + Math.floor(Math.random() * 100);
  browser = spawn(findBrowser(), ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1920,1080", "--force-device-scale-factor=1", "--no-first-run", "about:blank"], { stdio: "ignore", windowsHide: true });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } }, 30000);
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect(); await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?perfHarness=1` }); await sleep(1200);
  await cdp.eval(`localStorage.setItem("bt_current_user", JSON.stringify({username:"aif_visual",displayName:"AIF Visual",role:"admin",productTier:"admin",permissions:["admin.override"],allowedIndicators:["aif","volumeProfile"],emailVerified:true,authSessionReady:false})); localStorage.setItem("bt_active_nav","CHART")`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".app-shell"))`), 45000);
  await cdp.eval(`([...document.querySelectorAll(".nav")].find((node)=>node.textContent?.includes("INDICATORS")))?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".indicator-library"))`), 15000);
  await cdp.eval(`([...document.querySelectorAll(".library-row")].find((node)=>node.textContent?.includes("A.I.F."))?.querySelector(".library-row-main"))?.click(); document.querySelector('[aria-label="Close indicators"]')?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".aif-overlay"))`), 15000);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".aif-summary"))`), 90000);
  await shot("01-primary-volume.png");
  await cdp.eval(`([...document.querySelectorAll(".indicator-row")].find((node)=>node.textContent?.includes("A.I.F.")))?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".aif-settings"))`), 10000);
  await shot("02-full-settings.png");
  const profiles = ["delta", "tpo", "volatility", "pressure"];
  for (const value of profiles) {
    await cdp.eval(`(() => { const selects=document.querySelectorAll(".aif-settings select"); const select=selects[0]; select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event("change",{bubbles:true})); })()`);
    await sleep(500);
    await shot(`profile-${value}.png`);
  }
  await cdp.eval(`(() => { const select=document.querySelectorAll(".aif-settings select")[1]; select.value="volume"; select.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await sleep(500); await shot("07-primary-secondary.png");
  const summary = await cdp.eval(`({overlay:Boolean(document.querySelector(".aif-overlay")),settings:Boolean(document.querySelector(".aif-settings")),timeline:Boolean(document.querySelector(".aif-timeline")),workerQuality:document.querySelector(".aif-quality")?.textContent||"loading",viewport:{w:innerWidth,h:innerHeight}})`);
  writeFileSync(join(output, "summary.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), captures: 7, ...summary }, null, 2)}\n`);
  console.log("A.I.F. visual regression captured 7 chart-native states.");
} finally { cdp?.close(); browser?.kill(); await new Promise((resolve) => server.httpServer.close(resolve)); await sleep(400); remove(profile); }

async function shot(name) { const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(output, name), Buffer.from(result.data, "base64")); }
function findBrowser() { const options = [`${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`]; const found = options.find(existsSync); if (!found) throw new Error("Chromium browser not found"); return found; }
async function waitFor(check, timeout) { const started = Date.now(); while (Date.now() - started < timeout) { if (await check()) return; await sleep(250); } throw new Error("A.I.F. visual state timed out"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function remove(path) { try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
