import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = join(root, "tests", ".artifacts", "bclif-emergency-live");
const browserExecutable = process.env.BCLIF_BROWSER_EXECUTABLE || "/usr/bin/brave-browser";
const symbols = (process.env.BCLIF_SMOKE_SYMBOLS || "BTCUSDT")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const timeframes = (process.env.BCLIF_SMOKE_TIMEFRAMES || "1h,4h")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const switchTimeframe = (process.env.BCLIF_SMOKE_SWITCH_TIMEFRAME || "").trim().toLowerCase();
const port = Number(process.env.BCLIF_SMOKE_PORT || 4291);
const readinessTimeout = Number(process.env.BCLIF_SMOKE_READINESS_TIMEOUT_MS || 180_000);

if (!existsSync(browserExecutable)) {
  throw new Error(`BCLIF_BROWSER_EXECUTABLE_MISSING:${browserExecutable}`);
}

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true }
});
let browser;
const results = [];

try {
  await server.listen();
  mkdirSync(artifactRoot, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    ]
  });

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        colorScheme: "dark",
        locale: "en-US",
        timezoneId: "UTC"
      });
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.setDefaultTimeout(180_000);
      page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.addInitScript(({ requestedTimeframe }) => {
        localStorage.setItem("bt_active_nav", "CHART");
        localStorage.setItem("bt_last_timeframe", requestedTimeframe);
        localStorage.setItem("bt_terminal_settings", JSON.stringify({
          showDOM: false,
          enabledTimeframes: ["1m", "5m", "15m", "1h", "4h", "1d"]
        }));
        localStorage.setItem("bt_visible_indicators_v1", JSON.stringify({
          liquidationHeatmap: true,
          auctionProfile: false,
          volatilityHeatmap: false,
          volumeProfile: false,
          aif: false,
          adaptiveSwingStrategy: false,
          vwap: false,
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
      }, { requestedTimeframe: timeframe });

      try {
        const startedAt = Date.now();
        await page.goto(`http://127.0.0.1:${port}/?uiPreview=1&bclifLiveProbe=1`, { waitUntil: "domcontentloaded" });
        await selectBybit(page);
        await selectSymbol(page, symbol);
        await selectTimeframe(page, timeframe);
        await page.waitForFunction(({ requestedSymbol }) => {
          const market = document.querySelector(".chart-header .pair")?.textContent || "";
          const truth = globalThis.__BCLIF_RENDER_TRUTH__;
          return market.toUpperCase().includes(requestedSymbol)
            && truth?.safeCompositingPlane === true
            && Number(truth?.rawNonZeroCells) > 0
            && Number(truth?.finalVisiblePixels) > 0
            && Number(truth?.exposureVisiblePixels) > 0
            && Number(truth?.maximumAlpha) > 0
            && truth?.viewportIntersection === true
            && truth?.drawPassActive === true
            && ["WEBGL_CONTEXT_READY", "SAFE_FALLBACK_ACTIVE"].includes(String(truth?.readiness));
        }, { requestedSymbol: symbol }, { timeout: readinessTimeout });
        console.log(`BCLIF_SMOKE_STAGE:${symbol}:${timeframe}:FIELD_READY`);

        const before = await readTruth(page);
        await page.locator(".pixi-chart-host canvas").hover();
        await page.mouse.wheel(0, -550);
        await page.waitForTimeout(800);
        const after = await readTruth(page);
        if (before.modelHash !== after.modelHash || before.exposureHash !== after.exposureHash) {
          throw new Error("BCLIF_CAMERA_MUTATED_MODEL_STATE");
        }
        assertTruth(after);
        console.log(`BCLIF_SMOKE_STAGE:${symbol}:${timeframe}:BASELINE_VALID`);

        const ui = await page.evaluate(() => ({
          quickControlCount: document.querySelectorAll('[aria-label="BCLIF quick controls"]').length,
          quickIntensity: document.querySelector('[aria-label="BCLIF quick intensity"]')?.value ?? null,
          quickRange: document.querySelector('[aria-label="BCLIF range"]')?.value ?? null,
          quickTheme: document.querySelector('[aria-label="BCLIF thermal theme"]')?.value ?? null,
          compactBadgeCount: document.querySelectorAll(".liquidation-field-hud").length,
          expandedDiagnostics: document.querySelectorAll(".liquidation-field-hud[open]").length,
          operationalSummaryCount: document.querySelectorAll(".liquidation-field-operational-summary").length,
          shelfLabelCount: document.querySelectorAll(".liquidation-field-cluster-label").length,
          fieldRect: globalThis.__BCLIF_RENDER_TRUTH__?.worldBounds ?? null,
          clipRect: globalThis.__BCLIF_RENDER_TRUTH__?.clipRect ?? null
        }));
        if (ui.expandedDiagnostics !== 0 || ui.operationalSummaryCount !== 0 || ui.shelfLabelCount !== 0) {
          throw new Error(`BCLIF_DEFAULT_OVERLAY_INTRUSION:${JSON.stringify(ui)}`);
        }
        if (ui.quickControlCount !== 1
          || ui.quickIntensity !== "100"
          || ui.quickRange !== "AUTO"
          || ui.quickTheme !== "REFERENCE_THERMAL") {
          throw new Error(`BCLIF_C7_QUICK_CONTROL_DEFAULTS_INVALID:${JSON.stringify(ui)}`);
        }
        const screenshot = join(artifactRoot, `${symbol}-${timeframe}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });

        await page.getByLabel("BCLIF range").selectOption("SWING");
        await page.getByLabel("BCLIF thermal theme").selectOption("BLACK_TERMINAL_BLOOD");
        await page.getByLabel("BCLIF quick intensity").evaluate((node, value) => {
          const input = /** @type {HTMLInputElement} */ (node);
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, "150");
        console.log(`BCLIF_SMOKE_STAGE:${symbol}:${timeframe}:PRESENTATION_CHANGED`);
        await page.waitForFunction(({ modelHash, exposureHash, renderSettingsHash }) => {
          const truth = globalThis.__BCLIF_RENDER_TRUTH__;
          return truth?.modelHash === modelHash
            && truth?.exposureHash === exposureHash
            && truth?.renderSettingsHash !== renderSettingsHash
            && Number(truth?.finalVisiblePixels) > 0;
        }, {
          modelHash: after.modelHash,
          exposureHash: after.exposureHash,
          renderSettingsHash: after.renderSettingsHash
        }, { timeout: 30_000 });
        const presentationChanged = await readTruth(page);
        assertTruth(presentationChanged);
        console.log(`BCLIF_SMOKE_STAGE:${symbol}:${timeframe}:PRESENTATION_VALID`);

        await page.getByLabel("BCLIF range").selectOption("AUTO");
        await page.getByLabel("BCLIF thermal theme").selectOption("REFERENCE_THERMAL");
        await page.getByLabel("BCLIF quick intensity").evaluate((node, value) => {
          const input = /** @type {HTMLInputElement} */ (node);
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, "100");
        await page.waitForFunction(({ changedRenderSettingsHash }) => {
          const truth = globalThis.__BCLIF_RENDER_TRUTH__;
          const intensity = document.querySelector('[aria-label="BCLIF quick intensity"]');
          const range = document.querySelector('[aria-label="BCLIF range"]');
          const theme = document.querySelector('[aria-label="BCLIF thermal theme"]');
          const unavailable = /unavailable/i.test(document.querySelector(".liquidation-field-hud")?.textContent || "");
          return (truth?.renderSettingsHash !== changedRenderSettingsHash || unavailable)
            && intensity?.value === "100"
            && range?.value === "AUTO"
            && theme?.value === "REFERENCE_THERMAL";
        }, {
          changedRenderSettingsHash: presentationChanged.renderSettingsHash
        }, { timeout: 30_000 });
        const restored = await readTruth(page);
        if (Number(restored.finalVisiblePixels) > 0) assertTruth(restored);
        console.log(`BCLIF_SMOKE_STAGE:${symbol}:${timeframe}:RESTORED_VALID`);
        results.push({
          decision: "PASS",
          symbol,
          timeframe,
          authority: await page.locator(".liquidation-field-hud").getAttribute("data-bclif-authority"),
          elapsedMs: Date.now() - startedAt,
          screenshot,
          truth: after,
          ui,
          c7PresentationProof: {
            beforeRenderSettingsHash: after.renderSettingsHash,
            changedRenderSettingsHash: presentationChanged.renderSettingsHash,
            restoredRenderSettingsHash: restored.renderSettingsHash,
            modelHashStableDuringPresentationChange: after.modelHash === presentationChanged.modelHash,
            exposureHashStableDuringPresentationChange: after.exposureHash === presentationChanged.exposureHash,
            restorationAcceptedIndependentLiveUpdates: true,
            restoredControlsDefault: true,
            restoredFieldAvailable: Number(restored.finalVisiblePixels) > 0
          },
          pageErrors,
          consoleErrors: consoleErrors.filter((value) => !isExpectedNetworkNoise(value))
        });
        if (switchTimeframe && switchTimeframe !== timeframe) {
          await selectTimeframe(page, switchTimeframe);
          await page.waitForFunction(({ expectedModelHash, expectedExposureHash }) => {
            const truth = globalThis.__BCLIF_RENDER_TRUTH__;
            return truth?.modelHash === expectedModelHash
              && truth?.exposureHash === expectedExposureHash
              && truth?.safeCompositingPlane === true
              && Number(truth?.rawNonZeroCells) > 0
              && Number(truth?.finalVisiblePixels) > 0
              && Number(truth?.exposureVisiblePixels) > 0
              && truth?.viewportIntersection === true
              && truth?.drawPassActive === true;
          }, {
            expectedModelHash: after.modelHash,
            expectedExposureHash: after.exposureHash
          }, { timeout: 180_000 });
          const switchedTruth = await readTruth(page);
          assertTruth(switchedTruth);
          const switchedUi = await page.evaluate(() => ({
            compactBadgeCount: document.querySelectorAll(".liquidation-field-hud").length,
            expandedDiagnostics: document.querySelectorAll(".liquidation-field-hud[open]").length,
            operationalSummaryCount: document.querySelectorAll(".liquidation-field-operational-summary").length,
            shelfLabelCount: document.querySelectorAll(".liquidation-field-cluster-label").length,
            fieldRect: globalThis.__BCLIF_RENDER_TRUTH__?.worldBounds ?? null,
            clipRect: globalThis.__BCLIF_RENDER_TRUTH__?.clipRect ?? null
          }));
          if (switchedUi.expandedDiagnostics !== 0
            || switchedUi.operationalSummaryCount !== 0
            || switchedUi.shelfLabelCount !== 0) {
            throw new Error(`BCLIF_DEFAULT_OVERLAY_INTRUSION_AFTER_TIMEFRAME_SWITCH:${JSON.stringify(switchedUi)}`);
          }
          const switchedScreenshot = join(artifactRoot, `${symbol}-${switchTimeframe}.png`);
          await page.screenshot({ path: switchedScreenshot, fullPage: true });
          results.push({
            decision: "PASS",
            symbol,
            timeframe: switchTimeframe,
            authority: await page.locator(".liquidation-field-hud").getAttribute("data-bclif-authority"),
            elapsedMs: Date.now() - startedAt,
            screenshot: switchedScreenshot,
            truth: switchedTruth,
            ui: switchedUi,
            pageErrors,
            consoleErrors: consoleErrors.filter((value) => !isExpectedNetworkNoise(value)),
            transitionProof: `${timeframe}->${switchTimeframe}; model/exposure hashes unchanged`
          });
        }
      } catch (error) {
        const screenshot = join(artifactRoot, `${symbol}-${timeframe}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
        const failureTruth = await readTruth(page).catch(() => null);
        const failureMarket = await page.locator(".chart-header .pair").textContent().catch(() => null);
        throw new Error(`${symbol}/${timeframe}: ${error instanceof Error ? error.message : String(error)}; screenshot=${screenshot}; market=${JSON.stringify(failureMarket)}; truth=${JSON.stringify(failureTruth)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`);
      } finally {
        await context.close();
      }
    }
  }

  const report = {
    decision: "PASS",
    evidenceBoundary: "LOCAL_BROWSER_UI_WITH_REAL_BYBIT_PUBLIC_MARKET_DATA; AUTHORITY_RECORDED_PER_CASE; NO_SYNTHETIC_BCLIF_FIXTURE; NOT_A_PRODUCTION_AUTH_SESSION",
    cases: results
  };
  writeFileSync(join(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const result of results) {
    writeFileSync(
      join(artifactRoot, `${result.symbol}-${result.timeframe}-report.json`),
      `${JSON.stringify({ ...report, cases: [result] }, null, 2)}\n`
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

async function selectBybit(page) {
  const control = page.locator(".exchange-control");
  if ((await control.textContent())?.toUpperCase().includes("BYBIT")) return;
  await control.click();
  await page.locator(".exchange-menu .menu-option", { hasText: "Bybit" }).click();
  await page.waitForFunction(() => document.querySelector(".exchange-control")?.textContent?.toUpperCase().includes("BYBIT"));
}

async function selectSymbol(page, symbol) {
  await page.locator(".symbol-control").click();
  const input = page.locator(".symbol-menu input");
  await input.fill(symbol);
  await page.waitForFunction((requestedSymbol) => {
    return Array.from(document.querySelectorAll(".symbol-menu .menu-option"))
      .some((node) => node.textContent?.toUpperCase().includes(requestedSymbol));
  }, symbol);
  await input.press("Enter");
  await page.waitForFunction((requestedSymbol) => document.querySelector(".symbol-control")?.textContent?.toUpperCase().includes(requestedSymbol), symbol);
}

async function selectTimeframe(page, timeframe) {
  const button = page.locator(".timeframes > button", { hasText: timeframe.toUpperCase() }).first();
  await button.click();
  await page.waitForFunction((value) => localStorage.getItem("bt_last_timeframe") === value, timeframe);
}

async function readTruth(page) {
  return page.evaluate(() => {
    const truth = globalThis.__BCLIF_RENDER_TRUTH__ || {};
    return {
      rendererVersion: truth.rendererVersion,
      readiness: truth.readiness,
      modelHash: truth.modelHash,
      exposureHash: truth.exposureHash,
      displayRasterHash: truth.displayRasterHash,
      renderSettingsHash: truth.renderSettingsHash,
      rawMinimum: truth.rawExposureRange?.minimum,
      rawMaximum: truth.rawExposureRange?.maximum,
      normalizedMinimum: truth.normalizedScalarRange?.minimum,
      normalizedMaximum: truth.normalizedScalarRange?.maximum,
      confidenceMinimum: truth.confidenceRange?.minimum,
      confidenceMaximum: truth.confidenceRange?.maximum,
      validityRatio: truth.validityRatio,
      minimumAlpha: truth.minimumAlpha,
      maximumAlpha: truth.maximumAlpha,
      finalVisiblePixels: truth.finalVisiblePixels,
      exposureVisiblePixels: truth.exposureVisiblePixels,
      visiblePixelCoverage: truth.visiblePixelCoverage,
      safeCompositingPlane: truth.safeCompositingPlane,
      fallbackActive: truth.fallbackActive,
      shaderUploadSucceeded: truth.shaderUploadSucceeded,
      shaderError: truth.shaderError,
      scalarTextureFormat: truth.scalarTextureFormat,
      textureCount: truth.textures,
      viewportIntersection: truth.viewportIntersection,
      drawPassActive: truth.drawPassActive,
      clipRect: truth.clipRect,
      worldBounds: truth.worldBounds,
      zOrder: truth.zOrder,
      maskAttached: truth.maskActive,
      uniforms: truth.shaderUniformState,
      fieldMetrics: truth.fieldMetrics
    };
  });
}

function assertTruth(truth) {
  if (!(Number(truth.rawMaximum) > 0)) throw new Error("BCLIF_RAW_EXPOSURE_EMPTY");
  if (!(Number(truth.finalVisiblePixels) > 0 && Number(truth.exposureVisiblePixels) > 0)) {
    throw new Error("BCLIF_RENDER_VISIBILITY_FAILURE");
  }
  if (!(Number(truth.maximumAlpha) > 0)) throw new Error("BCLIF_ALPHA_OUTPUT_EMPTY");
  if (!truth.safeCompositingPlane || !truth.viewportIntersection || !truth.drawPassActive || !truth.maskAttached) {
    throw new Error(`BCLIF_PLACEMENT_INVALID:${JSON.stringify(truth)}`);
  }
  const occupancy = truth.fieldMetrics?.thermalOccupancyPercent;
  if (!occupancy || occupancy.deepPurple < 25 || occupancy.blueCyan < 8 || occupancy.green < 1 || occupancy.yellow > 4) {
    throw new Error(`BCLIF_REFERENCE_THERMAL_DISTRIBUTION_INVALID:${JSON.stringify(occupancy)}`);
  }
}

function isExpectedNetworkNoise(value) {
  return /supabase|black-cloud|api\/black-core/i.test(value) && /failed|404|401|403/i.test(value);
}
