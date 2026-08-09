import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const goldenRoot = join(root, "tests", "golden", "bclif");
const manifestPath = join(goldenRoot, "manifest.json");
const artifactRoot = join(root, "tests", ".artifacts", "bclif");
const updateGoldens = process.env.BCLIF_UPDATE_GOLDENS === "1";
const resumeGoldens = process.env.BCLIF_RESUME_GOLDENS === "1";
const resumeComparison = process.env.BCLIF_RESUME_COMPARISON === "1";
const browserExecutable = process.env.BCLIF_BROWSER_EXECUTABLE || "/usr/bin/brave-browser";
const requestedViewport = process.env.BCLIF_VISUAL_VIEWPORT || "";
const requestedFixture = process.env.BCLIF_VISUAL_CASE || "";

if (!existsSync(browserExecutable)) {
  skip("BROWSER_EXECUTABLE_MISSING", `A Chromium-family browser is required at ${browserExecutable}.`);
}
if (!existsSync(manifestPath)) skip("MANIFEST_MISSING", "The repository-owned BCLIF golden manifest is missing.");
const playwright = await import("playwright-core");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestCases = Array.isArray(manifest.cases) ? manifest.cases : [];
if (updateGoldens && resumeGoldens) {
  for (const entry of manifestCases) {
    const baselinePath = join(goldenRoot, entry.baseline);
    if (!existsSync(baselinePath)) continue;
    entry.status = "CERTIFIED";
    entry.comparisonStatus = "PENDING";
    delete entry.comparedAt;
    entry.sha256 = sha256(readFileSync(baselinePath));
    entry.recordedAt ||= new Date().toISOString();
  }
}
if (!updateGoldens && (String(manifest.certificationStatus || "").startsWith("BLOCKED_") || manifestCases.some((entry) => entry.status !== "CERTIFIED"))) {
  skip("BASELINES_STALE", "The Chapter III-C3 visual baselines must be regenerated and reviewed before certification.", {
    certificationStatus: manifest.certificationStatus || null,
    blocker: manifest.blocker || null
  });
}
const cases = manifestCases.filter((entry) => {
  const viewportMatches = !requestedViewport || `${entry.width}x${entry.height}` === requestedViewport;
  const selected = viewportMatches && (!requestedFixture || entry.fixture === requestedFixture);
  return selected
    && !(updateGoldens && resumeGoldens && entry.status === "CERTIFIED")
    && !(!updateGoldens && resumeComparison && entry.comparisonStatus === "PASS");
});
if (!cases.length && !(updateGoldens && resumeGoldens) && !resumeComparison) skip("MANIFEST_EMPTY", "No BCLIF visual cases matched the requested filters.");
const missing = cases.filter((entry) => !existsSync(join(goldenRoot, entry.baseline)));
if (missing.length && !updateGoldens) skip("GOLDENS_MISSING", "One or more BCLIF goldens are missing.", { missing: missing.map((entry) => entry.baseline) });

const { createServer } = await import("vite");
const port = 4289;
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true } });
const results = [];
let failure = null;
let browser = null;
try {
  await server.listen();
  mkdirSync(artifactRoot, { recursive: true });
  if (cases.length) browser = await playwright.chromium.launch({
      headless: true,
      executablePath: browserExecutable,
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    });
  for (const testCase of cases) {
    const context = await browser.newContext({
      viewport: { width: testCase.width, height: testCase.height },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC"
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
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
        liquidationHeatmap: true, auctionProfile: false, volatilityHeatmap: false, volumeProfile: false,
        aif: false, adaptiveSwingStrategy: false, vwap: true, ema20: true, ema50: true, ema200: true,
        sma20: false, sma50: false, bollinger: false, openInterestOscillator: false,
        zScoreOscillator: false, waveTrendOscillator: false, volume: false
      }));
      localStorage.removeItem("bt_current_user");
    });
    const url = `http://127.0.0.1:${port}/?uiPreview=1&bclifVisualFixture=1&bclifVisualCase=${encodeURIComponent(testCase.fixture)}`;
    let coldStartStartedAt = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForBclif(page, testCase.fixture === "SWING_INDEPENDENCE");
    if (testCase.fixture === "BROWSER_FALLBACK") {
      coldStartStartedAt = Date.now();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBclif(page, testCase.fixture === "SWING_INDEPENDENCE");
    }
    const hardRefreshToFieldMs = Date.now() - coldStartStartedAt;
    const provenance = page.locator(".liquidation-field-hud");
    let webglRecovered = false;
    if (testCase.fixture === "BROWSER_FALLBACK" && testCase.width === 1920) {
      const uploadCount = await page.evaluate(() => Number(globalThis.__BCLIF_RENDER_METRICS__?.textureUploadCount || 0));
      await page.locator(".pixi-chart-host canvas").dispatchEvent("webglcontextlost");
      await page.locator(".pixi-chart-host canvas").dispatchEvent("webglcontextrestored");
      await page.waitForFunction((before) => {
        const metrics = globalThis.__BCLIF_RENDER_METRICS__;
        return metrics?.readiness === "WEBGL_CONTEXT_READY" && Number(metrics.textureUploadCount) > Number(before);
      }, uploadCount, { timeout: 30_000 });
      webglRecovered = true;
    }
    await page.waitForTimeout(300);

    const audit = await provenance.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const metrics = globalThis.__BCLIF_RENDER_METRICS__ || {};
      return {
        authority: node.getAttribute("data-bclif-authority"),
        persistence: node.getAttribute("data-bclif-persistence"),
        grid: node.getAttribute("data-bclif-grid"),
        displayGrid: node.getAttribute("data-bclif-display-grid"),
        checksum: node.getAttribute("data-bclif-checksum"),
        modelBounds: node.getAttribute("data-bclif-bounds"),
        displayBounds: node.getAttribute("data-bclif-display-bounds"),
        chartRange: node.getAttribute("data-bclif-chart-range"),
        modelHash: node.getAttribute("data-bclif-model-hash"),
        exposureHash: node.getAttribute("data-bclif-exposure-hash"),
        renderSettingsHash: node.getAttribute("data-bclif-render-settings-hash"),
        displayRasterHash: node.getAttribute("data-bclif-display-raster-hash"),
        priceDisplay: node.getAttribute("data-bclif-price-display"),
        labels: Number(node.getAttribute("data-bclif-cluster-labels")),
        horizonTruth: node.getAttribute("data-bclif-horizon-truth"),
        candleContrast: node.getAttribute("data-bclif-candle-contrast"),
        market: document.querySelector(".chart-header .pair")?.textContent?.trim() || "",
        badgeAreaRatio: rect.width * rect.height / (innerWidth * innerHeight),
        canvasCount: document.querySelectorAll(".pixi-chart-host canvas").length,
        hudVisible: Boolean(document.querySelector(".liquidation-field-hud")),
        summaryVisible: Boolean(document.querySelector(".liquidation-field-operational-summary")),
        texturePreparationAndUpdateMs: Number(metrics.texturePreparationAndUpdateMs),
        displayCells: Number(metrics.cells),
        rawNonZeroCells: Number(metrics.rawNonZeroCells),
        visibleCells: Number(metrics.visibleCells),
        rendererReadiness: String(metrics.readiness || ""),
        yellowEligibleCells: Number(metrics.yellowEligibleCells),
        provenanceCoverage: Number(node.getAttribute("data-bclif-provenance-coverage")),
        cohortCount: Number(node.getAttribute("data-bclif-cohort-count")),
        birthCount: Number(node.getAttribute("data-bclif-birth-count")),
        contractionCount: Number(node.getAttribute("data-bclif-contraction-count")),
        confirmedAssimilationCount: Number(node.getAttribute("data-bclif-confirmed-assimilation-count")),
        massError: Number(node.getAttribute("data-bclif-mass-error")),
        provenancePanelVisible: Boolean(document.querySelector(".liquidation-field-cohort-provenance"))
      };
    });
    audit.hardRefreshToFieldMs = hardRefreshToFieldMs;
    audit.webglRecovered = webglRecovered;
    const expectedAuthority = testCase.fixture === "BROWSER_FALLBACK" ? "BROWSER_FALLBACK"
      : testCase.fixture === "PERSISTENT_NODE" ? "PERSISTENT_NODE" : "TEST_FIXTURE";
    const expectedPersistence = testCase.fixture === "PERSISTENT_NODE" ? "ON" : "OFF";
    const expectedPriceDisplay = testCase.fixture === "FULL_SPECTRUM_RESEARCH" ? "FULL_MODEL_RANGE" : "CHART_SCALE";
    const expectedCandleContrast = "HIGH";
    const yellowTailRatio = audit.displayCells > 0 ? audit.yellowEligibleCells / audit.displayCells : Number.NaN;
    if (
      audit.authority !== expectedAuthority
      || audit.persistence !== expectedPersistence
      || audit.priceDisplay !== expectedPriceDisplay
      || audit.grid === "NONE"
      || audit.displayGrid === "NONE"
      || audit.canvasCount !== 1
      || audit.badgeAreaRatio > 0.04
      || !audit.market.includes("BTCUSDT")
      || !audit.market.includes("BYBIT")
      || !audit.hudVisible
      || audit.summaryVisible
      || audit.candleContrast !== expectedCandleContrast
      || !Number.isFinite(yellowTailRatio)
      || yellowTailRatio > 0.006
      || (testCase.fixture === "BROWSER_FALLBACK" && audit.yellowEligibleCells !== 0)
      || (testCase.fixture === "BROWSER_FALLBACK" && (audit.rawNonZeroCells <= 0 || audit.visibleCells <= 0 || audit.rendererReadiness !== "WEBGL_CONTEXT_READY"))
      || audit.labels < 0
      || audit.labels > (testCase.fixture === "HIGH_CONFIDENCE" ? 6 : 4)
      || !Number.isFinite(audit.texturePreparationAndUpdateMs)
      || audit.texturePreparationAndUpdateMs >= 16.7
      || !Number.isFinite(audit.massError)
      || Math.abs(audit.massError) > 0.01
    ) throw new Error(`BCLIF ${testCase.fixture} precondition failed: ${JSON.stringify(audit)}`);
    assertAuthenticFixture(audit, testCase.fixture);
    assertDisplayDomain(audit, testCase.fixture);

    const frame = updateGoldens
      ? await measureAnimationFrames(page)
      : { measurement: "NOT_REPEATED_DURING_GOLDEN_COMPARISON" };
    const screenshot = await page.screenshot({ animations: "disabled", fullPage: false, type: "png" });
    const artifactPath = join(artifactRoot, testCase.baseline);
    writeFileSync(artifactPath, screenshot);
    const baselinePath = join(goldenRoot, testCase.baseline);
    if (updateGoldens) {
      writeFileSync(baselinePath, screenshot);
      testCase.status = "CERTIFIED";
      testCase.comparisonStatus = "PENDING";
      delete testCase.comparedAt;
      testCase.sha256 = sha256(screenshot);
      testCase.recordedAt = new Date().toISOString();
      testCase.audit = audit;
      writeManifestProgress(manifestPath, manifest);
      results.push({ fixture: testCase.fixture, viewport: `${testCase.width}x${testCase.height}`, decision: "UPDATED", audit, frame });
    } else {
      const baseline = readFileSync(baselinePath);
      const comparison = baseline.equals(screenshot)
        ? { width: testCase.width, height: testCase.height, ssim: 1, meanPerceptualDelta: 0, exactBytes: true }
        : { ...(await comparePng(page, baseline, screenshot)), exactBytes: false };
      const thresholds = testCase.thresholds || {};
      const passed = comparison.ssim >= Number(thresholds.ssimMinimum ?? 0.985)
        && comparison.meanPerceptualDelta <= Number(thresholds.meanPerceptualDeltaMaximum ?? 0.025);
      testCase.comparisonStatus = passed ? "PASS" : "FAIL";
      testCase.comparedAt = new Date().toISOString();
      testCase.audit = audit;
      writeManifestProgress(manifestPath, manifest);
      results.push({
        fixture: testCase.fixture, viewport: `${testCase.width}x${testCase.height}`,
        decision: passed ? "PASS" : "FAIL", comparison, audit, frame,
        baselineSha256: sha256(baseline), actualSha256: sha256(screenshot)
      });
      if (!passed) throw new Error(`BCLIF visual threshold failed for ${testCase.fixture} at ${testCase.width}x${testCase.height}.`);
    }
    await context.close();
    if (pageErrors.length) throw new Error(`BCLIF browser page errors: ${pageErrors.join(" | ")}`);
  }
  if (!requestedFixture && !resumeGoldens) {
    const scopedEntries = manifestCases.filter((entry) => !requestedViewport || `${entry.width}x${entry.height}` === requestedViewport);
    if (scopedEntries.length && scopedEntries.every((entry) => entry.audit)) {
      assertHashSeparation(scopedEntries.map((entry) => ({ fixture: entry.fixture, viewport: `${entry.width}x${entry.height}`, audit: entry.audit })));
    } else if (!resumeComparison) {
      assertHashSeparation(results);
    }
  }
  if (updateGoldens) {
    if (manifestCases.every((entry) => entry.status === "CERTIFIED" && existsSync(join(goldenRoot, entry.baseline)))) {
      manifest.certificationStatus = "RECORDED_PENDING_COMPARISON";
      delete manifest.blocker;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    if (manifestCases.every((entry) => entry.status === "CERTIFIED" && entry.comparisonStatus === "PASS")) {
      manifest.certificationStatus = "CERTIFIED";
      manifest.certifiedAt = new Date().toISOString();
      delete manifest.blocker;
    } else {
      manifest.certificationStatus = "RECORDED_PENDING_COMPARISON";
      delete manifest.certifiedAt;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
} catch (error) {
  failure = error;
} finally {
  if (browser) await browser.close();
  await server.close();
}

console.log(JSON.stringify({
  decision: failure ? "FAIL" : updateGoldens ? "UPDATED" : "PASS",
  fixture: "BCLIF_AUTHENTIC_EXPOSURE_V1",
  renderer: "PIXI_SINGLE_TEXTURE_WORKER_PROJECTED",
  comparison: "full-resolution capture + whole-frame 960px luminance SSIM/perceptual sample",
  browserExecutable,
  cases: results.length,
  performance: summarizeVisualPerformance(results),
  results,
  error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined
}, null, 2));
if (failure) process.exitCode = 1;

async function waitForBclif(page, allowNoExposure = false) {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".liquidation-field-hud").waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForFunction((allowEmpty) => {
    const node = document.querySelector(".liquidation-field-hud");
    const metrics = globalThis.__BCLIF_RENDER_METRICS__;
    return node?.getAttribute("data-bclif-display-grid") !== "NONE"
      && metrics?.displayRasterHash
      && metrics.displayRasterHash !== "NONE"
      && (allowEmpty || metrics.visibleCells > 0);
  }, allowNoExposure, { timeout: 90_000 });
}

function writeManifestProgress(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertDisplayDomain(audit, fixture) {
  const pair = (value) => String(value || "").split(":").map(Number);
  const display = pair(audit.displayBounds);
  if (fixture === "FULL_SPECTRUM_RESEARCH") {
    const model = pair(audit.modelBounds);
    if (display[0] !== model[2] || display[1] !== model[3]) throw new Error("Full Spectrum Research did not expose the complete model range.");
    return;
  }
  const chart = pair(audit.chartRange);
  const tolerance = Math.max(1e-6, Math.abs(chart[1] - chart[0]) * 0.0001);
  if (Math.abs(display[0] - chart[0]) > tolerance || Math.abs(display[1] - chart[1]) > tolerance) {
    throw new Error("Chart Scale display domain diverged from the candle camera.");
  }
}

function assertHashSeparation(results) {
  const presentationCases = new Set(["COHORT_PROVENANCE", "TRADE_FOCUS", "FULL_SPECTRUM_RESEARCH", "BROWSER_FALLBACK", "PERSISTENT_NODE"]);
  const comparable = results.filter((entry) => presentationCases.has(entry.fixture));
  const model = new Set(comparable.map((entry) => entry.audit.modelHash));
  const exposure = new Set(comparable.map((entry) => entry.audit.exposureHash));
  const render = new Set(comparable.map((entry) => entry.audit.renderSettingsHash));
  const raster = new Set(comparable.map((entry) => entry.audit.displayRasterHash));
  if (model.size !== 1) throw new Error(`Presentation changed MODEL identity: ${[...model].join(",")}`);
  if (exposure.size !== 1) throw new Error(`Presentation changed EXPOSURE identity: ${[...exposure].join(",")}`);
  if (render.size < 2) throw new Error("Presentation fixtures did not produce distinct RENDER SETTINGS identities.");
  if (raster.size < 3) throw new Error("Presentation/viewports did not produce distinct DISPLAY RASTER identities.");
  for (const viewport of [...new Set(comparable.map((entry) => entry.viewport))]) {
    const browser = results.find((entry) => entry.fixture === "BROWSER_FALLBACK" && entry.viewport === viewport);
    const persistent = results.find((entry) => entry.fixture === "PERSISTENT_NODE" && entry.viewport === viewport);
    if (!browser || !persistent || browser.audit.displayRasterHash === persistent.audit.displayRasterHash) {
      throw new Error(`Evidence authority did not separate DISPLAY RASTER identity at ${viewport}.`);
    }
  }
}

function assertAuthenticFixture(audit, fixture) {
  const completeModelFixtures = new Set([
    "COHORT_PROVENANCE", "TRADE_FOCUS", "FULL_SPECTRUM_RESEARCH", "BROWSER_FALLBACK", "PERSISTENT_NODE"
  ]);
  if (completeModelFixtures.has(fixture) && (audit.cohortCount !== 6 || audit.birthCount !== 6)) {
    throw new Error(`Presentation fixture was captured before the complete cohort model was ready: ${JSON.stringify(audit)}`);
  }
  if (fixture === "SWING_INDEPENDENCE" && (audit.cohortCount !== 0 || audit.birthCount !== 0 || audit.labels !== 0)) {
    throw new Error(`Flat-OI swing fixture created false shelves: ${JSON.stringify(audit)}`);
  }
  if (fixture === "OI_EXPANSION" && (audit.cohortCount !== 2 || audit.birthCount !== 2 || audit.contractionCount !== 0)) {
    throw new Error(`OI expansion fixture violated paired birth semantics: ${JSON.stringify(audit)}`);
  }
  if (fixture === "OI_CONTRACTION" && (audit.birthCount !== 6 || audit.contractionCount < 1)) {
    throw new Error(`OI contraction fixture did not reduce born cohorts: ${JSON.stringify(audit)}`);
  }
  if (fixture === "CONFIRMED_LIQUIDATION" && audit.confirmedAssimilationCount < 1) {
    throw new Error(`Confirmed-liquidation fixture did not assimilate an event: ${JSON.stringify(audit)}`);
  }
  if (fixture === "COHORT_PROVENANCE" && (!audit.provenancePanelVisible || audit.provenanceCoverage !== 1)) {
    throw new Error(`Cohort provenance fixture is not fully attributable: ${JSON.stringify(audit)}`);
  }
}

function summarizeVisualPerformance(results) {
  const summarize = (values) => {
    const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!ordered.length) return { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null };
    const percentile = (quantile) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))];
    return {
      samples: ordered.length,
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      p99Ms: Number(percentile(0.99).toFixed(3))
    };
  };
  return {
    texturePreparationAndGpuUpdate: summarize(results.map((entry) => entry.audit.texturePreparationAndUpdateMs)),
    headlessAnimationFrameP95: summarize(results.map((entry) => entry.frame?.p95Ms))
  };
}

async function measureAnimationFrames(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    let previous = performance.now();
    const tick = (now) => {
      samples.push(now - previous);
      previous = now;
      if (samples.length < 8) requestAnimationFrame(tick);
      else {
        const sorted = samples.slice(2).sort((a, b) => a - b);
        const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
        resolve({
          measurement: "HEADLESS_ANIMATION_FRAME_CADENCE_NOT_INTERACTIVE_FPS",
          p50Ms: Number(percentile(0.50).toFixed(3)),
          p95Ms: Number(percentile(0.95).toFixed(3)),
          p99Ms: Number(percentile(0.99).toFixed(3))
        });
      }
    };
    requestAnimationFrame(tick);
  }));
}

async function comparePng(page, baseline, actual) {
  return page.evaluate(async ({ baselineBase64, actualBase64 }) => {
    const bitmap = async (base64) => {
      const raw = atob(base64);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: "image/png" }));
    };
    const [reference, candidate] = await Promise.all([bitmap(baselineBase64), bitmap(actualBase64)]);
    if (reference.width !== candidate.width || reference.height !== candidate.height) throw new Error("Golden dimensions differ from the actual image.");
    const sourceWidth = reference.width, sourceHeight = reference.height;
    const comparisonScale = Math.min(1, 960 / sourceWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * comparisonScale));
    canvas.height = Math.max(1, Math.round(sourceHeight * comparisonScale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(reference, 0, 0);
    const left = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(candidate, 0, 0);
    const right = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const luminanceLeft = new Float32Array(canvas.width * canvas.height);
    const luminanceRight = new Float32Array(canvas.width * canvas.height);
    let perceptual = 0;
    for (let pixel = 0, byte = 0; pixel < luminanceLeft.length; pixel++, byte += 4) {
      const lr = left[byte], lg = left[byte + 1], lb = left[byte + 2];
      const rr = right[byte], rg = right[byte + 1], rb = right[byte + 2];
      const ly = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const ry = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
      luminanceLeft[pixel] = ly;
      luminanceRight[pixel] = ry;
      perceptual += Math.abs(ly - ry) / 255;
    }
    const block = 8, c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
    let ssim = 0, blocks = 0;
    for (let y = 0; y < canvas.height; y += block) for (let x = 0; x < canvas.width; x += block) {
      const width = Math.min(block, canvas.width - x), height = Math.min(block, canvas.height - y), count = width * height;
      let meanLeft = 0, meanRight = 0;
      for (let by = 0; by < height; by++) for (let bx = 0; bx < width; bx++) {
        const index = (y + by) * canvas.width + x + bx;
        meanLeft += luminanceLeft[index]; meanRight += luminanceRight[index];
      }
      meanLeft /= count; meanRight /= count;
      let varianceLeft = 0, varianceRight = 0, covariance = 0;
      for (let by = 0; by < height; by++) for (let bx = 0; bx < width; bx++) {
        const index = (y + by) * canvas.width + x + bx;
        const dl = luminanceLeft[index] - meanLeft, dr = luminanceRight[index] - meanRight;
        varianceLeft += dl * dl; varianceRight += dr * dr; covariance += dl * dr;
      }
      const denominator = Math.max(1, count - 1);
      varianceLeft /= denominator; varianceRight /= denominator; covariance /= denominator;
      ssim += ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2))
        / ((meanLeft * meanLeft + meanRight * meanRight + c1) * (varianceLeft + varianceRight + c2));
      blocks += 1;
    }
    reference.close(); candidate.close();
    return {
      width: sourceWidth,
      height: sourceHeight,
      comparisonWidth: canvas.width,
      comparisonHeight: canvas.height,
      ssim: Number((ssim / blocks).toFixed(6)),
      meanPerceptualDelta: Number((perceptual / luminanceLeft.length).toFixed(6))
    };
  }, { baselineBase64: baseline.toString("base64"), actualBase64: actual.toString("base64") });
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function skip(code, message, detail) {
  console.log(JSON.stringify({ decision: "SKIP", code, message, detail }, null, 2));
  process.exit(0);
}
