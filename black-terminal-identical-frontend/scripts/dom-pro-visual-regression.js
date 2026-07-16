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
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.dom-pro-ladder-row.shared-row').length >= 12`), 20_000);
  const readSharedCamera = `(() => {
    const ladder=document.querySelector('.dom-pro-ladder-book.shared-camera');
    const profile=document.querySelector('.dom-pro-profile-scale.shared-camera');
    const heatmap=document.querySelector('.dom-pro-heatmap-layer');
    const pick=(node)=>node ? {version:node.dataset.cameraVersion,min:Number(node.dataset.cameraMin),max:Number(node.dataset.cameraMax),bucket:node.dataset.bucketSize ? Number(node.dataset.bucketSize) : null,resolution:Number(node.dataset.resolutionRows||0),currentTop:Number(node.dataset.currentPriceTop)} : null;
    const rows=[...document.querySelectorAll('.dom-pro-ladder-row.shared-row')];
    const profileRows=document.querySelectorAll('.dom-pro-profile-node.native-row').length;
    return {ladder:pick(ladder),profile:pick(profile),heatmap:pick(heatmap),heatmapVisualMode:heatmap?.dataset.visualMode,rows:rows.length,profileRows,profileLabels:document.querySelectorAll('.dom-pro-profile-label-layer.dense .dom-pro-profile-label').length,live:rows.filter((row)=>row.dataset.coverage==='live').length,unavailable:rows.filter((row)=>row.dataset.coverage==='unavailable').length,bid:rows.reduce((sum,row)=>sum+Number(row.dataset.bidSize||0),0),ask:rows.reduce((sum,row)=>sum+Number(row.dataset.askSize||0),0)};
  })()`;
  const initialSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(initialSharedCamera, "initial");
  if (initialSharedCamera.bid <= 0 || initialSharedCamera.ask <= 0) throw new Error(`Fixture live depth did not reach shared ladder: ${JSON.stringify(initialSharedCamera)}`);
  await screenshot("shared-follow-near-market.png");

  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll('.dom-pro-horizon-controls button')].find((node)=>node.textContent?.trim()==='+/-5%'); button?.click(); })()`);
  await sleep(350);
  const wideSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(wideSharedCamera, "wide +/-5%");
  if (wideSharedCamera.unavailable <= 0) throw new Error(`Wide camera did not expose unavailable live-book rows: ${JSON.stringify(wideSharedCamera)}`);
  await screenshot("shared-wide-5pct-uncovered.png");

  const prePanVersion = wideSharedCamera.ladder.version;
  const ladderBounds = await cdp.evaluate(`(() => { const rect=document.querySelector('.dom-pro-ladder-book.shared-camera').getBoundingClientRect(); return {x:rect.left+40,y:rect.top+rect.height*.52,endY:rect.top+rect.height*.67}; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ladderBounds.x, y: ladderBounds.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ladderBounds.x, y: ladderBounds.endY, button: "left", buttons: 1 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ladderBounds.x, y: ladderBounds.endY, button: "left", buttons: 0, clickCount: 1 });
  await sleep(350);
  const pannedSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(pannedSharedCamera, "ladder pan");
  if (pannedSharedCamera.ladder.version === prePanVersion) throw new Error("Ladder pan did not update the shared camera");
  await screenshot("shared-simultaneous-pan.png");

  const preZoomBucket = pannedSharedCamera.ladder.bucket;
  await cdp.evaluate(`(() => { const node=document.querySelector('.dom-pro-ladder-book.shared-camera'); const rect=node.getBoundingClientRect(); node.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,clientX:rect.left+40,clientY:rect.top+rect.height*.45})); })()`);
  await sleep(350);
  const zoomedSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(zoomedSharedCamera, "ladder zoom");
  if (!(zoomedSharedCamera.ladder.bucket < preZoomBucket)) throw new Error(`Ladder wheel did not zoom shared buckets: ${preZoomBucket} -> ${zoomedSharedCamera.ladder.bucket}`);
  await screenshot("shared-simultaneous-zoom.png");

  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll('.dom-pro-horizon-controls button')].find((node)=>node.textContent?.trim()==='+/-20%'); button?.click(); })()`);
  await sleep(350);
  const macroSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(macroSharedCamera, "wide +/-20%");
  await screenshot("shared-wide-20pct.png");

  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll('.dom-pro-horizon-controls button')].find((node)=>node.textContent?.trim()==='Fit'); button?.click(); })()`);
  await sleep(350);
  const fitSharedCamera = await cdp.evaluate(readSharedCamera);
  assertSharedCamera(fitSharedCamera, "fit");
  await screenshot("shared-fit-domain.png");
  await screenshot("panel-headers.png");
  const cockpitContract = await cdp.evaluate(`(() => ({ camera:[...document.querySelectorAll('.dom-pro-camera-switches button')].map((node)=>node.textContent.trim()), handles:document.querySelectorAll('.dom-pro-resize-handle').length, orderType:Boolean(document.querySelector('.dom-pro-execution-form select')), tif:Boolean([...document.querySelectorAll('.dom-pro-execution-form span')].find((node)=>node.textContent==='TIF')), allocation:Boolean([...document.querySelectorAll('.dom-pro-equity-allocation span')].find((node)=>node.textContent==='Equity Allocation')) }))()`);
  if (cockpitContract.camera.join("|") !== "Center|Fit|Follow|Explore") throw new Error(`Camera controls are incomplete: ${JSON.stringify(cockpitContract.camera)}`);
  if (cockpitContract.handles !== 8 || !cockpitContract.orderType || !cockpitContract.tif || !cockpitContract.allocation) throw new Error(`Workspace contract failed: ${JSON.stringify(cockpitContract)}`);
  await screenshot("compact-execution.png");

  await cdp.evaluate(`(() => { const handle=document.querySelector('.dom-pro-resize-handle.horizontal'); const rect=handle.getBoundingClientRect(); handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,clientX:rect.left+10,clientY:rect.top+4})); window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:rect.left+10,clientY:rect.top+55})); window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:rect.left+10,clientY:rect.top+55})); })()`);
  await sleep(250);
  await screenshot("compressed-bottom-row.png");

  await cdp.evaluate(`document.querySelector('.dom-pro-execution .dom-pro-panel-layout-action')?.click()`);
  await sleep(150);
  await screenshot("collapsed-execution.png");
  await cdp.evaluate(`document.querySelector('.dom-pro-execution .dom-pro-panel-layout-action')?.click()`);
  await cdp.evaluate(`document.querySelector('.dom-pro-heatmap .dom-pro-panel-layout-action:last-child')?.click()`);
  await sleep(150);
  await screenshot("maximized-heatmap.png");
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  await screenshot("narrow-camera-controls.png");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(250);

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

  writeFileSync(join(output, "summary.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: "1920x1080 + 1280x800", panelCogs: labels.length, cockpitContract, sharedCamera: { initial: initialSharedCamera, wide: wideSharedCamera, pan: pannedSharedCamera, zoom: zoomedSharedCamera, macro: macroSharedCamera, fit: fitSharedCamera }, presets: presetNames, popovers: labels }, null, 2)}\n`);
  console.log(`DOM Pro visual regression captured ${labels.length + presetNames.length + 12} snapshots.`);
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

function assertSharedCamera(contract, label) {
  if (!contract?.ladder || !contract.profile || !contract.heatmap) throw new Error(`${label} camera consumer missing: ${JSON.stringify(contract)}`);
  const values = [contract.ladder, contract.profile, contract.heatmap];
  if (!values.every((value) => value.version === values[0].version && value.min === values[0].min && value.max === values[0].max && Math.abs(value.currentTop - values[0].currentTop) < 0.000001)) {
    throw new Error(`${label} camera parity failed: ${JSON.stringify(contract)}`);
  }
  if (contract.rows < 12 || contract.rows > 120) throw new Error(`${label} row virtualization failed: ${JSON.stringify(contract)}`);
  if (contract.profileRows < 128 || contract.profile.resolution !== contract.profileRows) throw new Error(`${label} profile resolution regressed: ${JSON.stringify(contract)}`);
  if (contract.profileLabels < 24) throw new Error(`${label} dense profile annotations regressed: ${JSON.stringify(contract)}`);
  if (contract.heatmap.resolution < 64 || contract.heatmap.resolution <= contract.rows) throw new Error(`${label} heatmap resolution regressed: ${JSON.stringify(contract)}`);
  if (contract.heatmapVisualMode !== "enhanced") throw new Error(`${label} enhanced heatmap graphics are not active: ${JSON.stringify(contract)}`);
}
