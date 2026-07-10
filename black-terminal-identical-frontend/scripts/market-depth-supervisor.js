import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("./market-depth-worker.js", import.meta.url));
const restartBaseMs = Math.max(500, Number(process.env.MARKET_DEPTH_WORKER_RESTART_BASE_MS || 1500));
const restartMaxMs = Math.max(restartBaseMs, Number(process.env.MARKET_DEPTH_WORKER_RESTART_MAX_MS || 60_000));

let child = null;
let restartCount = 0;
let stopping = false;
let restartTimer = null;

function startWorker() {
  if (stopping) return;
  child = spawn(process.execPath, [workerPath], {
    stdio: "inherit",
    env: process.env
  });

  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const delay = Math.min(restartMaxMs, restartBaseMs * Math.max(1, restartCount + 1));
    restartCount += 1;
    console.error(`[MarketDepthSupervisor] worker exited code=${code ?? "null"} signal=${signal ?? "null"}; restart #${restartCount} in ${delay}ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startWorker();
    }, delay);
  });
}

function shutdown(signal) {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) {
    child.once("exit", () => process.exit(0));
    child.kill(signal);
    setTimeout(() => process.exit(0), 5000).unref?.();
    return;
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

console.log("[MarketDepthSupervisor] starting supervised Black Core depth worker.");
startWorker();
