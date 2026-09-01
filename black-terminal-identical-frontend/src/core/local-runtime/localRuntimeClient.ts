import { invoke } from "@tauri-apps/api/core";

export type LocalRuntimeMode = "LOCAL_ONLY" | "HYBRID";

export type LocalRuntimeConfig = {
  schemaVersion: 1;
  mode: LocalRuntimeMode;
  backgroundExecution: boolean;
  p2pEnabled: boolean;
  peerId: string;
  profile: {
    email: string;
    displayName: string;
    username: string;
  };
  initializedAt: number;
  updatedAt: number;
};

export type LocalRuntimeStatus = {
  available: boolean;
  initialized: boolean;
  vaultReady: boolean;
  config: LocalRuntimeConfig | null;
  platform: "windows" | "linux" | "macos" | "ios" | "android" | "unknown";
  persistentBackgroundSupported: boolean;
  backgroundLimitation: string | null;
  webviewHeartbeatAt: number | null;
  executionWorkerHeartbeatAt: number | null;
  backgroundHealth: "NOT_CONFIGURED" | "DISABLED" | "HEALTHY" | "EXECUTION_WORKER_DEGRADED" | "STRATEGY_HOST_DEGRADED";
};

export type InitializeLocalRuntimeRequest = {
  mode: LocalRuntimeMode;
  backgroundExecution: boolean;
  p2pEnabled: boolean;
  email: string;
  displayName: string;
};

let cachedStatus: LocalRuntimeStatus | null = null;

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getCachedLocalRuntimeStatus() {
  return cachedStatus;
}

export function isLocalOnlyRuntime() {
  return cachedStatus?.initialized === true && cachedStatus.config?.mode === "LOCAL_ONLY";
}

export async function readLocalRuntimeStatus() {
  if (!isTauriRuntime()) return null;
  cachedStatus = await invoke<LocalRuntimeStatus>("local_runtime_status");
  return cachedStatus;
}

export async function initializeLocalRuntime(request: InitializeLocalRuntimeRequest) {
  if (!isTauriRuntime()) throw new Error("Local runtime initialization is available only in the installed Black Terminal app.");
  cachedStatus = await invoke<LocalRuntimeStatus>("initialize_local_runtime", { request });
  return cachedStatus;
}

export async function updateLocalRuntimeSettings(request: { backgroundExecution: boolean; p2pEnabled: boolean }) {
  if (!isTauriRuntime()) throw new Error("Local runtime settings are available only in the installed Black Terminal app.");
  cachedStatus = await invoke<LocalRuntimeStatus>("update_local_runtime", { request });
  window.dispatchEvent(new CustomEvent("bt-local-runtime-updated", { detail: cachedStatus }));
  return cachedStatus;
}

export async function sendLocalRuntimeHeartbeat() {
  if (!isTauriRuntime()) return null;
  cachedStatus = await invoke<LocalRuntimeStatus>("local_runtime_heartbeat");
  return cachedStatus;
}
