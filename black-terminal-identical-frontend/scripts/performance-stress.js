import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = process.env.PERF_STRESS_URL;
const durationMinutes = Number(process.env.PERF_STRESS_MINUTES || 720);
const intervalMs = Number(process.env.PERF_STRESS_INTERVAL_MS || 60_000);

if (!url) {
  console.error("PERF_STRESS_URL is required. Example: PERF_STRESS_URL=http://127.0.0.1:4173 npm run perf:stress");
  process.exit(1);
}

const startedAt = Date.now();
const outputDir = join(root, "docs", "performance");
mkdirSync(outputDir, { recursive: true });
const outputFile = join(outputDir, `stress-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.jsonl`);
writeFileSync(outputFile, "");
console.log(`Writing stress log to ${relative(root, outputFile)}`);

while (Date.now() - startedAt < durationMinutes * 60_000) {
  const sample = await collectSample(url);
  appendFileSync(outputFile, `${JSON.stringify(sample)}\n`);
  console.log(`${sample.time} status=${sample.statusCode} latency=${sample.latencyMs}ms heap=${sample.nodeHeapUsedMb.toFixed(1)}MB`);
  await sleep(intervalMs);
}

console.log("Stress run complete.");

async function collectSample(baseUrl) {
  const started = Date.now();
  let statusCode = 0;
  let ok = false;
  let immStatus = null;
  let error = null;
  try {
    const response = await fetch(baseUrl);
    statusCode = response.status;
    ok = response.ok;
    await response.arrayBuffer();
    immStatus = await fetchImmStatus(baseUrl);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const memory = process.memoryUsage();
  return {
    time: new Date().toISOString(),
    ok,
    statusCode,
    latencyMs: Date.now() - started,
    nodeHeapUsedMb: memory.heapUsed / 1024 / 1024,
    nodeRssMb: memory.rss / 1024 / 1024,
    immStatus,
    error
  };
}

async function fetchImmStatus(baseUrl) {
  try {
    const statusUrl = new URL("/api/imm/status", baseUrl);
    const response = await fetch(statusUrl);
    if (!response.ok) return { ok: false, statusCode: response.status };
    const payload = await response.json();
    return {
      ok: true,
      statusCode: response.status,
      overallStatus: payload.overallStatus,
      workerStatus: payload.workerStatus,
      staleForMs: payload.staleForMs,
      quality: payload.quality
    };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
