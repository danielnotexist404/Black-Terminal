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
import { isLocalOnlyRuntime } from "../../../core/local-runtime/localRuntimeClient";
import { connectLocalBybitAccount, disconnectLocalBrokerAccount, getLocalBrokerRecord, listLocalBrokerAccounts } from "../../../core/local-runtime/localBrokerStore";
import {
  addLocalStrategyTarget,
  configureLocalStrategyPaper,
  createLocalStrategyDraft,
  disconnectLocalStrategyTarget,
  eligibleLocalStrategyTargets,
  getLocalStrategy,
  listLocalStrategies,
  localStrategyPaperAction,
  localStrategyPaperData,
  localStrategyGroupExecutionDesks,
  localStrategySnapshot,
  localStrategyTargetAction,
  localStrategyTargetData,
  publishLocalStrategy,
  removeLocalStrategy,
  reorderLocalStrategyTargets,
  saveLocalStrategyDraft,
  startLocalStrategyVersion,
  updateLocalGlobalPolicy,
  updateLocalStrategyTarget,
} from "../../../core/local-runtime/localStrategyStore";

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
    throw Object.assign(
      new Error(
        `${payload.error || `Strategy request failed (${response.status}).`}${reason}`,
      ),
      {
        code: typeof payload.code === "string" ? payload.code : "STRATEGY_REQUEST_FAILED",
        status: response.status,
        details: payload.details,
      },
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
  list: async () => {
    if (isLocalOnlyRuntime()) return { connections: localStrategyConnections(), limit: 9 as const, testnetAccepted: true as const };
    return connectionRequest<{ connections: StrategyBrokerConnection[]; limit: 9; testnetAccepted: false }>();
  },
  connect: async (apiKey: string, apiSecret: string, localOptions?: { environment: "demo" | "testnet" | "mainnet"; mainnetConfirmed: boolean; accountName?: string }) => {
    if (isLocalOnlyRuntime()) {
      const account = await connectLocalBybitAccount({
        exchange: "bybit",
        accountName: localOptions?.accountName || `Strategy Bybit ${String(localOptions?.environment || "demo").toUpperCase()}`,
        apiKey,
        apiSecret,
        environment: localOptions?.environment || "demo",
        mainnetConfirmed: localOptions?.mainnetConfirmed === true,
        workspaceScope: "STRATEGY_LAB",
      });
      const connection = localStrategyConnections().find((item) => item.accountId === account.id);
      if (!connection) throw new Error("The local Strategy Lab broker connection could not be restored after authentication.");
      return { account: { id: account.id }, cloud: { connection }, publicApiKey: "OS VAULT", apiSecretDisplay: "••••••••••••••••" };
    }
    return connectionRequest<{ account: { id: string }; cloud: { connection: StrategyBrokerConnection }; publicApiKey: string; apiSecretDisplay: string }>("connect", { method: "POST", body: JSON.stringify({ apiKey, apiSecret }) });
  },
  rotate: (connectionId: string, apiKey: string, apiSecret: string) => {
    if (isLocalOnlyRuntime()) throw new Error("Modify local broker credentials from Portfolio Manager so the venue environment can be re-authenticated safely.");
    return connectionRequest<{ account: { id: string }; cloud: { connection: StrategyBrokerConnection }; publicApiKey: string; apiSecretDisplay: string }>(encodeURIComponent(connectionId), { method: "PATCH", body: JSON.stringify({ apiKey, apiSecret }) });
  },
  remove: async (connectionId: string) => {
    if (isLocalOnlyRuntime()) {
      await disconnectLocalBrokerAccount(connectionId);
      return { ok: true as const, removedAccountIds: [connectionId], revokedConnectionIds: [connectionId] };
    }
    return connectionRequest<{ ok: true; removedAccountIds: string[]; revokedConnectionIds: string[] }>(encodeURIComponent(connectionId), { method: "DELETE" });
  },
};

function localStrategyConnections(): StrategyBrokerConnection[] {
  return listLocalBrokerAccounts("STRATEGY_LAB").map((account) => {
    const record = getLocalBrokerRecord(account.id);
    const environment = record?.environment === "MAINNET" ? "MAINNET_LIVE" : record?.environment || "DEMO";
    return {
      id: account.id,
      accountId: account.id,
      provider: "BYBIT",
      label: account.accountName,
      publicApiKey: "OS VAULT",
      apiSecretDisplay: "••••••••••••••••",
      credentialStatus: record?.lastSnapshot ? "AUTHENTICATED" : "PENDING",
      healthStatus: account.status === "connected" ? "CONNECTED_LOCAL" : account.status.toUpperCase(),
      lifecycleStatus: "ACTIVE",
      credentialState: record?.lastSnapshot ? "AUTHENTICATED" : "PENDING",
      workerState: "LOCAL_RUNTIME",
      synchronizationState: record?.lastSnapshot ? "SYNCHRONIZED" : "PENDING",
      executionReadiness: record?.lastSnapshot?.tradingEnabled ? "READY" : "READ_ONLY",
      executionEnvironment: environment,
      endpointProfile: `BYBIT_${environment}`,
      lastAuthenticatedAt: record?.lastSnapshot ? new Date(record.lastSnapshot.capturedAt).toISOString() : undefined,
      persistence: "LOCAL_DEVICE",
    };
  });
}

export const strategyAutomationApi = {
  list: async (signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? { strategies: await listLocalStrategies() } : request<{ strategies: StrategySummary[] }>("", {}, signal),
  groupExecutionDesks: (groupId: string, signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? localStrategyGroupExecutionDesks(groupId) : request<{ groupId: string; desks: StrategyGroupExecutionDesk[] }>(
      `group-execution-desks/${encodeURIComponent(groupId)}`,
      {},
      signal,
    ),
  get: (strategyId: string, signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? getLocalStrategy(strategyId) : request<StrategyWorkspace>(encodeURIComponent(strategyId), {}, signal),
  create: (name: string, definition: StrategyAutomationDefinition) =>
    isLocalOnlyRuntime() ? createLocalStrategyDraft(name, definition) : request<StrategyWorkspace>("", mutation({ name, definition })),
  createDraft: (name: string, definition: StrategyAutomationDefinition) =>
    isLocalOnlyRuntime() ? createLocalStrategyDraft(name, definition) : request<StrategyWorkspace>("drafts", mutation({ name, definition })),
  saveDraft: (
    strategyId: string,
    name: string,
    definition: StrategyAutomationDefinition,
    expectedRevision?: number,
  ) =>
    isLocalOnlyRuntime() ? saveLocalStrategyDraft(strategyId, name, definition, expectedRevision) : request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/draft`,
      mutation({ name, definition, expectedRevision }, "PATCH"),
    ),
  publishDraft: (strategyId: string, expectedRevision: number) =>
    isLocalOnlyRuntime() ? publishLocalStrategy(strategyId, expectedRevision) : request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/publish`,
      mutation({ expectedRevision }),
    ),
  updateGlobalPolicy: (strategyId: string, expectedRevision: number, capitalPolicy: StrategyCapitalPolicy) =>
    isLocalOnlyRuntime() ? updateLocalGlobalPolicy(strategyId, expectedRevision, capitalPolicy) : request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/global-policy`,
      mutation({ expectedRevision, capitalPolicy }, "PATCH"),
    ),
  startVersion: (strategyId: string, version: number) =>
    isLocalOnlyRuntime() ? startLocalStrategyVersion(strategyId, version) : request<StrategyWorkspace>(
      `${encodeURIComponent(strategyId)}/versions/${version}/start`,
      mutation({}),
    ),
  save: (
    strategyId: string,
    name: string,
    definition: StrategyAutomationDefinition,
  ) => isLocalOnlyRuntime()
    ? getLocalStrategy(strategyId).then((workspace) => saveLocalStrategyDraft(strategyId, name, definition, workspace.strategy.draftRevision))
    : request<StrategyWorkspace>(encodeURIComponent(strategyId), mutation({ name, definition }, "PATCH")),
  remove: (strategy: Pick<StrategySummary, "id" | "name" | "draftRevision">) =>
    isLocalOnlyRuntime() ? removeLocalStrategy(strategy) : request<{ strategyId: string; archivedAt: string; idempotent: boolean }>(
      encodeURIComponent(strategy.id),
      mutation({ expectedName: strategy.name, expectedRevision: strategy.draftRevision || 0 }, "DELETE"),
    ),
  eligibleTargets: (strategyId: string, signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? eligibleLocalStrategyTargets(strategyId).then((targets) => ({ strategyId, ...targets })) : request<{
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
    isLocalOnlyRuntime() ? addLocalStrategyTarget(strategyId, slotIndex, targetType, targetId, marketType, capitalPolicy) : request<{ binding: StrategyTargetBinding }>(
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
    isLocalOnlyRuntime() ? reorderLocalStrategyTargets(strategyId, assignments) : request<{
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
    isLocalOnlyRuntime() ? updateLocalStrategyTarget(strategyId, binding, capitalPolicy) : request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}`,
      mutation({ expectedVersion: binding.rowVersion, capitalPolicy }, "PATCH"),
    ),
  targetAction: (
    strategyId: string,
    binding: StrategyTargetBinding,
    action: "arm" | "pause" | "resume",
  ) =>
    isLocalOnlyRuntime() ? localStrategyTargetAction(strategyId, binding, action) : request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}/${action}`,
      mutation({ expectedVersion: binding.rowVersion }),
    ),
  disconnectTarget: (
    strategyId: string,
    binding: StrategyTargetBinding,
    disconnectPolicy = "DETACH_MANUAL",
  ) =>
    isLocalOnlyRuntime() ? disconnectLocalStrategyTarget(strategyId, binding) : request<{ binding: StrategyTargetBinding }>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(binding.id)}`,
      mutation(
        { expectedVersion: binding.rowVersion, disconnectPolicy },
        "DELETE",
      ),
    ),
  snapshot: (strategyId: string, signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? localStrategySnapshot(strategyId) : request<{
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
    isLocalOnlyRuntime() ? localStrategyTargetData(strategyId, bindingId, resource) as Promise<Record<string, T>> : request<Record<string, T>>(
      `${encodeURIComponent(strategyId)}/targets/${encodeURIComponent(bindingId)}/${resource}`,
      {},
      signal,
    ),
  paperData: (strategyId: string, signal?: AbortSignal) =>
    isLocalOnlyRuntime() ? localStrategyPaperData(strategyId) : request<Record<string, unknown>>(
      `${encodeURIComponent(strategyId)}/paper`,
      {},
      signal,
    ),
  configurePaper: (
    strategyId: string,
    expectedVersion: number,
    capitalPolicy: StrategyCapitalPolicy,
  ) =>
    isLocalOnlyRuntime() ? configureLocalStrategyPaper(strategyId, expectedVersion, capitalPolicy) : request<{ paper: StrategyPaperAccount }>(
      `${encodeURIComponent(strategyId)}/paper/configure`,
      mutation({ expectedVersion, capitalPolicy }),
    ),
  paperAction: (
    strategyId: string,
    action: "start" | "pause" | "top-up" | "reset",
    expectedVersion: number,
    body: Record<string, unknown> = {},
  ) =>
    isLocalOnlyRuntime() ? localStrategyPaperAction(strategyId, action, expectedVersion, body) : request<{ paper: StrategyPaperAccount }>(
      `${encodeURIComponent(strategyId)}/paper/${action}`,
      mutation({ expectedVersion, ...body }),
    ),
};
