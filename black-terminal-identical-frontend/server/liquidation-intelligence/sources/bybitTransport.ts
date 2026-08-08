import WebSocket from "ws";

export const BYBIT_PUBLIC_REST = "https://api.bybit.com";
export const BYBIT_PUBLIC_LINEAR_WS = "wss://stream.bybit.com/v5/public/linear";

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export interface BybitPublicResponse<T> {
  result: T;
  exchangeTimestamp: number;
  receivedTimestamp: number;
}

export async function bybitPublicGet<T>(path: string, params: URLSearchParams, options: {
  signal?: AbortSignal;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
} = {}): Promise<T> {
  return (await bybitPublicGetEnvelope<T>(path, params, options)).result;
}

export async function bybitPublicGetEnvelope<T>(path: string, params: URLSearchParams, options: {
  signal?: AbortSignal;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
} = {}): Promise<BybitPublicResponse<T>> {
  if (!path.startsWith("/v5/market/")) throw new Error("BCLIF only permits official Bybit public market routes");
  const attempts = Math.max(1, Math.min(8, options.attempts ?? 4));
  const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 12_000));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const onProcessAbort = () => controller.abort(options.signal?.reason);
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error("Bybit public request timed out"), { name: "TimeoutError" })), timeoutMs);
    timeout.unref?.();
    options.signal?.addEventListener("abort", onProcessAbort, { once: true });
    try {
      const response = await fetch(`${BYBIT_PUBLIC_REST}${path}?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "Black-Terminal-BCLIF/1" }
      });
      if (!response.ok) throw Object.assign(new Error(`Bybit public request ${path} returned ${response.status}`), {
        retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500
      });
      const envelope = await response.json() as BybitEnvelope<T>;
      if (envelope.retCode !== 0) throw Object.assign(new Error(`Bybit ${path} failed (${envelope.retCode}): ${envelope.retMsg}`), {
        retryable: envelope.retCode === 10006 || envelope.retCode === 10016 || envelope.retCode === 10018
      });
      const receivedTimestamp = Date.now();
      const serverTime = Number(envelope.time);
      if (!Number.isFinite(serverTime) || serverTime <= 0) throw Object.assign(new Error("Bybit response omitted a valid server timestamp"), { retryable: true });
      return { result: envelope.result, exchangeTimestamp: serverTime < 10_000_000_000 ? serverTime * 1_000 : serverTime, receivedTimestamp };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if ((error as { retryable?: boolean })?.retryable === false) throw error;
      if (attempt + 1 < attempts) await abortableDelay(Math.min(8_000, (options.baseDelayMs ?? 250) * 2 ** attempt), options.signal);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onProcessAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface BybitSocketCallbacks {
  onOpen?(): void;
  onSubscribed?(topics: readonly string[]): void;
  onActivity?(receivedTimestamp: number): void;
  onMessage(payload: unknown, receivedTimestamp: number): void;
  onClose?(reason: string): void;
  onError?(error: Error): void;
  onReconnect?(attempt: number, delayMs: number): void;
}

export class BybitPublicSocket {
  private socket: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private attempt = 0;
  private readonly topics: string[];
  private readonly callbacks: BybitSocketCallbacks;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(
    topics: string[],
    callbacks: BybitSocketCallbacks,
    reconnectBaseMs = 750,
    reconnectMaxMs = 30_000
  ) {
    this.topics = topics;
    this.callbacks = callbacks;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.stableTimer = null;
    this.socket?.close(1000, "collector draining");
    this.socket = null;
  }

  forceReconnect(reason = "collector requested resynchronization") {
    if (this.stopped) return;
    this.socket?.close(1012, reason.slice(0, 120));
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(BYBIT_PUBLIC_LINEAR_WS, { handshakeTimeout: 10_000 });
    this.socket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "subscribe", args: this.topics }));
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
      this.pingTimer.unref?.();
      this.stableTimer = setTimeout(() => { this.attempt = 0; }, 60_000);
      this.stableTimer.unref?.();
      this.callbacks.onOpen?.();
    });
    socket.on("message", (raw) => {
      try {
        const receivedTimestamp = Date.now();
        this.callbacks.onActivity?.(receivedTimestamp);
        const payload = JSON.parse(raw.toString());
        if (payload?.success === true && (payload?.op === "subscribe" || String(payload?.ret_msg || "").toLowerCase().includes("subscribe"))) {
          this.attempt = 0;
          this.callbacks.onSubscribed?.(this.topics);
          return;
        }
        if (payload?.op === "pong") return;
        this.attempt = 0;
        this.callbacks.onMessage(payload, receivedTimestamp);
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => this.callbacks.onError?.(error));
    socket.on("close", (_code, reason) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.pingTimer = null;
      this.stableTimer = null;
      this.callbacks.onClose?.(reason.toString() || "transport closed");
      if (this.stopped) return;
      const attempt = ++this.attempt;
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(12, attempt - 1));
      this.callbacks.onReconnect?.(attempt, delay);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
  }
}

/**
 * Verify the host clock against the timestamp on an official Bybit public
 * response. The midpoint removes request latency bias; uncertainty is exposed
 * for diagnostics but never used to waive a configured drift violation.
 */
export async function verifyBybitServerClock(maximumDriftMs: number, signal?: AbortSignal) {
  if (!Number.isFinite(maximumDriftMs) || maximumDriftMs < 0) throw new Error("Invalid BCLIF maximum clock drift");
  const requestStartedAt = Date.now();
  const response = await bybitPublicGetEnvelope<Record<string, unknown>>("/v5/market/time", new URLSearchParams(), { signal, attempts: 3 });
  const requestFinishedAt = Date.now();
  const midpoint = requestStartedAt + (requestFinishedAt - requestStartedAt) / 2;
  const driftMs = response.exchangeTimestamp - midpoint;
  const uncertaintyMs = (requestFinishedAt - requestStartedAt) / 2;
  if (Math.abs(driftMs) > maximumDriftMs) {
    throw Object.assign(new Error(`BCLIF host clock drift ${Math.round(driftMs)}ms exceeds ${maximumDriftMs}ms`), {
      code: "BCLIF_CLOCK_DRIFT",
      driftMs,
      uncertaintyMs
    });
  }
  return { driftMs, uncertaintyMs, exchangeTimestamp: response.exchangeTimestamp, midpoint };
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error("Bybit request aborted"), { name: "AbortError" }));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
