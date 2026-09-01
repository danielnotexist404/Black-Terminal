import { invoke } from "@tauri-apps/api/core";

export type LocalExecutionType = "ORDER" | "CANCEL" | "AMEND" | "PARTIAL_TP" | "REVERSE" | "LEVERAGE" | "PROTECTION";
export type LocalExecutionStatus = "PENDING" | "IN_FLIGHT" | "RETRY" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type LocalExecutionIntent<T = unknown> = {
  id: number;
  executionType: LocalExecutionType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: LocalExecutionStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseExpiresAt: number | null;
  result: T | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export async function enqueueLocalExecution<T = unknown>(request: {
  executionType: LocalExecutionType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}) {
  return invoke<LocalExecutionIntent<T>>("local_execution_enqueue", { request });
}

export async function getLocalExecution<T = unknown>(idempotencyKey: string) {
  return invoke<LocalExecutionIntent<T> | null>("local_execution_get", { idempotencyKey });
}

export async function enqueueAndWaitForLocalExecution<T>(request: {
  executionType: LocalExecutionType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}, timeoutMs = 30_000) {
  let intent = await enqueueLocalExecution<T>(request);
  const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, 60_000));
  while (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(intent.status) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    intent = await getLocalExecution<T>(request.idempotencyKey) ?? intent;
  }
  if (intent.status === "FAILED" || intent.status === "CANCELLED") {
    throw new Error(intent.lastError || `Local execution ${intent.status.toLowerCase()}.`);
  }
  return intent;
}
