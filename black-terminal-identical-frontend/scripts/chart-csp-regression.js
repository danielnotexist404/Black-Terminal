import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

async function main() {
let localServer;
let profile;
let browser;
let cdp;

try {
  const localTarget = process.env.CHART_CSP_LOCAL === "true" ? await startLocalTarget() : undefined;
  localServer = localTarget?.server;
  const targetUrl = process.env.CHART_CSP_URL || localTarget?.url || "https://www.black-terminal.live/?chartCspTest=1";
  const response = await fetch(targetUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Chart CSP target returned ${response.status}.`);
  const csp = response.headers.get("content-security-policy") || "";
  if (!csp.includes("script-src 'self'") || csp.includes("'unsafe-eval'")) {
    throw new Error(`Chart CSP regression requires a self-only script policy without unsafe-eval: ${csp}`);
  }

  profile = mkdtempSync(join(tmpdir(), "black-terminal-chart-csp-"));
  const browserPath = findBrowser();
  const debuggingPort = 9900 + Math.floor(Math.random() * 80);
  const diagnostics = [];
  browser = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,1000",
    "--force-device-scale-factor=1",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${debuggingPort}/json/version`)).ok; } catch { return false; }
  }, 30_000, "headless browser startup");

  const page = await createPage(debuggingPort, "about:blank");
  cdp = new CdpClient(page.webSocketDebuggerUrl, (message) => collectDiagnostic(message, diagnostics));
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: targetUrl });
  await waitFor(() => cdp.evaluate("document.readyState === 'complete'"), 30_000, "initial page load");
  await cdp.evaluate(`localStorage.setItem("bt_current_user", JSON.stringify({username:"chart_csp_harness",displayName:"Chart CSP Harness",role:"admin",productTier:"admin",permissions:["admin.override"],allowedIndicators:["volumeProfile","aif"],emailVerified:true,authSessionReady:false})); localStorage.setItem("bt_active_nav", "CHART");`);
  await cdp.send("Page.reload", { ignoreCache: true });

  try {
    await waitFor(() => cdp.evaluate("Boolean(document.querySelector('.app-shell'))"), 45_000, "terminal shell");
  } catch (error) {
    const pageState = await cdp.evaluate(`({ href: location.href, title: document.title, body: document.body?.innerText?.slice(0, 500) || "", html: document.documentElement?.outerHTML?.slice(0, 800) || "" })`);
    throw new Error(`${error.message} Page: ${JSON.stringify(pageState)} Diagnostics: ${JSON.stringify(diagnostics.slice(-12))}`);
  }
  const chartState = await waitForChart(cdp, 45_000);
  if (chartState.status === "ENGINE ERROR") {
    throw new Error(`Chart engine failed under production CSP. Diagnostics: ${JSON.stringify(diagnostics.slice(-12))}`);
  }
  if (!chartState.canvasReady) throw new Error(`Pixi canvas is not ready: ${JSON.stringify(chartState)}`);
  if (diagnostics.some((item) => /unsafe-eval|Content Security Policy.*script/i.test(item.text))) {
    throw new Error(`CSP console violation detected: ${JSON.stringify(diagnostics.slice(-12))}`);
  }
  console.log(`Chart CSP regression passed: status=${chartState.status}, canvas=${chartState.width}x${chartState.height}, unsafe-eval disabled.`);
} finally {
  cdp?.close();
  browser?.kill();
  await sleep(300);
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  if (localServer) await new Promise((resolveClose) => localServer.close(resolveClose));
}
}

async function startLocalTarget() {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const distRoot = resolve(projectRoot, "dist");
  const vercelConfig = JSON.parse(readFileSync(join(projectRoot, "vercel.json"), "utf8"));
  const configuredHeaders = Object.fromEntries((vercelConfig.headers?.[0]?.headers || []).map(({ key, value }) => [key, value]));
  // The local harness is HTTP-only. Keep the production CSP verbatim except for
  // its HTTPS transport upgrade, which would otherwise rewrite localhost assets.
  const cspKey = Object.keys(configuredHeaders).find((key) => key.toLowerCase() === "content-security-policy");
  if (cspKey) configuredHeaders[cspKey] = configuredHeaders[cspKey].replace(/;\s*upgrade-insecure-requests\b/, "");
  const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2"
  };
  if (!existsSync(join(distRoot, "index.html"))) throw new Error("Local chart CSP regression requires a built dist directory. Run npm run build first.");

  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const requestedPath = resolve(distRoot, `.${pathname}`);
      let filePath = requestedPath.startsWith(`${distRoot}/`) && existsSync(requestedPath) && statSync(requestedPath).isFile()
        ? requestedPath
        : join(distRoot, "index.html");
      for (const [key, value] of Object.entries(configuredHeaders)) response.setHeader(key, value);
      response.setHeader("Content-Type", mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream");
      response.end(readFileSync(filePath));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/?chartCspTest=1&perfHarness=1` };
}

class CdpClient {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) return this.onEvent?.(message);
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
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  close() { this.ws?.close(); }
}

function collectDiagnostic(message, output) {
  if (message.method === "Runtime.exceptionThrown") {
    output.push({ kind: "exception", text: String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "runtime exception").slice(0, 800) });
  }
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params?.type)) {
    output.push({ kind: message.params.type, text: (message.params.args || []).map((item) => item.description || item.value || "").join(" ").slice(0, 800) });
  }
  if (message.method === "Log.entryAdded" && ["error", "warning"].includes(message.params?.entry?.level)) {
    output.push({ kind: message.params.entry.level, text: String(message.params.entry.text || "").slice(0, 800) });
  }
  if (output.length > 100) output.shift();
}

async function waitForChart(client, timeoutMs) {
  const started = Date.now();
  let latest = {};
  while (Date.now() - started < timeoutMs) {
    latest = await client.evaluate(`(() => {
      const status = document.querySelector(".chart-metrics span")?.textContent?.trim() || "";
      const canvas = document.querySelector(".pixi-chart-host canvas");
      return { status, canvasReady: Boolean(canvas && canvas.width > 0 && canvas.height > 0), width: canvas?.width || 0, height: canvas?.height || 0 };
    })()`);
    if (latest.status === "ENGINE ERROR" || latest.canvasReady) return latest;
    await sleep(250);
  }
  return latest;
}

function findBrowser() {
  const candidates = process.platform === "win32"
    ? [
        `${process.env.PROGRAMFILES || "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`
      ]
    : ["/usr/bin/brave-browser", "/usr/bin/brave-browser-stable", "/opt/brave.com/brave/brave", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("A Chromium-compatible browser is required for the chart CSP regression.");
  return found;
}

async function createPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`CDP page creation failed: ${response.status}`);
  return response.json();
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

await main();
