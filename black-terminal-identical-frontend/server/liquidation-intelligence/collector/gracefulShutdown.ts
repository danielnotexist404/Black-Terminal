export function installBclifGracefulShutdown(shutdown: (signal: string) => Promise<void>, timeoutMs = 45_000) {
  let stopping: Promise<void> | null = null;
  const begin = (signal: string) => {
    if (stopping) return stopping;
    stopping = Promise.race([
      shutdown(signal),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("BCLIF graceful shutdown timed out")), timeoutMs);
        timer.unref?.();
      })
    ]);
    return stopping;
  };
  const handler = (signal: string) => void begin(signal).then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
  return begin;
}
