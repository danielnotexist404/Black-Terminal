import { supabase } from "../../../lib/supabase";
import type {
  EligibleBrokerTarget,
  EligibleGroupTarget,
  StrategyAutomationDefinition,
  StrategyBrokerConnection,
  StrategyCapitalPolicy,
  StrategyGroupExecutionDesk,
  StrategyPaperAccount,
  StrategySummary,
  StrategyTargetBinding,
  StrategyTargetSnapshot,
  StrategyTargetType,
  StrategyWorkspace,
} from "./strategyAutomation.types";

async function request<T>(
  path = "",
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!supabase)
    throw new Error("Strategy automation requires an authenticated session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to open My Strategy.");
  const response = await fetch(`/api/strategies${path ? `/${path}` : ""}`, {
    ...options,
    signal,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = Array.isArray(payload.details?.reasons)
      ? ` ${payload.details.reasons.join(" ")}`
      : "";
    throw new Error(
      `${payload.error || `Strategy request failed (${response.status}).`}${reason}`,
    );
  }
  return payload as T;
}

const mutation = (body: unknown, method = "POST") => ({
  method,
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(body),
});

async function connectionRequest<T>(path = "", options: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error("Strategy connections require an authenticated session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to manage strategy connections.");
  const response = await fetch(`/api/strategy-connections${path ? `/${path}` : ""}`, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Strategy connection request failed (${response.status}).`);
  return payload as T;
}

export const strategyConnectionApi = {
  list: () => connectionRequest<{ connections: StrategyBrokerConnection[]; limit: 9; testnetAccepted: false }>(),
  connect: (apiKey: string, apiSecret: string) => connectionRequest<{ account: { id: string }; cloud: { connection: StrategyBrokerConnection }; publicApiKey: string; apiSecretDisplay: string }>("connect", { method: "POST", body: JSON.stringify({ apiKey, apiSecret }) }),
  rotate: (connectionId: string, apiKey: string, apiSecret: string) => connectionRequest<{ account: { id: string }; cloud: { connection: StrategyBrokerConnection }; publicApiKey: string; apiSecretDisplay: string }>(encodeURIComponent(connectionId), { method: "PATCH", body: JSON.stringify({ apiKey, apiSecret }) }),
  remove: (connectionId: string) => connectionRequest<{ ok: true; removedAccountIds: string[]; revokedConnectionIds: string[] }>(encodeURIComponent(connectionId), { method: "DELETE" }),
};

export const strategyAutomationApi = {
  list: (signal?: AbortSignal) =>
    request<{ strategies: StrategySummary[] }>("", {}, signal),
  groupExecutionDesks: (groupId: string, signal?: AbortSignal) =>
    request<{ groupId: string; desks: StrategyGroupExecutionDesk[] }>(
      `group-execution-desks/${encodeURIComponent(groupId)}`,
      {},
      signal,
    ),
  get: (strategyId: string, signal?: AbortSignal) =>
    request<StrategyWorkspace>(encodeURIComponent(strategyId), {}, signal),
  create: (name: string, definition: StrategyAutomationDefinition) =>
    request<StrategyWorkspace>("", mutation({ name, definition })),
  createDraft: (name: string, definition: StrategyAutomationDefinition) =>
    request<StrategyWorkspace>("drafts", mutation({ name, definition })),
  saveDraft: (
    strategyId: string,
    name: string,
    definition: StrategyAutomationDefinition,
    expectedRevision?: number,
  ) =>
    request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/draft`,
      mutation({ name, definition, expectedRevision }, "PATCH"),
    ),
  publishDraft: (strategyId: string, expectedRevision: number) =>
    request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/publish`,
      mutation({ expectedRevision }),
    ),
  updateGlobalPolicy: (strategyId: string, expectedRevision: number, capitalPolicy: StrategyCapitalPolicy) =>
    request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/global-policy`,
      mutation({ expectedRevision, capitalPolicy }, "PATCH"),
    ),
  startVersion: (strategyId: string, version: number) =>
    request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/versions/${version}/start`,
      mutation({}),
    ),
  save: (
    strategyId: string,
    name: string,
    definition: StrategyAutomationDefinition,
  ) =>
    request<StrategyWorkspace>(
      encodeURIComponent(strategyId),
      mutation({ name, definition }, "PATCH"),
    ),
  remove: (strategy: Pick<StrategySummary, "id" | "name" | "draftRevision">) =>
    request<{ strategyId: string; archivedAt: string; idempotent: boolean }>(
      encodeURIComponent(strategy.id),
      mutation({ expectedName: strategy.name, expectedRevision: strategy.draftRevision || 0 }, "DELETE"),
    ),
  eligibleTargets: (strategyId: string, signal?: AbortSignal) =>
    request<{
      strategyId: string;
      brokerAccounts: EligibleBrokerTarget[];
      groups: EligibleGroupTarget[];
    }>(`${encodeURIComponent(strategyId)}/eligible-targets`, {}, signal),
  addTarget: (
    strategyId: string,
    slotIndex: number,
    targetType: StrategyTargetType,
    targetId: string,
    marketType: "SPOT" | "FUTURES",
    capitalPolicy?: StrategyCapitalPolicy,
  ) =>
    request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets`,
      mutation({ slotIndex, targetType, targetId, marketType, ...(capitalPolicy ? { capitalPolicy } : {}) }),
    ),
  reorderTargets: (
    strategyId: string,
    assignments: Array<{
      bindingId: string;
      slotIndex: number;
      expectedVersion: number;
    }>,
  ) =>
    request<{
      bindings: StrategyTargetBinding[];
      snapshots: StrategyTargetSnapshot[];
    }>(
      `${encodeURIComponent(strategyId)}/targets/reorder`,
      mutation({ assignments }),
    ),
  updateTarget: (
    strategyId: string,
    binding: StrategyTargetBinding,
    capitalPolicy: StrategyCapitalPolicy,
  ) =>
    request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}`,
      mutation({ expectedVersion: binding.rowVersion, capitalPolicy }, "PATCH"),
    ),
  targetAction: (
    strategyId: string,
    binding: StrategyTargetBinding,
    action: "arm" | "pause" | "resume",
  ) =>
    request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}/${action}`,
      mutation({ expectedVersion: binding.rowVersion }),
    ),
  disconnectTarget: (
    strategyId: string,
    binding: StrategyTargetBinding,
    disconnectPolicy = "DETACH_MANUAL",
  ) =>
    request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}`,
      mutation(
        { expectedVersion: binding.rowVersion, disconnectPolicy },
        "DELETE",
      ),
    ),
  snapshot: (strategyId: string, signal?: AbortSignal) =>
    request<{
      strategyId: string;
      timestamp: number;
      paper: StrategyPaperAccount | null;
      targets: StrategyTargetSnapshot[];
      runtime: StrategyWorkspace["runtime"];
    }>(`${encodeURIComponent(strategyId)}/snapshot`, {}, signal),
  targetData: <T>(
    strategyId: string,
    bindingId: string,
    resource:
      | "members"
      | "positions"
      | "orders"
      | "executions"
      | "trades"
      | "analytics"
      | "risk"
      | "logs",
    signal?: AbortSignal,
  ) =>
    request<Record<string, T>>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(bindingId)}/${resource}`,
      {},
      signal,
    ),
  paperData: (strategyId: string, signal?: AbortSignal) =>
    request<Record<string, unknown>>(
      `${encodeURIComponent(strategyId)}/paper`,
      {},
      signal,
    ),
  configurePaper: (
    strategyId: string,
    expectedVersion: number,
    capitalPolicy: StrategyCapitalPolicy,
  ) =>
    request<{ paper: StrategyPaperAccount }>(
      `${encodeURIComponent(strategyId)}/paper/configure`,
      mutation({ expectedVersion, capitalPolicy }),
    ),
  paperAction: (
    strategyId: string,
    action: "start" | "pause" | "top-up" | "reset",
    expectedVersion: number,
    body: Record<string, unknown> = {},
  ) =>
    request<{ paper: StrategyPaperAccount }>(
      `${encodeURIComponent(strategyId)}/paper/${action}`,
      mutation({ expectedVersion, ...body }),
    ),
};
