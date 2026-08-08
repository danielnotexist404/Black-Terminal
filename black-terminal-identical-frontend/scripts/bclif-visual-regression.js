import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const goldenRoot = join(root, "tests", "golden", "bclif");
const manifestPath = join(goldenRoot, "manifest.json");
const artifactRoot = join(root, "tests", ".artifacts", "bclif");
const updateGoldens = process.env.BCLIF_UPDATE_GOLDENS === "1";
const browserExecutable = process.env.BCLIF_BROWSER_EXECUTABLE || "/usr/bin/brave-browser";
const requestedViewport = process.env.BCLIF_VISUAL_VIEWPORT || "";

if (!existsSync(browserExecutable)) {
  skip("BROWSER_EXECUTABLE_MISSING", `BCLIF visual certification requires a Chromium-family browser at ${browserExecutable}. Set BCLIF_BROWSER_EXECUTABLE to override.`);
}
const playwright = await import("playwright-core");

if (!existsSync(manifestPath)) skip("MANIFEST_MISSING", "The repository-owned BCLIF golden manifest is missing.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestCases = Array.isArray(manifest.cases) ? manifest.cases : [];
const staleBaselines = manifestCases.filter((entry) => entry.status === "STALE_REGENERATION_REQUIRED");
if (!updateGoldens && (String(manifest.certificationStatus || "").startsWith("BLOCKED_") || staleBaselines.length)) {
  skip("BASELINES_STALE", "BCLIF visual baselines are explicitly stale and must be regenerated before comparison can certify the current renderer.", {
    certificationStatus: manifest.certificationStatus || null,
    staleViewports: staleBaselines.map((entry) => `${entry.width}x${entry.height}`),
    blocker: manifest.blocker || null
  });
}
const cases = requestedViewport
  ? manifestCases.filter((entry) => `${entry.width}x${entry.height}` === requestedViewport)
  : manifestCases;
if (!cases.length) skip("MANIFEST_EMPTY", "The BCLIF golden manifest contains no viewport cases.");
const missingGoldens = cases.filter((entry) => !existsSync(join(goldenRoot, entry.baseline)));
if (missingGoldens.length && !updateGoldens) {
  skip("GOLDENS_MISSING", "BCLIF goldens have not been recorded. Run only an explicitly reviewed update with BCLIF_UPDATE_GOLDENS=1.", {
    missing: missingGoldens.map((entry) => entry.baseline)
  });
}

const { createServer } = await import("vite");
const port = 4289;
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true }
});

const results = [];
let failure = null;
let browser = null;
try {
  await server.listen();
  mkdirSync(artifactRoot, { recursive: true });
  for (const testCase of cases) {
    try {
      browser = await playwright.chromium.launch({ headless: true, executablePath: browserExecutable });
    } catch (error) {
      throw new Error(`Unable to launch the configured BCLIF visual browser at ${browserExecutable}.`, { cause: error });
    }
    const context = await browser.newContext({
      viewport: { width: testCase.width, height: testCase.height },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    await page.addInitScript(() => {
      const fixedNow = 1_900_000_000_000;
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [fixedNow])); }
        static now() { return fixedNow; }
      }
      Object.defineProperty(window, "Date", { value: FixedDate });
      localStorage.setItem("bt_active_nav", "CHART");
      localStorage.setItem("bt_terminal_settings", JSON.stringify({ showDOM: false, enabledTimeframes: ["1m", "5m", "15m", "1h", "4h", "1d"] }));
      localStorage.setItem("bt_visible_indicators_v1", JSON.stringify({
        liquidationHeatmap: true,
        auctionProfile: false,
        volatilityHeatmap: false,
        volumeProfile: false,
        aif: false,
        adaptiveSwingStrategy: false,
        vwap: true,
        ema20: true,
        ema50: true,
        ema200: true,
        sma20: false,
        sma50: false,
        bollinger: false,
        openInterestOscillator: false,
        zScoreOscillator: false,
        waveTrendOscillator: false,
        volume: false
      }));
      localStorage.removeItem("bt_current_user");
    });
    await page.goto(`http://127.0.0.1:${port}/?uiPreview=1&bclifVisualFixture=1`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 45_000 });

    const provenance = page.locator('.liquidation-field-provenance[data-bclif-authority="TEST_FIXTURE"]');
    await provenance.waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(() => {
      const node = document.querySelector(".liquidation-field-provenance");
      return node?.getAttribute("data-bclif-grid") !== "NONE";
    }, null, { timeout: 90_000 });
    await page.waitForTimeout(400);

    const audit = await provenance.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        authority: node.getAttribute("data-bclif-authority"),
        persistence: node.getAttribute("data-bclif-persistence"),
        grid: node.getAttribute("data-bclif-grid"),
        checksum: node.getAttribute("data-bclif-checksum"),
        bounds: node.getAttribute("data-bclif-bounds"),
        intensity: node.getAttribute("data-bclif-intensity"),
        render: node.getAttribute("data-bclif-render"),
        market: document.querySelector(".chart-header .pair")?.textContent?.trim() || "",
        confidence: [...document.querySelectorAll(".liquidation-field-diagnostics > div")]
          .find((entry) => entry.querySelector("span")?.textContent?.trim() === "CONFIDENCE")
          ?.querySelector("b")?.textContent?.trim() || "",
        provenanceAreaRatio: rect.width * rect.height / (innerWidth * innerHeight),
        canvasCount: document.querySelectorAll(".pixi-chart-host canvas").length
      };
    });
    const intensityAudit = parseIntensityAudit(audit.intensity);
    if (
      audit.authority !== "TEST_FIXTURE"
      || audit.grid === "NONE"
      || audit.canvasCount !== 1
      || audit.provenanceAreaRatio > 0.08
      || !audit.market.includes("BTCUSDT")
      || !audit.market.includes("BYBIT")
      || audit.confidence !== "SYNTHETIC · UNSCORED"
      || !intensityAudit
      || intensityAudit.green < 1
      || intensityAudit.yellow < 1
      || intensityAudit.yellow >= intensityAudit.green
      || intensityAudit.green / intensityAudit.cells > 0.02
      || intensityAudit.yellow / intensityAudit.cells > 0.001
    ) {
      throw new Error(`BCLIF deterministic visual precondition failed: ${JSON.stringify(audit)}`);
    }

    const screenshot = await page.screenshot({ animations: "disabled", fullPage: false, type: "png" });
    const artifactPath = join(artifactRoot, testCase.baseline);
    writeFileSync(artifactPath, screenshot);
    const baselinePath = join(goldenRoot, testCase.baseline);
    if (updateGoldens) {
      writeFileSync(baselinePath, screenshot);
      testCase.status = "RECORDED";
      testCase.sha256 = sha256(screenshot);
      testCase.recordedAt = new Date().toISOString();
      results.push({ viewport: `${testCase.width}x${testCase.height}`, decision: "UPDATED", audit });
    } else {
      const baseline = readFileSync(baselinePath);
      const comparison = await comparePng(page, baseline, screenshot);
      const ssimMinimum = Number(testCase.thresholds?.ssimMinimum ?? 0.985);
      const perceptualDeltaMaximum = Number(testCase.thresholds?.meanPerceptualDeltaMaximum ?? 0.025);
      const passed = comparison.ssim >= ssimMinimum && comparison.meanPerceptualDelta <= perceptualDeltaMaximum;
      results.push({
        viewport: `${testCase.width}x${testCase.height}`,
        decision: passed ? "PASS" : "FAIL",
        thresholds: { ssimMinimum, perceptualDeltaMaximum },
        comparison,
        audit,
        baselineSha256: sha256(baseline),
        actualSha256: sha256(screenshot)
      });
      if (!passed) throw new Error(`BCLIF visual threshold failed at ${testCase.width}x${testCase.height}: ${JSON.stringify(comparison)}`);
    }
    await context.close();
    await browser.close();
    browser = null;
  }
  if (updateGoldens) {
    manifest.certificationStatus = "RECORDED";
    delete manifest.blocker;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
} catch (error) {
  failure = error;
} finally {
  if (browser) await browser.close();
  await server.close();
}

const report = {
  decision: failure ? "FAIL" : updateGoldens ? "UPDATED" : "PASS",
  fixture: "BCLIF_DETERMINISTIC_VISUAL_FIXTURE_V2_HIRES",
  renderer: "PIXI_SINGLE_TEXTURE",
  comparison: "8x8 luminance SSIM + normalized YCbCr perceptual delta",
  browserExecutable,
  results,
  error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined
};
console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;

async function comparePng(page, baseline, actual) {
  return page.evaluate(async ({ baselineBase64, actualBase64 }) => {
    const bitmap = async (base64) => {
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
      return createImageBitmap(new Blob([bytes], { type: "image/png" }));
    };
    const [reference, candidate] = await Promise.all([bitmap(baselineBase64), bitmap(actualBase64)]);
    if (reference.width !== candidate.width || reference.height !== candidate.height) {
      throw new Error(`Golden dimensions ${reference.width}x${reference.height} do not match actual ${candidate.width}x${candidate.height}.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = reference.width;
    canvas.height = reference.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(reference, 0, 0);
    const left = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(candidate, 0, 0);
    const right = context.getImageData(0, 0, canvas.width, canvas.height).data;

    let perceptual = 0;
    const luminanceLeft = new Float32Array(canvas.width * canvas.height);
    const luminanceRight = new Float32Array(canvas.width * canvas.height);
    for (let pixel = 0, byte = 0; pixel < luminanceLeft.length; pixel++, byte += 4) {
      const lr = left[byte], lg = left[byte + 1], lb = left[byte + 2];
      const rr = right[byte], rg = right[byte + 1], rb = right[byte + 2];
      const ly = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const ry = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
      luminanceLeft[pixel] = ly;
      luminanceRight[pixel] = ry;
      const lcb = -0.1146 * lr - 0.3854 * lg + 0.5 * lb;
      const rcb = -0.1146 * rr - 0.3854 * rg + 0.5 * rb;
      const lcr = 0.5 * lr - 0.4542 * lg - 0.0458 * lb;
      const rcr = 0.5 * rr - 0.4542 * rg - 0.0458 * rb;
      const dy = ly - ry, dcb = lcb - rcb, dcr = lcr - rcr;
      perceptual += Math.sqrt(0.7 * dy * dy + 0.15 * dcb * dcb + 0.15 * dcr * dcr) / 255;
    }

    const block = 8;
    const c1 = (0.01 * 255) ** 2;
    const c2 = (0.03 * 255) ** 2;
    let ssim = 0;
    let blocks = 0;
    for (let y = 0; y < canvas.height; y += block) {
      for (let x = 0; x < canvas.width; x += block) {
        const width = Math.min(block, canvas.width - x);
        const height = Math.min(block, canvas.height - y);
        const count = width * height;
        let meanLeft = 0, meanRight = 0;
        for (let by = 0; by < height; by++) for (let bx = 0; bx < width; bx++) {
          const index = (y + by) * canvas.width + x + bx;
          meanLeft += luminanceLeft[index];
          meanRight += luminanceRight[index];
        }
        meanLeft /= count;
        meanRight /= count;
        let varianceLeft = 0, varianceRight = 0, covariance = 0;
        for (let by = 0; by < height; by++) for (let bx = 0; bx < width; bx++) {
          const index = (y + by) * canvas.width + x + bx;
          const dl = luminanceLeft[index] - meanLeft;
          const dr = luminanceRight[index] - meanRight;
          varianceLeft += dl * dl;
          varianceRight += dr * dr;
          covariance += dl * dr;
        }
        const denominator = Math.max(1, count - 1);
        varianceLeft /= denominator;
        varianceRight /= denominator;
        covariance /= denominator;
        ssim += ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2))
          / ((meanLeft * meanLeft + meanRight * meanRight + c1) * (varianceLeft + varianceRight + c2));
        blocks += 1;
      }
    }
    reference.close();
    candidate.close();
    return {
      width: canvas.width,
      height: canvas.height,
      ssim: Number((ssim / blocks).toFixed(6)),
      meanPerceptualDelta: Number((perceptual / luminanceLeft.length).toFixed(6))
    };
  }, { baselineBase64: baseline.toString("base64"), actualBase64: actual.toString("base64") });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseIntensityAudit(value) {
  const match = /^max=(\d+);green=(\d+);yellow=(\d+);cells=(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  const [, maximum, green, yellow, cells] = match.map(Number);
  if (![maximum, green, yellow, cells].every(Number.isFinite) || maximum !== 255 || cells < 1) return null;
  return { maximum, green, yellow, cells };
}

function skip(code, message, detail) {
  console.log(JSON.stringify({
    decision: "SKIP",
    code,
    message,
    detail: detail instanceof Error ? detail.message : detail
  }, null, 2));
  process.exit(0);
}
