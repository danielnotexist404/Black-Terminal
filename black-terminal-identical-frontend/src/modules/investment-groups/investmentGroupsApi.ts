import { supabase } from "../../lib/supabase";
import type {
  CopyTradingConfiguration,
  GroupDetailPayload,
  GroupMembership,
  InvestmentGroupCockpit,
  InvestmentGroupWorkspace,
  JoinDraft,
  MemberRiskPolicy,
  ParticipationMethod,
  RiskAcknowledgementKey
} from "./types";

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!supabase) throw new Error("Investment Groups require an authenticated Supabase session.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to open Investment Groups.");
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Investment Group request failed (${response.status}).`) as Error & { code?: string; details?: unknown; status?: number };
    error.code = payload.code;
    error.details = payload.details;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

const actionPath = (groupId: string, action: string) => `/api/network/investment-groups/${encodeURIComponent(groupId)}/${action}`;

export const investmentGroupsApi = {
  list: () => request<InvestmentGroupWorkspace>("/api/network/investment-groups"),
  create: (input: Record<string, unknown>) => request<{ group: Record<string, unknown> }>("/api/network/investment-groups", { method: "POST", body: input }),
  detail: (groupId: string) => request<GroupDetailPayload>(actionPath(groupId, "detail")),
  acknowledgeRisk: (groupId: string, input: { version: string; documentHash: string; locale: string; reachedEnd: boolean; acknowledgements: Record<RiskAcknowledgementKey, boolean>; applicationVersion: string }) =>
    request<{ acknowledgement: { id: string; version: string; documentHash: string; acceptedAt: string } }>(actionPath(groupId, "risk-acknowledgements"), { method: "POST", body: input }),
  saveDraft: (groupId: string, input: { participationMethod: ParticipationMethod; currentStep: "METHOD_SELECTED" | "CONFIGURING" | "REVIEW"; configuration?: Partial<CopyTradingConfiguration> }) =>
    request<{ draft: JoinDraft }>(actionPath(groupId, "join-draft"), { method: "PATCH", body: input }),
  join: (groupId: string, input: { participationMethod: "COPY_TRADING"; connectionId: string; riskPolicy: CopyTradingConfiguration; finalConsent: true; idempotencyKey: string; passwordHash?: string; message?: string }) =>
    request<{ membership: GroupMembership; pendingApproval: boolean; idempotent: boolean }>(actionPath(groupId, "join"), { method: "POST", body: input }),
  membership: (groupId: string) => request<{ membership: GroupMembership | null; riskPolicy?: MemberRiskPolicy; positions?: unknown[] }>(actionPath(groupId, "membership")),
  pause: (groupId: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "pause"), { method: "POST", body: { idempotencyKey: makeIdempotencyKey("pause") } }),
  resume: (groupId: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "resume"), { method: "POST", body: { idempotencyKey: makeIdempotencyKey("resume") } }),
  leave: (groupId: string, exitPolicy: string, closePositionsConfirmed: boolean) => request<{ exit: Record<string, unknown> }>(actionPath(groupId, "leave"), { method: "POST", body: { exitPolicy, closePositionsConfirmed, idempotencyKey: makeIdempotencyKey("leave") } }),
  joinObsidianWaitlist: (groupId: string) => request<{ joined: true; researchOnly: true; depositsAccepted: false; vaultAddress: null }>(actionPath(groupId, "obsidian-waitlist"), { method: "POST", body: {} }),
  cockpit: (groupId: string) => request<InvestmentGroupCockpit>(actionPath(groupId, "cockpit")),
  approve: (groupId: string, membershipId: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "approve"), { method: "POST", body: { membershipId, idempotencyKey: makeIdempotencyKey("approve") } }),
  reject: (groupId: string, membershipId: string, reason: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "reject"), { method: "POST", body: { membershipId, reason, idempotencyKey: makeIdempotencyKey("reject") } }),
  updateRequestedLeverage: (groupId: string, membershipId: string, version: number, managerRequestedLeverage: number, reason: string) => {
    const idempotencyKey = makeIdempotencyKey("risk");
    return request<{ riskPolicy: MemberRiskPolicy }>(actionPath(groupId, "risk-policy"), { method: "PATCH", body: { membershipId, version, managerRequestedLeverage, reason, correlationId: idempotencyKey, idempotencyKey } });
  },
  pauseMember: (groupId: string, membershipId: string, reason: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "member-pause"), { method: "POST", body: { membershipId, reason, idempotencyKey: makeIdempotencyKey("manager-pause") } }),
  resumeMember: (groupId: string, membershipId: string, reason: string) => request<{ membership: GroupMembership }>(actionPath(groupId, "member-pause"), { method: "POST", body: { membershipId, reason, resume: true, idempotencyKey: makeIdempotencyKey("manager-resume") } }),
  removeMember: (groupId: string, membershipId: string, reason: string) => request<{ removal: Record<string, unknown> }>(actionPath(groupId, "member-remove"), { method: "POST", body: { membershipId, reason, idempotencyKey: makeIdempotencyKey("remove") } }),
  emergencyStop: (groupId: string, reason: string) => request<{ stop: Record<string, unknown> }>(actionPath(groupId, "emergency-stop"), { method: "POST", body: { reason, idempotencyKey: makeIdempotencyKey("emergency") } }),
  submitGroupIntent: (input: {
    groupId: string; clientIntentId: string; symbol: string; marketType: "SPOT" | "PERPETUAL" | "FUTURE" | "OPTION";
    side: "buy" | "sell"; orderType: "MARKET" | "LIMIT" | "TWAP" | "ICEBERG"; quantityModel: "EQUITY_PERCENT";
    quantityValue: number; leverage: number; marginMode: "CROSS" | "ISOLATED"; reduceOnly: boolean;
    limitPrice?: number; takeProfit?: number; stopLoss?: number; strategyParameters?: { durationSeconds?: number; intervalSeconds?: number; randomize?: boolean; orderCount?: number; icebergPreference?: "maker" | "taker" };
    maximumSlippageBps: number; expiresAt: string;
  }) => request<{ intent: { id: string; status: string; symbol: string; expiresAt: string }; delivery: "QUEUED_FOR_BLACK_CLOUD"; idempotent: boolean }>("/api/cloud-execution/intent", { method: "POST", body: input })
};

export function makeIdempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
