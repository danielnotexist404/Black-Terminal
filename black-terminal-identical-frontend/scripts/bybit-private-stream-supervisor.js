import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("./bybit-private-stream-worker.js", import.meta.url));
const restartBaseMs = Math.max(500, Number(process.env.BYBIT_STREAM_SUPERVISOR_RESTART_BASE_MS || 1500));
const restartMaxMs = Math.max(restartBaseMs, Number(process.env.BYBIT_STREAM_SUPERVISOR_RESTART_MAX_MS || 60_000));
const restartWindowMs = Math.max(60_000, Number(process.env.BYBIT_STREAM_SUPERVISOR_WINDOW_MS || 300_000));
const maxRestartsPerWindow = Math.max(1, Number(process.env.BYBIT_STREAM_SUPERVISOR_MAX_RESTARTS || 12));

let child = null;
let stopping = false;
let restartTimer = null;
let restartCount = 0;
let restartWindowStartedAt = Date.now();

function startWorker() {
  if (stopping) return;
  child = spawn(process.execPath, [workerPath], {
    stdio: "inherit",
    env: process.env
  });

  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) return;

    const now = Date.now();
    if (now - restartWindowStartedAt > restartWindowMs) {
      restartWindowStartedAt = now;
      restartCount = 0;
    }

    restartCount += 1;
    if (restartCount > maxRestartsPerWindow) {
      console.error(`[BybitPrivateStreamSupervisor] restart loop stopped after ${restartCount} exits inside ${restartWindowMs}ms.`);
      process.exitCode = 1;
      return;
    }

    const delay = Math.min(restartMaxMs, restartBaseMs * 2 ** Math.max(0, restartCount - 1));
    console.error(`[BybitPrivateStreamSupervisor] worker exited code=${code ?? "null"} signal=${signal ?? "null"}; restart #${restartCount} in ${delay}ms.`);
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

console.log("[BybitPrivateStreamSupervisor] starting supervised Bybit private-stream worker.");
startWorker();
