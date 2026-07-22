import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { preview } from "vite";

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) {
        this.events.push(message);
        return;
      }
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
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws?.close(); }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "docs", "visual-regression", "book-heatmap");
const profile = join("/tmp", `black-terminal-book-heatmap-visual-${process.pid}`);
mkdirSync(output, { recursive: true });
remove(profile);
const port = 4187;
const server = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true } });
let browser;
let cdp;
const captures = [];
try {
  const debugPort = 9850 + Math.floor(Math.random() * 100);
  browser = spawn(findBrowser(), [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1920,1080",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } }, 30_000);
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?perfHarness=1` });
  await sleep(700);
  await cdp.eval(`localStorage.setItem("bt_current_user", JSON.stringify({username:"book_heatmap_visual",displayName:"Book Heatmap Visual",role:"admin",productTier:"admin",permissions:["admin.override"],allowedIndicators:["orderBookHeatmap","liquidationHeatmap","volumeProfile"],emailVerified:true,authSessionReady:false})); localStorage.setItem("bt_active_nav","CHART"); localStorage.setItem("bt_visible_indicators_v1",JSON.stringify({orderBookHeatmap:true,liquidationHeatmap:false,volatilityHeatmap:false,volumeProfile:false,aif:false,adaptiveSwingStrategy:false,vwap:false,ema20:false,ema50:false,ema200:false,sma20:false,sma50:false,bollinger:false,openInterestOscillator:false,zScoreOscillator:false,waveTrendOscillator:false,volume:false}));`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".app-shell") && window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__)`), 45_000);
  await installCandles();
  await installHistory("normal");
  await injectBook("normal", 1);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".book-heatmap-diagnostics"))`), 10_000);
  await sleep(1_100);
  await shot("01-main-normal-market.png");

  await installHistory("thin");
  await injectBook("thin", 2);
  await shot("02-thin-book.png");
  await installHistory("wall");
  await injectBook("wall", 3);
  await shot("03-strong-walls-extreme-outlier.png");

  await cdp.eval(`([...document.querySelectorAll(".indicator-row")].find((node)=>node.textContent?.includes("Book Heatmap")))?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".indicator-settings"))`), 10_000);
  await cdp.eval(`([...document.querySelectorAll("button")].find((node)=>node.textContent?.includes("Open Full Book Heatmap Workspace")))?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".book-heatmap-workspace"))`), 10_000);
  await shot("04-fullscreen-live-follow-partial-history.png");

  const host = await cdp.eval(`(() => { const r=document.querySelector(".pixi-chart-host")?.getBoundingClientRect(); return r ? {x:r.left+r.width*.55,y:r.top+r.height*.55} : null; })()`);
  if (!host) throw new Error("Chart host unavailable for free-camera regression.");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: host.x, y: host.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: host.x - 180, y: host.y + 25, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: host.x - 180, y: host.y + 25, button: "left", buttons: 0, clickCount: 1 });
  await cdp.eval(`([...document.querySelectorAll(".book-heatmap-workspace-bar button")].find((node)=>node.textContent?.includes("LIVE FOLLOW")))?.click()`);
  await shot("05-free-camera-alignment.png");

  await setWorkspaceMode("estimated-liquidations");
  await shot("06-estimated-model-clearly-labelled.png");
  await setWorkspaceMode("confirmed-liquidations");
  await injectConfirmed();
  await sleep(1_100);
  await shot("07-confirmed-liquidations-separate.png");
  await setWorkspaceMode("live-book");

  await cdp.eval(`([...document.querySelectorAll(".book-heatmap-workspace-bar button")].find((node)=>node.textContent?.includes("SETTINGS")))?.click()`);
  await waitFor(() => cdp.eval(`Boolean(document.querySelector(".indicator-settings"))`), 10_000);
  await cdp.eval(`(() => { const label=[...document.querySelectorAll(".indicator-settings label")].find((node)=>node.firstChild?.textContent?.trim()==="Source Mode"); const select=label?.querySelector("select"); if(!select) throw new Error("Source Mode missing"); select.value="consolidated-book"; select.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await sleep(250);
  await installHistory("disagreement");
  await injectBook("disagreement", 20, "bybit");
  await injectBook("disagreement", 200, "binance");
  await cdp.eval(`document.querySelector(".tv-ok")?.click()`);
  await sleep(1_100);
  await shot("08-multi-venue-disagreement.png");

  await injectStaleBook("binance", 201);
  await sleep(1_100);
  await shot("09-disconnected-resynchronizing-venue.png");

  const zoomHost = await cdp.eval(`(() => { const r=document.querySelector(".pixi-chart-host")?.getBoundingClientRect(); return r ? {x:r.left+r.width*.5,y:r.top+r.height*.5} : null; })()`);
  if (!zoomHost) throw new Error("Chart host unavailable for zoom regression.");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: zoomHost.x, y: zoomHost.y, deltaX: 0, deltaY: -650 });
  await sleep(300);
  await shot("10-zoomed-in-alignment.png");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: zoomHost.x, y: zoomHost.y, deltaX: 0, deltaY: 1300 });
  await sleep(300);
  await shot("11-zoomed-out-alignment.png");

  await installCandles(3600);
  await cdp.eval(`window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__.setHistory([])`);
  await injectBook("wall", 300, "bybit");
  await sleep(450);
  await shot("12-current-live-profile-1h-no-history.png");

  const errors = await cdp.eval(`performance.getEntriesByType("resource").filter((entry)=>entry.name.includes("perpdexwars")).length`);
  if (errors !== 0) throw new Error("Forbidden perpdexwars dependency was requested.");
  const contract = await cdp.eval(`({workspace:Boolean(document.querySelector(".book-heatmap-workspace")),mode:document.querySelector(".book-heatmap-workspace-mode")?.value,diagnostics:document.querySelector(".book-heatmap-diagnostics")?.textContent||"",canvas:Boolean(document.querySelector(".pixi-chart-host canvas")),volumeVisible:Boolean([...document.querySelectorAll(".indicator-row")].find((node)=>node.textContent?.includes("Volume")&&node.classList.contains("active")))})`);
  if (!contract.workspace || !contract.canvas || contract.volumeVisible) throw new Error(`Visual contract failed: ${JSON.stringify(contract)}`);
  const browserErrors = cdp.events.filter((event) => {
    if (event.method === "Runtime.exceptionThrown") return true;
    if (event.method === "Runtime.consoleAPICalled" && event.params?.type === "error") return true;
    if (event.method !== "Log.entryAdded" || event.params?.entry?.level !== "error") return false;
    return !String(event.params?.entry?.url ?? "").endsWith("/favicon.ico");
  });
  if (browserErrors.length > 0) throw new Error(`Browser console/runtime errors: ${JSON.stringify(browserErrors.slice(0, 3))}`);
  writeFileSync(join(output, "summary.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), captures, viewport: "1920x1080", contract, forbiddenDependencyRequests: errors, browserErrors: browserErrors.length }, null, 2)}\n`);
  console.log(`Book Heatmap visual regression captured ${captures.length} authenticated chart/workspace states.`);
} finally {
  try { await cdp?.send("Browser.close"); } catch {}
  cdp?.close();
  browser?.kill();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await sleep(350);
  remove(profile);
}

async function installCandles(intervalSeconds = 60) {
  await cdp.eval(`(() => { const now=Math.floor(Date.now()/1000); const interval=${Number(intervalSeconds)}; const candles=Array.from({length:240},(_,index)=>{const center=103000+Math.sin(index/13)*1200+index*4;return {time:now-(239-index)*interval,open:center-90,high:center+220,low:center-240,close:center+70,volume:120+(index%19)*22};}); window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__.setCandles(candles); })()`);
}

async function installHistory(kind) {
  await cdp.eval(`(() => {
    const hook = window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__;
    const now = Math.floor(Date.now() / 1000);
    const start = now - 239 * 60;
    const fixtureKind = ${JSON.stringify(kind)};
    const cells = [];
    const priceCount = fixtureKind === "thin" ? 4 : 12;
    for (let column = 0; column < 40; column += 1) {
      const time = (start + column * 6 * 60) * 1000;
      for (let level = 0; level < priceCount; level += 1) {
        const price = fixtureKind === "thin"
          ? 101700 + level * 900
          : 98200 + level * 900 + Math.sin(column / 5 + level) * 90;
        const isBid = price < 103250;
        let notional = (fixtureKind === "thin" ? 90000 : 480000) + (column % 9) * 65000 + (level % 5) * 120000;
        if (fixtureKind === "wall" && (level === 3 || level === 8)) notional *= 14;
        if (fixtureKind === "wall" && column === 26 && level === 8) notional *= 20;
        if (fixtureKind === "disagreement" && (level === 4 || level === 7)) notional *= 9;
        const venues = fixtureKind === "disagreement"
          ? {
              bybit: { bidSize: isBid ? notional * 0.28 : 0, askSize: isBid ? 0 : notional * 0.72 },
              binance: { bidSize: isBid ? notional * 0.72 : 0, askSize: isBid ? 0 : notional * 0.28 }
            }
          : { bybit: { bidSize: isBid ? notional : 0, askSize: isBid ? 0 : notional } };
        cells.push({
          time,
          bucketEnd: time + 6 * 60 * 1000,
          price,
          bucketSize: 220,
          bidSize: isBid ? notional : 0,
          askSize: isBid ? 0 : notional,
          bidPeakSize: isBid ? notional * 1.15 : 0,
          askPeakSize: isBid ? 0 : notional * 1.15,
          observations: 6,
          venues
        });
      }
    }
    hook.setHistory(cells);
  })()`);
  await sleep(180);
}

async function injectBook(kind, sequence, venue = "bybit") {
  await cdp.eval(`(() => { const now=Math.floor(Date.now()/1000); const mid=103250; const kind=${JSON.stringify(kind)}; const venue=${JSON.stringify(venue)}; const levels=kind==="thin"?12:kind==="wall"?200:80; const bids=Array.from({length:levels},(_,index)=>({price:mid-1-index,quantity:kind==="thin"?.02+(index%3)*.01:kind==="wall"&&index===48?950:0.4+(index%11)*.18})); const asks=Array.from({length:levels},(_,index)=>({price:mid+1+index,quantity:kind==="thin"?.018+(index%4)*.008:kind==="wall"&&index===62?1300:0.35+(index%13)*.15})); if(kind==="disagreement"&&venue==="binance"){bids[20].quantity=820;asks[45].quantity=4;} if(kind==="disagreement"&&venue==="bybit"){bids[20].quantity=3;asks[45].quantity=760;} window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__.ingest({exchange:venue,symbol:"BTCUSDT",time:now,sequence:${sequence},subscribedDepth:levels,bids,asks}); })()`);
  await sleep(320);
}

async function injectConfirmed() {
  await cdp.eval(`(() => { const hook=window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__; const now=Date.now(); for(let index=0;index<18;index++){hook.ingestConfirmed({id:"visual-liq-"+index,venue:index%2?"bybit":"binance",symbol:"BTCUSDT",time:now-index*1700,price:102400+index*95,quantity:.2+index*.08,liquidatedSide:index%2?"long":"short",priceKind:index%2?"bankruptcy":"average-fill"});} })()`);
  await sleep(250);
}

async function injectStaleBook(venue, sequence) {
  await cdp.eval(`(() => { const mid=103250; const bids=Array.from({length:60},(_,index)=>({price:mid-1-index,quantity:.4+(index%7)*.1})); const asks=Array.from({length:60},(_,index)=>({price:mid+1+index,quantity:.35+(index%9)*.1})); window.__BLACK_TERMINAL_BOOK_HEATMAP_VISUAL__.ingest({exchange:${JSON.stringify(venue)},symbol:"BTCUSDT",time:Math.floor(Date.now()/1000)-30,sequence:${sequence},subscribedDepth:60,bids,asks}); })()`);
  await sleep(420);
}

async function setWorkspaceMode(value) {
  await cdp.eval(`(() => { const select=document.querySelector(".book-heatmap-workspace-mode"); if(!select) throw new Error("Workspace mode control missing"); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await waitFor(() => cdp.eval(`document.querySelector(".book-heatmap-workspace-mode")?.value===${JSON.stringify(value)}`), 5_000);
  await sleep(220);
}

async function shot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, name), Buffer.from(result.data, "base64"));
  captures.push(name);
}

function findBrowser() {
  const candidates = process.platform === "win32"
    ? [`${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`]
    : ["/opt/brave.com/brave/brave", "brave-browser", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "/opt/codex-desktop/electron"];
  const searchPaths = (process.env.PATH ?? "").split(":").filter(Boolean);
  const found = candidates
    .flatMap((candidate) => candidate.includes("/") || process.platform === "win32"
      ? [candidate]
      : searchPaths.map((directory) => join(directory, candidate)))
    .find((candidate) => existsSync(candidate));
  if (!found) throw new Error("A Chromium browser is required for Book Heatmap visual regression.");
  return found;
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error("Book Heatmap visual state timed out.");
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function remove(path) { try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
