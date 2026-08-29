import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.MY_STRATEGY_VISUAL_URL || "http://127.0.0.1:4178";
const output = path.resolve("docs/strategy-automation/visual-regression");
const executablePath = process.env.BROWSER_EXECUTABLE || "/usr/bin/brave-browser";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu-sandbox"] });
const sizes = [[1920, 1080], [2560, 1440], [3840, 2160]];
const captures = [];
const pageErrors = [];

for (const [width, height] of sizes) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(() => { localStorage.setItem("bt_active_nav", "STRATEGY LAB"); localStorage.setItem("bt_last_timeframe", "15m"); });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await open(page, "library");
  await capture(page, `library-${width}x${height}`);

  await open(page, "wizard");
  for (const [step, name] of [[1, "wizard-indicator-market"], [2, "wizard-signal-mapping"], [4, "wizard-risk"], [7, "wizard-paper"], [8, "wizard-live-targets"], [9, "wizard-review"]]) {
    await page.locator(".strategy-wizard-stepper button").nth(step).click({ force: true });
    await page.waitForTimeout(80);
    await capture(page, `${name}-${width}x${height}`);
  }

  await open(page, "cockpit");
  await capture(page, `cockpit-overview-${width}x${height}`);
  await page.getByLabel("Strategy cockpit sections").getByRole("button", { name: "EXECUTION DESK", exact: true }).click({ force: true });
  await page.waitForTimeout(1_200);
  await page.locator(".execution-desk").waitFor({ state: "visible", timeout: 10_000 });
  await capture(page, `cockpit-execution-desk-${width}x${height}`);
  await page.getByRole("button", { name: "Open strategy execution settings" }).click({ force: true });
  await page.locator(".strategy-control-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await assertControlDialog(page, height);
  await capture(page, `cockpit-superatr-inputs-${width}x${height}`);
  await page.getByRole("navigation", { name: "Strategy settings sections" }).getByRole("button", { name: "PROPERTIES" }).click();
  await capture(page, `cockpit-superatr-properties-${width}x${height}`);
  await page.getByRole("navigation", { name: "Strategy settings sections" }).getByRole("button", { name: "STYLE" }).click();
  await capture(page, `cockpit-superatr-style-${width}x${height}`);
  await page.getByRole("button", { name: "Close strategy settings" }).click();
  for (const [label, name] of [["CONFIGURATION", "cockpit-configuration"], ["PAPER", "cockpit-paper"], ["LIVE TARGETS", "cockpit-live-targets"], ["POSITIONS", "cockpit-positions"], ["PERFORMANCE", "cockpit-performance"]]) {
    await page.getByLabel("Strategy cockpit sections").getByRole("button", { name: label, exact: true }).click({ force: true });
    await page.waitForTimeout(80);
    await capture(page, `${name}-${width}x${height}`);
  }
  await context.close();
}

await browser.close();
const unexpectedErrors = pageErrors.filter((error) => !error.includes("pixi__js") && !error.includes("BlackChartEngine"));
assert.deepEqual(unexpectedErrors, [], `Unexpected browser errors: ${unexpectedErrors.join(" | ")}`);
console.log(`My Strategy visual regression PASS — ${captures.length} screenshots captured across 1920×1080, 2560×1440 and 3840×2160.`);

async function open(page, fixture) {
  await page.goto(`${baseUrl}/?uiPreview=1&strategyLabFixture=${fixture}${fixture === "cockpit" ? "&strategyControlPreview=1" : ""}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator(fixture === "library" ? ".my-strategy-library" : fixture === "wizard" ? ".strategy-wizard" : ".strategy-cockpit").waitFor({ state: "visible", timeout: 30_000 });
}

async function capture(page, name) {
  const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.documentElement.scrollWidth, strategy: document.querySelector(".strategy-lab")?.scrollWidth || 0, client: document.querySelector(".strategy-lab")?.clientWidth || 0 }));
  assert.ok(metrics.body <= metrics.viewport + 1, `${name} document overflow: ${metrics.body} > ${metrics.viewport}`);
  assert.ok(metrics.strategy <= metrics.client + 2, `${name} Strategy Lab overflow: ${metrics.strategy} > ${metrics.client}`);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  captures.push(file);
}

async function assertControlDialog(page, viewportHeight) {
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector(".strategy-control-dialog")?.getBoundingClientRect();
    const scroll = document.querySelector(".strategy-control-scroll")?.getBoundingClientRect();
    const footer = document.querySelector(".strategy-control-dialog > footer")?.getBoundingClientRect();
    return dialog && scroll && footer ? {
      dialog: { top: dialog.top, bottom: dialog.bottom },
      scroll: { top: scroll.top, bottom: scroll.bottom },
      footer: { top: footer.top, bottom: footer.bottom },
      footerOwnsTopPixel: Boolean(document.elementFromPoint(footer.left + 20, footer.top + footer.height / 2)?.closest(".strategy-control-dialog")),
    } : null;
  });
  assert.ok(layout, "SuperATR settings dialog layout is missing");
  assert.ok(layout.footer.top >= layout.scroll.bottom - 1, "SuperATR settings footer overlaps the scrolling controls");
  assert.ok(layout.footer.bottom <= layout.dialog.bottom + 1, "SuperATR settings footer escapes the dialog");
  assert.ok(layout.dialog.bottom <= viewportHeight + 1, "SuperATR settings dialog escapes the viewport");
  assert.ok(layout.footerOwnsTopPixel, "SuperATR settings footer is occluded by another terminal stacking context");
}
