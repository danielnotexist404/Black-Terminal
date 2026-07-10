import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const generatedAt = new Date().toISOString();
const docsDir = join(root, "docs", "performance");
mkdirSync(docsDir, { recursive: true });

const baseline = {
  generatedAt,
  gitCommit: safeExec("git", ["rev-parse", "--short", "HEAD"]),
  node: process.version,
  platform: process.platform,
  sourceFootprint: scanSourceFootprint(join(root, "src")),
  bundleFootprint: scanBundleFootprint(join(root, "dist")),
  notes: [
    "This is the repeatable static/runtime-ready baseline for Chapter IX.",
    "Use Ctrl+Shift+P in the app to capture browser HUD snapshots during live sessions.",
    "Use npm run perf:stress with PERF_STRESS_URL for long-session polling logs."
  ]
};

writeFileSync(join(docsDir, "latest-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
writeFileSync(join(docsDir, "latest-baseline.md"), renderMarkdown(baseline));
console.log(`Performance baseline written to ${relative(root, join(docsDir, "latest-baseline.md"))}`);

function safeExec(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function scanSourceFootprint(srcDir) {
  const files = walk(srcDir).filter((file) => /\.(ts|tsx|js|jsx)$/.test(file));
  const counters = {
    files: files.length,
    lines: 0,
    requestAnimationFrame: 0,
    setInterval: 0,
    setTimeout: 0,
    addEventListener: 0,
    removeEventListener: 0,
    newWebSocket: 0,
    newWorker: 0,
    resizeObserver: 0,
    mutationObserver: 0,
    performanceMetricPublishers: 0
  };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    counters.lines += text.split(/\r?\n/).length;
    counters.requestAnimationFrame += count(text, "requestAnimationFrame");
    counters.setInterval += count(text, "setInterval");
    counters.setTimeout += count(text, "setTimeout");
    counters.addEventListener += count(text, "addEventListener");
    counters.removeEventListener += count(text, "removeEventListener");
    counters.newWebSocket += count(text, "new WebSocket");
    counters.newWorker += count(text, "new Worker");
    counters.resizeObserver += count(text, "ResizeObserver");
    counters.mutationObserver += count(text, "MutationObserver");
    counters.performanceMetricPublishers += count(text, "performance.metric") + count(text, "recordMetric(");
  }
  return counters;
}

function scanBundleFootprint(distDir) {
  try {
    const assetsDir = join(distDir, "assets");
    const assets = readdirSync(assetsDir)
      .map((name) => {
        const path = join(assetsDir, name);
        const stats = statSync(path);
        return { name, bytes: stats.size };
      })
      .sort((a, b) => b.bytes - a.bytes);
    return {
      available: true,
      totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      largestAssets: assets.slice(0, 8)
    };
  } catch {
    return { available: false, totalBytes: 0, largestAssets: [] };
  }
}

function renderMarkdown(report) {
  const source = report.sourceFootprint;
  const bundle = report.bundleFootprint;
  return `# Black Core Performance Baseline

Generated: ${report.generatedAt}

Commit: ${report.gitCommit}

Node: ${report.node}

Platform: ${report.platform}

## Source Footprint

| Metric | Value |
| --- | ---: |
| Files | ${source.files} |
| Lines | ${source.lines} |
| requestAnimationFrame | ${source.requestAnimationFrame} |
| setInterval | ${source.setInterval} |
| setTimeout | ${source.setTimeout} |
| addEventListener | ${source.addEventListener} |
| removeEventListener | ${source.removeEventListener} |
| WebSocket constructors | ${source.newWebSocket} |
| Worker constructors | ${source.newWorker} |
| ResizeObserver references | ${source.resizeObserver} |
| MutationObserver references | ${source.mutationObserver} |
| Performance metric publishers | ${source.performanceMetricPublishers} |

## Bundle Footprint

Bundle available: ${bundle.available ? "yes" : "no"}

Total asset bytes: ${bundle.totalBytes}

| Asset | Bytes |
| --- | ---: |
${bundle.largestAssets.map((asset) => `| ${asset.name} | ${asset.bytes} |`).join("\n")}

## Runtime Capture

- Open Black Terminal.
- Press \`Ctrl+Shift+P\` to show the Performance HUD.
- Use \`Copy Snapshot\` before and after long DOM Pro+ sessions.
- Run \`npm run perf:stress\` with \`PERF_STRESS_URL\` to record long-session endpoint health.
`;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function count(text, needle) {
  return text.split(needle).length - 1;
}
