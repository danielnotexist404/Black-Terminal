export type RuntimeKind = "browser" | "desktop" | "server";

export interface PlatformRuntime {
  kind: RuntimeKind;
  now(): number;
  setTimer(handler: () => void, ms: number): number;
  clearTimer(id: number): void;
  createWebSocket(url: string): WebSocket;
}

export const browserPlatform: PlatformRuntime = {
  kind: typeof window === "undefined" ? "server" : "__TAURI_INTERNALS__" in window ? "desktop" : "browser",
  now: () => performance.now(),
  setTimer: (handler, ms) => window.setInterval(handler, ms),
  clearTimer: (id) => window.clearInterval(id),
  createWebSocket: (url) => new WebSocket(url)
};
