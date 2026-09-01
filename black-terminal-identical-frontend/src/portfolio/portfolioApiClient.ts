import { supabase } from "../lib/supabase";
import type { BrokerAuthorizationCapabilities, ConnectionLifecycleState, ConnectionRecord } from "../connectivity/types";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderType, OrderUpdate, SizingMethod, TriggerSource, VenueStrategyParameters } from "../execution/types";
import type { ExchangeId, MarketKind } from "../market-data/types";
import type { PortfolioPosition } from "../positions/types";
import type { BybitPositionProtectionDraft } from "../positions/positionPresentation";
import { defaultRiskControls } from "../risk/types";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "./types";
import { deduplicateCanonicalPositions } from "../positions/canonicalPosition";
import { blackCorePerformanceMonitor } from "../performance/performanceMonitor";
import type { BrokerWorkspaceScope } from "../connectivity/connectionWorkspaceScope";
import { isLocalOnlyRuntime } from "../core/local-runtime/localRuntimeClient";
import {
  connectLocalBybitAccount,
  disconnectLocalBrokerAccount,
  getLocalBrokerPortfolioSnapshot,
  getLocalBrokerRecord,
  listLocalBrokerAccounts,
  refreshLocalBrokerAccount,
  setLocalBrokerMainnetConfirmation,
} from "../core/local-runtime/localBrokerStore";
import { getLocalBybitInstrumentRules, localBybitOrderLinkId, type LocalBybitOrderReceipt } from "../core/local-runtime/localBybitClient";
import { enqueueAndWaitForLocalExecution } from "../core/local-runtime/localExecutionClient";

type ApiAccount = {
  id: string;
  exchange: ExchangeId;
  accountName: string;
  status: PortfolioAccount["status"];
  apiHealth: "healthy" | "warning" | "failed" | "unknown";
  latencyMs: number;
  permissions: PortfolioAccount["permissions"];
  tradingEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  riskControls?: PortfolioAccount["riskControls"] | null;
  network?: string | null;
  executionEnvironment?: string | null;
  endpointProfile?: string | null;
  brokerAccountUid?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
};

export type BrokerAdapterDescriptor = {
  id: string;
  label: string;
  category: string;
  authorization: BrokerAuthorizationCapabilities;
  products: string[];
  operations: string[];
};

export type PersistedExchangeConnection = {
  workspaceScope: BrokerWorkspaceScope;
  account: PortfolioAccount & {
    network?: string | null;
    executionEnvironment?: string | null;
    endpointProfile?: string | null;
    brokerAccountUid?: string | null;
    lastSyncedAt?: string | null;
    lastError?: string | null;
  };
  lifecycle: ConnectionLifecycleState;
  health: null | {
    readiness?: string;
    publicStream?: string;
    privateStream?: string;
    authentication?: string;
    synchronization?: string;
    latencyMs?: number;
    reconnectCount?: number;
    rateLimitUsage?: string | null;
    capturedAt?: string;
  };
  cloud: null | Record<string, unknown>;
};

export type AuthenticatedConnectionHealth = {
  lifecycle: ConnectionLifecycleState;
  latencyMs: number;
  authentication: "authenticated" | "failed";
  synchronization: "synced" | "stale" | "unknown";
  privateStream: "connected" | "disconnected" | "unknown";
  publicStream: "connected" | "disconnected" | "unknown";
  permissions: { read: boolean; trading: boolean; withdrawal: boolean; warnings: string[] };
  clockSkewMs: number;
  lastSuccessfulHeartbeat: number;
  executionReady: boolean;
  readinessReason: string;
};

type ApiSnapshot = {
  freshness?: {
    status?: PortfolioSnapshot["freshness"]["status"];
    source?: PortfolioSnapshot["freshness"]["source"];
    fetchedAt?: number | string;
    brokerSyncedAt?: number | string | null;
    blockerCode?: PortfolioSnapshot["freshness"]["blockerCode"];
    ageMs?: number;
    staleAfterMs?: number;
    quarantinedPositionCount?: number;
    message?: string;
  };
  summary: PortfolioSnapshot["summary"];
  accounts: ApiAccount[];
  balances: Array<{
    accountId: string;
    asset: string;
    free: number;
    locked: number;
    total: number;
    usdValue?: number | null;
  }>;
  positions: Array<Omit<PortfolioPosition, "openedAt"> & { openedAt?: string | number | null }>;
  orders: any[];
  orderSync?: PortfolioSnapshot["orderSync"];
};

export type PortfolioOrderDraft = {
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketKind: MarketKind;
  side: "buy" | "sell";
  orderType: OrderType;
  quantity: number;
  quantityMode?: string;
  sizingMethod?: SizingMethod;
  referencePrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  leverage?: number;
  marginMode?: MarginMode;
  source?: ExecutionSource;
  destinations?: ExecutionDestination[];
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: "gtc" | "ioc" | "fok";
  triggerBy?: TriggerSource;
  tpTriggerBy?: TriggerSource;
  slTriggerBy?: TriggerSource;
  tpslMode?: "full" | "partial";
  positionIdx?: number;
  slippageTolerancePercent?: number;
  strategyParameters?: VenueStrategyParameters;
  trailingStopEnabled?: boolean;
  trailingTrailBy?: number;
  trailingMode?: "percentage" | "usd" | "ticks" | "atr";
  trailingActivation?: "immediate" | "custom-price" | "offset";
  trailingActivationPrice?: number;
  internalOrderId?: string;
  clientOrderId?: string;
  mainnetConfirmed?: boolean;
  liveConfirmation?: string;
};

export type HyperliquidRelayConnectionDraft = {
  masterWalletAddress: string;
  agentPrivateKey: string;
  network: "testnet" | "mainnet";
  accountName?: string;
  mainnetConfirmed?: boolean;
};

export type HyperliquidSyncPayload = {
  accountId: string;
  exchange: "hyperliquid";
  network: "testnet" | "mainnet";
  balances: unknown[];
  positions: unknown[];
  openOrders: OrderUpdate[];
  orderSync: NonNullable<PortfolioSnapshot["orderSync"]>[string];
  fills: unknown[];
  externalStateChanged: boolean;
  syncedAt: string;
};

export type ExchangeDiagnosticsPayload = {
  venueId: string;
  provider: string;
  network: string;
  executionMode: string;
  readiness: string;
  latencyMs: number;
  authentication: string;
  synchronization: string;
  publicStream: string;
  privateStream: string;
  permissions: {
    read: boolean;
    trading: boolean;
    withdrawal: boolean;
    warnings: string[];
  };
  time?: {
    serverTime?: string;
    clockSkewMs?: number;
  };
  metadata?: unknown[];
  balances?: unknown[];
  accountMetrics?: BybitAccountMetrics;
  positions?: unknown[];
  openOrders?: unknown[];
};

export type BybitAccountMetrics = {
  accountType: string;
  walletBalanceUsd: number;
  equityUsd: number;
  marginBalanceUsd: number;
  availableBalanceUsd: number;
  initialMarginUsd: number;
  maintenanceMarginUsd: number;
  unrealizedPnlUsd: number;
  accountImRate: number | null;
  accountMmRate: number | null;
  updatedAt: number;
};

export type ExchangeAccountSyncPayload = {
  accountId: string;
  exchange: "bybit";
  network: "mainnet" | "demo" | "testnet";
  balances: Array<{ asset: string; free: number; locked: number; total: number; usdValue: number }>;
  positions: Array<{
    symbol: string;
    direction: "long" | "short" | "flat";
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    margin: number;
    leverage: number;
    liquidationPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    positionIdx: number;
    positionMode: "one-way" | "hedge";
    marginMode: "cross" | "isolated";
    riskId: number;
    positionValue: number;
    openedAt: number;
  }>;
  openOrders: unknown[];
  strategies: Array<{
    strategyId: string;
    strategyType: "chaseOrder" | "twap" | "iceberg" | "pov";
    symbol: string;
    side: "buy" | "sell";
    status: string;
    quantity: number;
    filledQuantity: number;
    averageFillPrice: number | null;
    reduceOnly: boolean;
    duration: number;
    interval: number;
    reason?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  accountMetrics: BybitAccountMetrics;
  executionState: {
    tradingEnabled: boolean;
    readOnly: boolean;
    allowedSymbols: string[];
    maxNotionalUsd: number;
    readinessReason: string;
  };
  instrumentRules: {
    nativeSymbol: string;
    canonicalBase: string;
    canonicalQuote: string;
    settlementAsset: string;
    tickSize: number;
    quantityStep: number;
    minQuantity: number;
    minNotional: number;
    maxQuantity: number;
    pricePrecision: number;
    quantityPrecision: number;
    leverageLimits: { min: number; max: number; step: number };
    supportedMarginModes: string[];
    supportedTimeInForce: string[];
    tradingStatus: string;
  } | null;
  selectedPosition: ExchangeAccountSyncPayload["positions"][number] | null;
  accountState: {
    unifiedMarginStatus: number;
    accountGeneration: string;
    marginMode: MarginMode;
    rawMarginMode: string;
    updatedAt: number;
  };
  riskLimits: Array<{
    id: number;
    symbol: string;
    riskLimitValue: number;
    maintenanceMargin: number;
    initialMargin: number;
    maxLeverage: number;
    lowestRisk: boolean;
  }>;
  priceLimit: {
    symbol: string;
    maximumBuyPrice: number;
    minimumSellPrice: number;
    updatedAt: number;
  };
  externalStateChanged: boolean;
  syncedAt: string;
  latencyMs: number;
};

export type BybitRuntimeStatusPayload = {
  venueId: "bybit";
  network: "mainnet" | "demo" | "testnet";
  account: {
    found: boolean;
    id: string;
    label: string;
    maskedIdentifier: string;
    status: string;
    accountMode: string;
    permissions: string[];
    tradingEnabled: boolean;
    readOnly: boolean;
  };
  runtime: {
    credentialsDecryptable: boolean;
    serverTimeReachable: boolean;
    clockSkewMs: number | null;
    metadataLoaded: boolean;
    publicApiReachable: boolean;
    privateStreamRunning: boolean;
    privateStreamAuthenticated: boolean;
    lastPrivateEventAt: number | string | null;
    privateStreamAgeMs: number | null;
    balanceSyncHealthy: boolean;
    positionSyncHealthy: boolean;
    orderSyncHealthy: boolean;
    executionEndpointAvailable: boolean;
    reconnectCount: number;
    lastError: string | null;
  };
  safety: {
    validationModeEnabled: boolean;
    accountAllowlisted: boolean;
    symbolAllowlisted: boolean;
    maxNotionalConfigured: boolean;
    maxNotionalUsd: number;
    capacityMode: "operator-cap" | "account-margin";
    withdrawalPermissionAbsent: boolean;
    readPermissionPresent: boolean;
    tradePermissionPresent: boolean;
  };
  readiness: {
    executionReady: boolean;
    readinessReason: string;
    blockers: string[];
  };
  certification: {
    latestStatus: string;
    latestReadiness: string;
    mainnetValidated: boolean;
    decision: string;
    missingMandatory: string[];
    failed: string[];
    evidenceRows: number;
  };
};

export type BlackCloudStatusPayload = {
  nodes: Array<{
    node_id: string; deployment_commit: string; software_version: string; node_version: string;
    worker_instance_id: string; execution_environment: "DEMO" | "MAINNET_LIVE";
    status: "STARTING" | "READY" | "DEGRADED" | "DRAINING" | "OFFLINE";
    reportedStatus: string; startup_phase: string; started_at: string; last_heartbeat_at: string;
    heartbeatAgeMs: number | null; stale: boolean; clockStatus: "HEALTHY" | "WARNING" | "UNSAFE";
    active_connection_count: number; ready_connection_count: number; degraded_connection_count: number;
    active_strategy_count: number; queue_depth: number; oldest_queue_age_ms: number;
    endpointProfile: string | null; strategyRuntimeEnabled: boolean;
  }>;
  connections: Array<{
    id: string; account_id: string | null; provider: string; label: string; account_reference: string | null;
    connection_mode: string; execution_capability: string; health_status: string;
    execution_environment: "DEMO" | "MAINNET_LIVE" | null; endpoint_profile: string | null;
    broker_account_uid: string | null; permission_snapshot: Record<string, unknown>; certification_state: string;
    lifecycle_status: string; control_state: "ACTIVE" | "PAUSED" | "EMERGENCY_STOP";
    last_private_event_at: string | null; last_reconciled_at: string | null;
    last_error_code: string | null; paused_at: string | null; emergency_stopped_at: string | null;
    credential_state: string; worker_state: string; synchronization_state: string; execution_readiness: string;
    last_heartbeat_at: string | null; last_account_event_at: string | null; last_order_event_at: string | null;
    last_position_sync_at: string | null; reconnect_attempts: number; current_lease_generation: number | null; degradation_reasons: string[];
  }>;
  mandates: Array<{ id: string; group_id: string; broker_connection_id: string; status: string; allocation_method: string; allocation_value: number; max_leverage: number }>;
  automationMandates: Array<{
    id: string; connection_id: string; broker: string; account_reference: string; status: string;
    allow_read: boolean; allow_trade: boolean; allow_cancel: boolean; allow_modify: boolean;
    allow_strategy_execution: boolean; allow_copy_trading: boolean; allow_investment_group_execution: boolean;
    max_order_notional: number | null; max_position_notional: number | null; max_leverage: number | null; max_daily_loss: number | null;
    execution_environment: "DEMO" | "MAINNET_LIVE" | null; risk_policy_version: number;
    mandate_version: number; accepted_at: string | null; expires_at: string | null; revoked_at: string | null;
  }>;
  strategyDeployments: Array<{ id: string; connection_id: string; strategy_id: string | null; strategy_version: string; symbol: string; timeframe: string; status: string; deployed_at: string | null; last_heartbeat_at: string | null }>;
  recentPlans: Array<{ id: string; broker_connection_id: string; execution_status: string; risk_result: string; rejection_reason: string | null; updated_at: string }>;
  openIncidents: Array<{ id: string; connection_id: string; severity: string; incident_type: string; status: string; title: string; created_at: string }>;
};

export async function getPortfolioApiToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function localNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function localObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function localList(value: unknown) {
  return Array.isArray(value) ? value.map(localObject) : [];
}

function localLifecycle(account: PortfolioAccount): ConnectionLifecycleState {
  if (account.apiHealth === "failed" || account.status === "degraded") return "DEGRADED";
  return account.permissions.includes("place-orders") ? "CONNECTED_TRADING" : "CONNECTED_READ_ONLY";
}

const localBybitAdapter: BrokerAdapterDescriptor = {
  id: "bybit",
  label: "Bybit",
  category: "centralized-exchange",
  authorization: {
    oauthAuthorization: false,
    oauthConfigured: false,
    oauthUnavailableReason: "The standalone runtime stores trade-only API credentials in the operating-system vault.",
    apiCredentials: true,
    walletConnection: false,
    institutionalSession: false,
    readOnlyConnection: true,
    tradingConnection: true,
  },
  products: ["perpetual"],
  operations: ["read-account", "orders", "cancel", "modify", "leverage", "full-tp-sl", "partial-take-profit", "reversal"],
};

function localPersistedConnections(): PersistedExchangeConnection[] {
  return listLocalBrokerAccounts().map((account) => {
    const record = getLocalBrokerRecord(account.id);
    const capturedAt = record?.lastSnapshot?.capturedAt ?? 0;
    const lifecycle = localLifecycle(account);
    return {
      workspaceScope: record?.workspaceScope || "PERSONAL",
      account: {
        ...account,
        network: record?.environment.toLowerCase() || account.network,
        executionEnvironment: record?.environment === "MAINNET" ? "MAINNET_LIVE" : record?.environment || null,
        endpointProfile: record ? `BYBIT_${record.environment}` : null,
        brokerAccountUid: null,
        lastSyncedAt: capturedAt ? new Date(capturedAt).toISOString() : null,
        lastError: record?.lastError || null,
      },
      lifecycle,
      health: {
        readiness: lifecycle === "CONNECTED_TRADING" ? "execution-ready" : lifecycle === "CONNECTED_READ_ONLY" ? "connected-read-only" : "degraded",
        publicStream: "not-required",
        privateStream: "not-required",
        authentication: account.apiHealth === "failed" ? "failed" : "authenticated",
        synchronization: record?.lastSnapshot ? "synced" : "unknown",
        latencyMs: account.latencyMs,
        reconnectCount: 0,
        capturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined,
      },
      cloud: null,
    };
  });
}

export async function fetchBlackCloudStatusViaApi(): Promise<BlackCloudStatusPayload | null> {
  if (isLocalOnlyRuntime()) {
    const connections = localPersistedConnections();
    const now = new Date().toISOString();
    return {
      nodes: [{
        node_id: "local-device", deployment_commit: "LOCAL", software_version: "1.0.7", node_version: "LOCAL_CORE",
        worker_instance_id: "local-device", execution_environment: connections.some((item) => item.account.executionEnvironment === "MAINNET_LIVE") ? "MAINNET_LIVE" : "DEMO",
        status: connections.some((item) => item.lifecycle === "DEGRADED") ? "DEGRADED" : "READY",
        reportedStatus: "LOCAL_BACKGROUND_RUNTIME", startup_phase: "RUNNING", started_at: now, last_heartbeat_at: now,
        heartbeatAgeMs: 0, stale: false, clockStatus: "HEALTHY", active_connection_count: connections.length,
        ready_connection_count: connections.filter((item) => item.lifecycle === "CONNECTED_TRADING").length,
        degraded_connection_count: connections.filter((item) => item.lifecycle === "DEGRADED").length,
        active_strategy_count: 0, queue_depth: 0, oldest_queue_age_ms: 0, endpointProfile: "LOCAL_DEVICE", strategyRuntimeEnabled: true,
      }],
      connections: connections.map((item) => ({
        id: item.account.id, account_id: item.account.id, provider: "BYBIT", label: item.account.accountName,
        account_reference: item.account.id, connection_mode: "LOCAL_OS_VAULT", execution_capability: item.lifecycle === "CONNECTED_TRADING" ? "TRADE" : "READ_ONLY",
        health_status: item.account.apiHealth.toUpperCase(), execution_environment: item.account.executionEnvironment === "MAINNET_LIVE" ? "MAINNET_LIVE" : "DEMO",
        endpoint_profile: item.account.endpointProfile || null, broker_account_uid: null,
        permission_snapshot: { permissions: item.account.permissions }, certification_state: "LOCAL_UNCERTIFIED",
        lifecycle_status: item.lifecycle, control_state: "ACTIVE", last_private_event_at: null,
        last_reconciled_at: item.account.lastSyncedAt || null, last_error_code: item.account.lastError || null,
        paused_at: null, emergency_stopped_at: null, credential_state: "OS_VAULT", worker_state: "LOCAL_RUNTIME",
        synchronization_state: item.health?.synchronization || "unknown", execution_readiness: item.health?.readiness || "unknown",
        last_heartbeat_at: item.account.lastSyncedAt || null, last_account_event_at: item.account.lastSyncedAt || null,
        last_order_event_at: null, last_position_sync_at: item.account.lastSyncedAt || null, reconnect_attempts: 0,
        current_lease_generation: null, degradation_reasons: item.account.lastError ? [item.account.lastError] : [],
      })),
      mandates: [], automationMandates: [], strategyDeployments: [], recentPlans: [], openIncidents: [],
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/cloud-execution/status", { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export type BlackCloudControlAction = "pause" | "pause-new-entries" | "resume" | "stop-strategy" | "cancel-entry-orders" | "cancel-all" | "close-strategy-positions" | "revoke-mandate" | "disconnect-broker" | "emergency-stop" | "emergency-account-lock";

export async function controlBlackCloudConnectionViaApi(connectionId: string, action: BlackCloudControlAction, options: { reason?: string; strategyDeploymentId?: string; cancelProtectiveOrders?: boolean } = {}) {
  if (isLocalOnlyRuntime()) {
    void connectionId;
    void action;
    void options;
    throw new Error("Black Cloud controls do not apply to the local runtime. Pause or disconnect the specific local Strategy Lab target instead.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/cloud-execution/control", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, action, ...options })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<{ connection: BlackCloudStatusPayload["connections"][number]; monitoring: string; reconciliation: string; newOrders: string }>;
}

export async function activateBlackCloudConnectionViaApi(accountId: string, automation: {
  allowStrategyExecution?: boolean; allowCopyTrading?: boolean; allowInvestmentGroupExecution?: boolean;
  maxOrderNotional?: number; maxPositionNotional?: number; maxLeverage?: number; maxDailyLoss?: number;
  allowedStrategies?: string[]; allowedSymbols?: string[]; expiresAt?: string; preserveProtectiveOrders?: boolean;
} = {}) {
  if (isLocalOnlyRuntime()) {
    void accountId;
    void automation;
    throw new Error("Personal-chart broker accounts are isolated from Strategy Lab. Add a dedicated Strategy Lab connection with the + control.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/cloud-execution/connection", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, automation })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<{ connection: { id: string; provider: string; healthStatus: string }; offlineExecution: string; readinessReason: string }>;
}

export async function fetchPortfolioSnapshotFromApi(activeAccountIds?: string[]): Promise<PortfolioSnapshot | null> {
  if (isLocalOnlyRuntime()) return getLocalBrokerPortfolioSnapshot(activeAccountIds);
  const token = await getPortfolioApiToken();
  if (!token) return null;
  if (activeAccountIds?.length === 0) return null;

  const query = activeAccountIds ? `?accountIds=${encodeURIComponent([...new Set(activeAccountIds)].join(","))}` : "";

  const response = await fetch(`/api/portfolio/snapshot${query}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  recordResponseTiming("portfolio.snapshot", response);

  if (!response.ok) throw new Error(await readApiError(response));
  return mapSnapshot(await response.json());
}

export async function connectExchangeAccountViaApi(draft: ExchangeConnectionDraft): Promise<PortfolioAccount | null> {
  if (isLocalOnlyRuntime()) return connectLocalBybitAccount(draft);
  const token = await getPortfolioApiToken();
  if (!token) return null;

  // Keep the production request surface minimal: environment, region and
  // execution capabilities are server-owned policy, never browser inputs.
  const payload = {
    exchange: draft.exchange,
    accountName: draft.accountName,
    apiKey: draft.apiKey,
    apiSecret: draft.apiSecret,
    ...(draft.passphrase?.trim() ? { passphrase: draft.passphrase } : {})
  };

  const response = await fetch("/api/exchange-accounts/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapAccount(data.account);
}

export async function connectBybitDemoAccountViaApi(draft: Pick<ExchangeConnectionDraft, "accountName" | "apiKey" | "apiSecret">): Promise<PortfolioAccount | null> {
  if (isLocalOnlyRuntime()) return connectLocalBybitAccount({
    exchange: "bybit",
    ...draft,
    environment: "demo",
    workspaceScope: "PERSONAL",
  });
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/exchange-accounts/connect-demo", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      exchange: "bybit",
      accountName: draft.accountName,
      apiKey: draft.apiKey,
      apiSecret: draft.apiSecret
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapAccount(data.account);
}

export async function listPersistedExchangeConnectionsViaApi(): Promise<{ connections: PersistedExchangeConnection[]; adapters: BrokerAdapterDescriptor[] } | null> {
  if (isLocalOnlyRuntime()) return { connections: localPersistedConnections(), adapters: [localBybitAdapter] };
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/exchange-accounts/list", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json() as { connections: Array<Omit<PersistedExchangeConnection, "account"> & { account: ApiAccount }>; adapters: BrokerAdapterDescriptor[] };
  return {
    adapters: data.adapters || [],
    connections: (data.connections || []).map((item) => ({ ...item, account: { ...mapAccount(item.account), network: item.account.network, executionEnvironment: item.account.executionEnvironment, endpointProfile: item.account.endpointProfile, brokerAccountUid: item.account.brokerAccountUid, lastSyncedAt: item.account.lastSyncedAt, lastError: item.account.lastError } }))
  };
}

export async function probeExchangeAccountHealthViaApi(accountId: string): Promise<AuthenticatedConnectionHealth | null> {
  if (isLocalOnlyRuntime()) {
    const record = await refreshLocalBrokerAccount(accountId, true);
    const trading = record.account.permissions.includes("place-orders");
    const withdrawal = !record.account.permissions.includes("withdraw-disabled");
    return {
      lifecycle: localLifecycle(record.account),
      latencyMs: record.account.latencyMs,
      authentication: record.account.apiHealth === "failed" ? "failed" : "authenticated",
      synchronization: record.lastSnapshot ? "synced" : "unknown",
      privateStream: "unknown",
      publicStream: "connected",
      permissions: {
        read: true,
        trading,
        withdrawal,
        warnings: withdrawal ? ["Withdrawal permission is enabled. Use a trade-only API key."] : [],
      },
      clockSkewMs: record.lastSnapshot?.clockSkewMs || 0,
      lastSuccessfulHeartbeat: record.lastSnapshot?.capturedAt || 0,
      executionReady: trading && !withdrawal && (record.environment !== "MAINNET" || record.mainnetConfirmed),
      readinessReason: !trading ? "The API key is read-only." : withdrawal ? "Withdrawal-enabled API keys are blocked from automated Strategy Lab execution." : record.environment === "MAINNET" && !record.mainnetConfirmed ? "Real-funds Mainnet authority has not been confirmed." : "Local REST reconciliation and durable execution are ready.",
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/exchange-accounts/health", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function beginBrokerAuthorizationViaApi(input: { provider: "bybit"; accountName: string; returnPath?: string }): Promise<{ authorizationUrl: string; expiresInSeconds: number } | null> {
  if (isLocalOnlyRuntime()) {
    void input;
    throw new Error("OAuth broker authorization is not available in standalone mode. Connect a trade-only API key stored in the operating-system vault.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/exchange-accounts/oauth-start", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "bybit",
      accountName: input.accountName,
      ...(input.returnPath ? { returnPath: input.returnPath } : {})
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function disconnectExchangeAccountViaApi(accountId: string): Promise<void> {
  if (isLocalOnlyRuntime()) {
    await disconnectLocalBrokerAccount(accountId);
    return;
  }
  const token = await getPortfolioApiToken();
  if (!token) return;
  const response = await fetch(`/api/exchange-accounts/${encodeURIComponent(accountId)}?accountId=${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function connectHyperliquidRelayViaApi(draft: HyperliquidRelayConnectionDraft): Promise<ConnectionRecord | null> {
  if (isLocalOnlyRuntime()) {
    void draft;
    throw new Error("The standalone Hyperliquid signer/relay has not been implemented. No cloud relay will be used implicitly.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.connection as ConnectionRecord;
}

export async function submitPortfolioOrderViaApi(draft: PortfolioOrderDraft): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) return submitLocalPortfolioOrder(draft);

  if (draft.exchange === "hyperliquid") return submitHyperliquidOrderViaApi(draft);

  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/execution/order", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });
  recordResponseTiming("execution.server_route", response);

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.order);
}

async function submitLocalPortfolioOrder(draft: PortfolioOrderDraft): Promise<OrderUpdate> {
  if (draft.exchange !== "bybit") throw new Error("The standalone native execution path currently supports Bybit linear contracts only.");
  if (draft.marketKind !== "perpetual" && draft.marketKind !== "futures") {
    throw new Error("The standalone Bybit adapter currently supports linear perpetual/futures orders only.");
  }
  const record = getLocalBrokerRecord(draft.accountId);
  if (!record) throw new Error("The local Bybit account is not registered on this device.");
  if (!record.account.permissions.includes("place-orders")) throw new Error("This Bybit API key is read-only and cannot place orders.");
  if (!["market", "limit", "stop-market", "stop-limit"].includes(draft.orderType)) {
    throw new Error(`The native Bybit adapter does not yet support ${draft.orderType} orders.`);
  }
  const conditional = draft.orderType === "stop-market" || draft.orderType === "stop-limit";
  if (conditional && !(Number.isFinite(draft.stopPrice) && Number.isFinite(draft.referencePrice))) {
    throw new Error("A local Bybit conditional order requires stop and reference prices.");
  }
  const orderLinkId = localBybitOrderLinkId(draft.clientOrderId || draft.internalOrderId || `bt-${Date.now().toString(36)}`);
  const nativeRequest = {
    accountId: draft.accountId,
    environment: record.environment,
    symbol: draft.symbol,
    side: draft.side === "buy" ? "Buy" : "Sell",
    orderType: draft.orderType === "limit" || draft.orderType === "stop-limit" ? "Limit" : "Market",
    quantity: String(draft.quantity),
    ...(draft.limitPrice !== undefined ? { price: String(draft.limitPrice) } : {}),
    reduceOnly: draft.reduceOnly === true,
    closeOnTrigger: draft.reduceOnly === true,
    positionIdx: draft.positionIdx === 1 || draft.positionIdx === 2 ? draft.positionIdx : 0,
    ...(draft.leverage !== undefined ? { leverage: String(draft.leverage) } : {}),
    orderLinkId,
    ...(conditional ? {
      triggerPrice: String(draft.stopPrice),
      triggerDirection: Number(draft.stopPrice) > Number(draft.referencePrice) ? 1 as const : 2 as const,
      triggerBy: draft.triggerBy === "last" ? "LastPrice" as const : draft.triggerBy === "index" ? "IndexPrice" as const : "MarkPrice" as const,
    } : {}),
    ...(draft.takeProfit !== undefined ? { takeProfit: String(draft.takeProfit) } : {}),
    ...(draft.stopLoss !== undefined ? { stopLoss: String(draft.stopLoss) } : {}),
    mainnetConfirmed: record.environment !== "MAINNET" || (record.mainnetConfirmed && draft.mainnetConfirmed === true),
  };
  const intent = await enqueueAndWaitForLocalExecution<LocalBybitOrderReceipt>({
    executionType: "ORDER",
    idempotencyKey: `manual:${draft.accountId}:${orderLinkId}`,
    payload: nativeRequest,
    priority: draft.reduceOnly ? 15 : 40,
    maxAttempts: 8,
  }, 45_000);
  const receipt = intent.result;
  if (!receipt) {
    return {
      accountId: draft.accountId,
      exchange: "bybit",
      orderId: `local-queue-${intent.id}`,
      clientOrderId: orderLinkId,
      internalId: draft.internalOrderId,
      symbol: draft.symbol,
      status: "pending",
      filledQuantity: 0,
      reason: "Durably queued; native broker reconciliation is still in progress.",
      time: intent.updatedAt,
      network: record.environment.toLowerCase(),
      category: "linear",
      side: draft.side,
      type: draft.orderType,
      quantity: draft.quantity,
      reduceOnly: draft.reduceOnly === true,
      source: "black-terminal",
      ownership: "black-terminal",
    };
  }
  const raw = receipt.raw || {};
  const status = receipt.orderStatus === "Filled" ? "filled"
    : receipt.orderStatus === "PartiallyFilled" ? "partially-filled"
      : ["New", "Untriggered", "Triggered"].includes(receipt.orderStatus) ? "working" : "pending";
  return {
    accountId: draft.accountId,
    exchange: "bybit",
    orderId: receipt.orderId,
    venueOrderId: receipt.orderId,
    clientOrderId: receipt.orderLinkId,
    internalId: draft.internalOrderId,
    symbol: receipt.symbol,
    status,
    filledQuantity: Number.parseFloat(String(raw.cumExecQty || (status === "filled" ? draft.quantity : 0))) || 0,
    averageFillPrice: Number.parseFloat(String(raw.avgPrice || "0")) || undefined,
    time: receipt.reconciledAt,
    network: record.environment.toLowerCase(),
    category: "linear",
    normalizedSymbol: receipt.symbol,
    side: draft.side,
    type: draft.orderType,
    orderType: draft.orderType,
    price: draft.limitPrice,
    triggerPrice: draft.stopPrice,
    quantity: draft.quantity,
    reduceOnly: draft.reduceOnly === true,
    closeOnTrigger: draft.reduceOnly === true,
    positionIdx: draft.positionIdx,
    source: "black-terminal",
    ownership: "black-terminal",
    createdTime: receipt.acceptedAt,
    updatedTime: receipt.reconciledAt,
  };
}

export async function updateBybitAccountModeViaApi(draft: {
  accountId: string;
  action: "set-leverage" | "switch-margin-mode" | "switch-position-mode";
  symbol: string;
  category?: "linear" | "inverse";
  leverage?: number;
  marginMode?: MarginMode;
  positionMode?: "one-way" | "hedge";
  mainnetConfirmed: boolean;
  liveConfirmation: string;
}): Promise<{ report: Record<string, unknown> } | null> {
  if (isLocalOnlyRuntime()) {
    if (draft.action !== "set-leverage" || !(Number.isFinite(draft.leverage) && Number(draft.leverage) > 0)) {
      throw new Error("The standalone native adapter currently supports account-mode changes only for leverage.");
    }
    const record = getLocalBrokerRecord(draft.accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    const intent = await enqueueAndWaitForLocalExecution<Record<string, unknown>>({
      executionType: "LEVERAGE",
      idempotencyKey: `leverage:${draft.accountId}:${draft.symbol}:${draft.leverage}`,
      payload: {
        accountId: draft.accountId,
        environment: record.environment,
        symbol: draft.symbol,
        leverage: String(draft.leverage),
        mainnetConfirmed: record.environment !== "MAINNET" || (record.mainnetConfirmed && draft.mainnetConfirmed),
      },
      priority: 20,
    });
    if (!intent.result) throw new Error("Leverage is durably queued but native reconciliation has not completed yet.");
    return { report: intent.result };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/account-mode", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

function decimalPlaces(value: string) {
  const normalized = value.replace(/0+$/, "");
  return normalized.includes(".") ? normalized.split(".")[1].length : 0;
}

async function localAccountSync(accountId: string, symbol: string, marketKind: MarketKind): Promise<ExchangeAccountSyncPayload> {
  if (marketKind !== "perpetual" && marketKind !== "futures") {
    throw new Error("The standalone authenticated Bybit adapter currently supports linear perpetual/futures account synchronization only.");
  }
  const record = await refreshLocalBrokerAccount(accountId, true);
  const snapshot = await getLocalBrokerPortfolioSnapshot([accountId]);
  const rules = await getLocalBybitInstrumentRules(record.environment, symbol);
  const rawWallet = localList(localObject(record.lastSnapshot?.wallet).list)[0] || {};
  const rawPositions = localList(localObject(record.lastSnapshot?.positions).list);
  const positions: ExchangeAccountSyncPayload["positions"] = snapshot.positions.map((position) => {
    const raw = rawPositions.find((item) => String(item.symbol || "").toUpperCase() === position.symbol.toUpperCase()
      && localNumber(item.positionIdx) === Number(position.positionIdx || 0)) || {};
    return {
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
      currentPrice: position.currentPrice,
      unrealizedPnl: position.unrealizedPnl,
      realizedPnl: position.realizedPnl,
      margin: position.margin,
      leverage: position.leverage,
      liquidationPrice: position.liquidationPrice ?? null,
      stopLoss: position.stopLoss ?? null,
      takeProfit: position.takeProfit ?? null,
      positionIdx: Number(position.positionIdx || 0),
      positionMode: Number(position.positionIdx || 0) === 0 ? "one-way" : "hedge",
      marginMode: localNumber(raw.tradeMode) === 1 ? "isolated" : "cross",
      riskId: localNumber(raw.riskId),
      positionValue: localNumber(raw.positionValue) || position.quantity * position.currentPrice,
      openedAt: position.openedAt,
    };
  });
  const normalizedSymbol = symbol.trim().toUpperCase();
  const quote = normalizedSymbol.endsWith("USDC") ? "USDC" : normalizedSymbol.endsWith("USDT") ? "USDT" : "USD";
  const trading = record.account.permissions.includes("place-orders");
  const withdrawal = !record.account.permissions.includes("withdraw-disabled");
  const mainnetAuthorized = record.environment !== "MAINNET" || record.mainnetConfirmed;
  const executionReady = trading && !withdrawal && mainnetAuthorized;
  const readinessReason = !trading
    ? "The API key is read-only."
    : withdrawal
      ? "Withdrawal-enabled API keys are blocked from automated execution."
      : !mainnetAuthorized
        ? "Real-funds Mainnet authority has not been confirmed."
        : "Local durable execution is ready.";
  const maxNotionalUsd = Math.max(0, Number(record.account.riskControls.maxPositionUsd || 0));
  const updatedAt = record.lastSnapshot?.capturedAt || Date.now();
  const accountMetrics: BybitAccountMetrics = {
    accountType: String(rawWallet.accountType || "UNIFIED"),
    walletBalanceUsd: localNumber(record.lastSnapshot?.totalWalletBalanceUsd),
    equityUsd: localNumber(record.lastSnapshot?.totalEquityUsd),
    marginBalanceUsd: localNumber(rawWallet.totalMarginBalance) || localNumber(record.lastSnapshot?.totalEquityUsd),
    availableBalanceUsd: localNumber(record.lastSnapshot?.totalAvailableBalanceUsd),
    initialMarginUsd: localNumber(record.lastSnapshot?.totalInitialMarginUsd),
    maintenanceMarginUsd: localNumber(record.lastSnapshot?.totalMaintenanceMarginUsd),
    unrealizedPnlUsd: localNumber(record.lastSnapshot?.totalPerpetualUnrealizedPnlUsd),
    accountImRate: rawWallet.accountIMRate === undefined || rawWallet.accountIMRate === "" ? null : localNumber(rawWallet.accountIMRate),
    accountMmRate: rawWallet.accountMMRate === undefined || rawWallet.accountMMRate === "" ? null : localNumber(rawWallet.accountMMRate),
    updatedAt,
  };
  return {
    accountId,
    exchange: "bybit",
    network: record.environment.toLowerCase() as "mainnet" | "demo" | "testnet",
    balances: snapshot.balances.map((balance) => ({
      asset: balance.asset,
      free: balance.free,
      locked: balance.locked,
      total: balance.total,
      usdValue: balance.usdValue || 0,
    })),
    positions,
    openOrders: snapshot.orders,
    strategies: [],
    accountMetrics,
    executionState: {
      tradingEnabled: executionReady,
      readOnly: !executionReady,
      allowedSymbols: record.account.riskControls.allowedSymbols,
      maxNotionalUsd,
      readinessReason,
    },
    instrumentRules: {
      nativeSymbol: rules.symbol,
      canonicalBase: normalizedSymbol.slice(0, -quote.length),
      canonicalQuote: quote,
      settlementAsset: quote,
      tickSize: localNumber(rules.tickSize),
      quantityStep: localNumber(rules.quantityStep),
      minQuantity: localNumber(rules.minQuantity),
      minNotional: localNumber(rules.minNotional),
      maxQuantity: localNumber(rules.maxMarketQuantity),
      pricePrecision: decimalPlaces(rules.tickSize),
      quantityPrecision: decimalPlaces(rules.quantityStep),
      leverageLimits: { min: localNumber(rules.minLeverage), max: localNumber(rules.maxLeverage), step: localNumber(rules.leverageStep) },
      supportedMarginModes: ["cross", "isolated"],
      supportedTimeInForce: ["GTC", "IOC", "FOK", "PostOnly"],
      tradingStatus: rules.status,
    },
    selectedPosition: positions.find((position) => position.symbol.toUpperCase() === normalizedSymbol) || null,
    accountState: {
      unifiedMarginStatus: localNumber(rawWallet.unifiedMarginStatus) || 1,
      accountGeneration: "UNIFIED",
      marginMode: "cross",
      rawMarginMode: String(rawWallet.marginMode || "REGULAR_MARGIN"),
      updatedAt,
    },
    riskLimits: [],
    priceLimit: { symbol: normalizedSymbol, maximumBuyPrice: 0, minimumSellPrice: 0, updatedAt },
    externalStateChanged: false,
    syncedAt: new Date(updatedAt).toISOString(),
    latencyMs: record.account.latencyMs,
  };
}

export async function stopBybitStrategyViaApi(draft: {
  accountId: string;
  strategyId: string;
  symbol: string;
  mainnetConfirmed: boolean;
  liveConfirmation: string;
}) {
  if (isLocalOnlyRuntime()) {
    void draft;
    throw new Error("Venue-native strategy cancellation is not available in standalone mode. Pause the Strategy Lab target so its local coordinator can reconcile owned orders safely.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/strategy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()).report as { strategyId: string; status: string };
}

export async function runExchangeAccountDiagnosticsViaApi(accountId: string, symbol = "BTCUSDT"): Promise<ExchangeDiagnosticsPayload | null> {
  if (isLocalOnlyRuntime()) {
    const sync = await localAccountSync(accountId, symbol, "perpetual");
    const record = getLocalBrokerRecord(accountId);
    const withdrawal = Boolean(record && !record.account.permissions.includes("withdraw-disabled"));
    return {
      venueId: "bybit",
      provider: "BYBIT_LOCAL",
      network: sync.network,
      executionMode: "LOCAL_DURABLE_REST",
      readiness: sync.executionState.tradingEnabled ? "execution-ready" : "execution-blocked",
      latencyMs: sync.latencyMs,
      authentication: record?.account.apiHealth === "failed" ? "failed" : "authenticated",
      synchronization: "synced",
      publicStream: "connected",
      privateStream: "not-required",
      permissions: {
        read: true,
        trading: Boolean(record?.account.permissions.includes("place-orders")),
        withdrawal,
        warnings: withdrawal ? ["Withdrawal permission is enabled. Replace this key with a trade-only API key."] : [],
      },
      time: { serverTime: record?.lastSnapshot ? new Date(record.lastSnapshot.serverTime).toISOString() : undefined, clockSkewMs: record?.lastSnapshot?.clockSkewMs },
      balances: sync.balances,
      accountMetrics: sync.accountMetrics,
      positions: sync.positions,
      openOrders: sync.openOrders,
      metadata: sync.instrumentRules ? [sync.instrumentRules] : [],
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/diagnostics", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId, symbol })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.diagnostics as ExchangeDiagnosticsPayload;
}

export async function syncExchangeAccountViaApi(accountId: string, symbol = "BTCUSDT", marketKind: MarketKind = "perpetual"): Promise<ExchangeAccountSyncPayload | null> {
  if (isLocalOnlyRuntime()) return localAccountSync(accountId, symbol, marketKind);
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId, symbol, marketKind })
  });
  recordResponseTiming("account.sync_route", response);

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.sync as ExchangeAccountSyncPayload;
}

export async function cancelVenueOrderViaApi(order: OrderUpdate): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) {
    const record = getLocalBrokerRecord(order.accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    const venueOrderId = order.venueOrderId || order.orderId;
    const intent = await enqueueAndWaitForLocalExecution<LocalBybitOrderReceipt>({
      executionType: "CANCEL",
      idempotencyKey: `cancel:${order.accountId}:${venueOrderId}`,
      payload: {
        accountId: order.accountId,
        environment: record.environment,
        symbol: order.symbol,
        orderId: venueOrderId,
        mainnetConfirmed: record.environment !== "MAINNET" || record.mainnetConfirmed,
      },
      priority: 5,
    });
    return {
      ...order,
      status: intent.result?.orderStatus === "Cancelled" ? "cancelled" : "pending",
      reason: intent.result ? undefined : "Cancellation is durably queued and awaiting native reconciliation.",
      time: intent.result?.reconciledAt || intent.updatedAt,
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;
  const response = await fetch("/api/execution/cancel", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: order.internalId || order.orderId,
      venueOrderId: order.venueOrderId || order.orderId,
      accountId: order.accountId,
      symbol: order.symbol,
      category: order.category,
      marketKind: order.category === "spot" ? "spot" : "perpetual",
      clientOrderId: order.clientOrderId,
      mainnetConfirmed: true,
      liveConfirmation: "LIVE"
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.order);
}

export async function modifyVenueOrderViaApi(order: OrderUpdate, changes: { quantity?: number; limitPrice?: number }): Promise<OrderUpdate> {
  if (isLocalOnlyRuntime()) {
    const record = getLocalBrokerRecord(order.accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    const venueOrderId = order.venueOrderId || order.orderId;
    const identity = localBybitOrderLinkId(`${venueOrderId}:${changes.quantity ?? ""}:${changes.limitPrice ?? ""}`);
    const intent = await enqueueAndWaitForLocalExecution<LocalBybitOrderReceipt>({
      executionType: "AMEND",
      idempotencyKey: `amend:${order.accountId}:${identity}`,
      payload: {
        accountId: order.accountId,
        environment: record.environment,
        symbol: order.symbol,
        orderId: venueOrderId,
        ...(changes.quantity !== undefined ? { quantity: String(changes.quantity) } : {}),
        ...(changes.limitPrice !== undefined ? { price: String(changes.limitPrice) } : {}),
        mainnetConfirmed: record.environment !== "MAINNET" || record.mainnetConfirmed,
      },
      priority: 10,
    });
    return {
      ...order,
      status: intent.result ? "working" : "pending",
      price: changes.limitPrice ?? order.price,
      quantity: changes.quantity ?? order.quantity,
      reason: intent.result ? undefined : "Amendment is durably queued and awaiting native reconciliation.",
      time: intent.result?.reconciledAt || intent.updatedAt,
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) throw new Error("Authenticated Black Terminal session is required.");
  const response = await fetch("/api/execution/modify", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      localOrderId: order.externallyCreated ? undefined : order.internalId,
      orderId: order.venueOrderId || order.orderId,
      exchangeOrderId: order.venueOrderId || order.orderId,
      accountId: order.accountId,
      symbol: order.symbol,
      category: order.category,
      marketKind: order.category === "spot" ? "spot" : "perpetual",
      clientOrderId: order.clientOrderId,
      quantity: changes.quantity,
      limitPrice: changes.limitPrice,
      mainnetConfirmed: true,
      liveConfirmation: "LIVE"
    })
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report);
}

export async function updateBybitPositionProtectionViaApi(draft: BybitPositionProtectionDraft): Promise<{ report: Record<string, unknown> }> {
  if (isLocalOnlyRuntime()) {
    const record = getLocalBrokerRecord(draft.accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    if (draft.category !== "linear") throw new Error("Standalone native position protection currently supports Bybit linear contracts only.");
    const takeProfit = draft.cancelTakeProfit ? "0" : draft.takeProfit !== undefined ? String(draft.takeProfit) : undefined;
    const stopLoss = draft.cancelStopLoss ? "0" : draft.stopLoss !== undefined ? String(draft.stopLoss) : undefined;
    const trailingStop = draft.cancelTrailingStop ? "0" : draft.trailingStop !== undefined ? String(draft.trailingStop) : undefined;
    if (takeProfit === undefined && stopLoss === undefined && trailingStop === undefined) {
      throw new Error("No native protection change was requested.");
    }
    const identity = localBybitOrderLinkId(`${draft.symbol}:${draft.positionIdx}:${takeProfit ?? ""}:${stopLoss ?? ""}:${trailingStop ?? ""}`);
    const intent = await enqueueAndWaitForLocalExecution<Record<string, unknown>>({
      executionType: "PROTECTION",
      idempotencyKey: `protection:${draft.accountId}:${identity}`,
      payload: {
        accountId: draft.accountId,
        environment: record.environment,
        symbol: draft.symbol,
        positionIdx: draft.positionIdx,
        ...(takeProfit !== undefined ? { takeProfit } : {}),
        ...(stopLoss !== undefined ? { stopLoss } : {}),
        ...(trailingStop !== undefined ? { trailingStop } : {}),
        mainnetConfirmed: record.environment !== "MAINNET" || (record.mainnetConfirmed && draft.mainnetConfirmed),
      },
      priority: 5,
      maxAttempts: 8,
    }, 45_000);
    if (!intent.result) throw new Error("The protection update is durably queued but Bybit has not acknowledged it yet.");
    await refreshLocalBrokerAccount(draft.accountId, true);
    return { report: intent.result };
  }
  const token = await getPortfolioApiToken();
  if (!token) throw new Error("Authenticated Black Terminal session is required.");
  const response = await fetch("/api/execution/protection", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function setBybitTradingEnabledViaApi(accountId: string, enabled: boolean, confirmation: string): Promise<{ status: "enabled" | "disabled"; accountId: string } | null> {
  if (isLocalOnlyRuntime()) {
    const record = getLocalBrokerRecord(accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    if (enabled && record.environment === "MAINNET" && confirmation.trim().toUpperCase() !== "LIVE") {
      throw new Error("Type LIVE to confirm real-funds Mainnet authority on this device.");
    }
    await setLocalBrokerMainnetConfirmation(accountId, enabled);
    return { status: enabled ? "enabled" : "disabled", accountId };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/exchange-accounts/mainnet-validation", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      accountId,
      action: enabled ? "enable" : "disable",
      confirmation
    })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function getBybitRuntimeStatusViaApi(accountId: string, symbol = "BTCUSDT"): Promise<BybitRuntimeStatusPayload | null> {
  if (isLocalOnlyRuntime()) {
    const sync = await localAccountSync(accountId, symbol, "perpetual");
    const record = getLocalBrokerRecord(accountId);
    if (!record) throw new Error("The local Bybit account is not registered on this device.");
    const withdrawal = !record.account.permissions.includes("withdraw-disabled");
    const tradePermission = record.account.permissions.includes("place-orders");
    const mainnetAuthority = record.environment !== "MAINNET" || record.mainnetConfirmed;
    const blockers = [
      ...(!tradePermission ? ["API_KEY_READ_ONLY"] : []),
      ...(withdrawal ? ["WITHDRAWAL_PERMISSION_ENABLED"] : []),
      ...(!mainnetAuthority ? ["MAINNET_AUTHORITY_NOT_CONFIRMED"] : []),
      ...(record.lastError ? ["BROKER_RECONCILIATION_FAILED"] : []),
    ];
    const executionReady = blockers.length === 0;
    return {
      venueId: "bybit",
      network: sync.network,
      account: {
        found: true,
        id: accountId,
        label: record.account.accountName,
        maskedIdentifier: "OS VAULT",
        status: record.account.status,
        accountMode: sync.accountState.accountGeneration,
        permissions: record.account.permissions,
        tradingEnabled: executionReady,
        readOnly: !executionReady,
      },
      runtime: {
        credentialsDecryptable: record.account.apiHealth !== "failed",
        serverTimeReachable: Boolean(record.lastSnapshot?.serverTime),
        clockSkewMs: record.lastSnapshot?.clockSkewMs ?? null,
        metadataLoaded: Boolean(sync.instrumentRules),
        publicApiReachable: true,
        privateStreamRunning: false,
        privateStreamAuthenticated: false,
        lastPrivateEventAt: null,
        privateStreamAgeMs: null,
        balanceSyncHealthy: Boolean(record.lastSnapshot),
        positionSyncHealthy: Boolean(record.lastSnapshot),
        orderSyncHealthy: Boolean(record.lastSnapshot),
        executionEndpointAvailable: true,
        reconnectCount: 0,
        lastError: record.lastError,
      },
      safety: {
        validationModeEnabled: mainnetAuthority,
        accountAllowlisted: true,
        symbolAllowlisted: record.account.riskControls.allowedSymbols.includes("*") || record.account.riskControls.allowedSymbols.includes(symbol),
        maxNotionalConfigured: Number(record.account.riskControls.maxPositionUsd) > 0,
        maxNotionalUsd: Number(record.account.riskControls.maxPositionUsd || 0),
        capacityMode: "operator-cap",
        withdrawalPermissionAbsent: !withdrawal,
        readPermissionPresent: true,
        tradePermissionPresent: tradePermission,
      },
      readiness: {
        executionReady,
        readinessReason: executionReady ? "Local durable Bybit execution is ready." : blockers.join(", "),
        blockers,
      },
      certification: {
        latestStatus: "LOCAL_RUNTIME_IMPLEMENTED_UNCERTIFIED",
        latestReadiness: executionReady ? "TECHNICALLY_READY" : "BLOCKED",
        mainnetValidated: false,
        decision: "Operator-controlled local execution; production certification requires recorded demo and small-order Mainnet evidence.",
        missingMandatory: ["SIGNED_INSTALLER_EVIDENCE", "DEMO_LIFECYCLE_EVIDENCE", "SMALL_ORDER_MAINNET_EVIDENCE"],
        failed: [],
        evidenceRows: 0,
      },
    };
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const params = new URLSearchParams({ accountId, symbol });
  const response = await fetch(`/api/exchange-accounts/bybit-runtime-status?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) throw new Error(await readApiError(response));
  return await response.json() as BybitRuntimeStatusPayload;
}

export async function submitHyperliquidOrderViaApi(draft: PortfolioOrderDraft): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) {
    void draft;
    throw new Error("The standalone Hyperliquid execution adapter has not been implemented. No cloud relay will be used implicitly.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/order", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report || data.order);
}

export async function cancelHyperliquidOrderViaApi(draft: {
  accountId: string;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
  mainnetConfirmed?: boolean;
}): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) throw new Error("Standalone Hyperliquid cancellation is not implemented.");
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/cancel", draft);
}

export async function modifyHyperliquidOrderViaApi(draft: PortfolioOrderDraft & { orderId?: string }): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) throw new Error("Standalone Hyperliquid order modification is not implemented.");
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/modify", draft);
}

export async function closeHyperliquidPositionViaApi(draft: {
  accountId: string;
  symbol: string;
  quantity?: number;
  referencePrice?: number;
  mainnetConfirmed?: boolean;
}): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) throw new Error("Standalone Hyperliquid position closing is not implemented.");
  return submitHyperliquidActionViaApi("/api/protocols/hyperliquid/close-position", draft);
}

export async function syncHyperliquidAccountViaApi(accountId: string): Promise<HyperliquidSyncPayload | null> {
  if (isLocalOnlyRuntime()) {
    void accountId;
    throw new Error("The standalone Hyperliquid account adapter has not been implemented.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch("/api/protocols/hyperliquid/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ accountId })
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return data.sync as HyperliquidSyncPayload;
}

async function submitHyperliquidActionViaApi(path: string, draft: Record<string, unknown>): Promise<OrderUpdate | null> {
  if (isLocalOnlyRuntime()) {
    void path;
    void draft;
    throw new Error("The standalone Hyperliquid execution adapter has not been implemented.");
  }
  const token = await getPortfolioApiToken();
  if (!token) return null;

  const response = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });

  if (!response.ok) throw new Error(await readApiError(response));
  const data = await response.json();
  return mapOrder(data.report);
}

async function readApiError(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;

  try {
    const data = JSON.parse(text);
    const message = data.error || data.message || response.statusText || `HTTP ${response.status}`;
    return data.code ? `[${data.code}] ${message}` : message;
  } catch {
    const diagnostic = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    return diagnostic || response.statusText || `HTTP ${response.status}`;
  }
}

function mapSnapshot(data: ApiSnapshot): PortfolioSnapshot {
  const accountById = new Map(data.accounts.map((account) => [account.id, account]));
  const fetchedAt = toMillis(data.freshness?.fetchedAt) || Date.now();
  const brokerSyncedAt = data.freshness?.brokerSyncedAt === null || data.freshness?.brokerSyncedAt === undefined
    ? null
    : toMillis(data.freshness.brokerSyncedAt);

  return {
    freshness: {
      status: data.freshness?.status ?? "degraded",
      source: data.freshness?.source ?? "broker-rest",
      fetchedAt,
      brokerSyncedAt,
      blockerCode: data.freshness?.blockerCode ?? null,
      ageMs: Math.max(0, data.freshness?.ageMs ?? (brokerSyncedAt ? fetchedAt - brokerSyncedAt : 0)),
      staleAfterMs: Math.max(5_000, data.freshness?.staleAfterMs ?? 30_000),
      quarantinedPositionCount: Math.max(0, data.freshness?.quarantinedPositionCount ?? 0),
      message: data.freshness?.message ?? "Broker snapshot freshness metadata was not supplied by the API."
    },
    summary: data.summary,
    accounts: data.accounts.map(mapAccount),
    balances: data.balances.map((balance) => ({
      accountId: balance.accountId,
      exchange: accountById.get(balance.accountId)?.exchange ?? "mock",
      asset: balance.asset,
      free: balance.free,
      locked: balance.locked,
      total: balance.total,
      usdValue: balance.usdValue ?? undefined
    })),
    positions: deduplicateCanonicalPositions(data.positions.map((position) => ({
      ...position,
      openedAt: toMillis(position.openedAt)
    }))).positions,
    orders: data.orders.map(mapOrder),
    orderSync: data.orderSync,
    curves: buildCurves(data.summary)
  };
}

function mapAccount(account: ApiAccount): PortfolioAccount {
  return {
    id: account.id,
    exchange: account.exchange,
    label: account.accountName,
    accountName: account.accountName,
    permissions: account.permissions || ["read-account", "read-orders", "read-positions"],
    isPaper: false,
    connectedAt: toMillis(account.createdAt),
    lastValidatedAt: toMillis(account.updatedAt),
    status: account.status,
    apiHealth: account.apiHealth === "unknown" ? "warning" : account.apiHealth,
    latencyMs: account.latencyMs || 0,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: 0,
    availableMargin: 0,
    buyingPower: 0,
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls: account.riskControls || defaultRiskControls
  };
}

function mapOrder(order: any): OrderUpdate {
  const createdTime = toMillis(order.created_at || order.createdTime || order.time);
  const filledQuantity = Number(order.filled_quantity ?? order.filledQuantity ?? order.cumulativeFilledQuantity ?? 0);
  const quantity = Number(order.quantity ?? 0);
  const remainingQuantity = Number(order.remainingQuantity ?? order.leavesQuantity ?? Math.max(0, quantity - filledQuantity));
  return {
    accountId: order.account_id || order.accountId,
    exchange: order.exchange,
    orderId: order.venueOrderId || order.exchange_order_id || order.orderId || order.id,
    venueOrderId: order.venueOrderId || order.exchange_order_id || order.orderId,
    clientOrderId: order.client_order_id || order.clientOrderId,
    symbol: order.symbol,
    status: order.status,
    filledQuantity,
    averageFillPrice: order.average_fill_price === null || order.average_fill_price === undefined
      ? undefined
      : Number(order.average_fill_price),
    reason: order.rejection_reason || order.reason,
    time: createdTime,
    internalId: order.internalId || order.id,
    connectionId: order.connectionId || order.account_id || order.accountId,
    network: order.network || "mainnet",
    category: order.category,
    normalizedSymbol: order.normalizedSymbol || normalizeOrderSymbol(order.symbol),
    side: order.side,
    type: order.type || order.order_type || order.orderType,
    orderType: order.orderType || order.order_type || order.type,
    price: nullableOrderNumber(order.price ?? order.limit_price),
    triggerPrice: nullableOrderNumber(order.triggerPrice ?? order.stop_price),
    quantity,
    leavesQuantity: remainingQuantity,
    remainingQuantity,
    timeInForce: String(order.timeInForce || order.time_in_force || "").toLowerCase(),
    reduceOnly: Boolean(order.reduceOnly ?? order.reduce_only),
    closeOnTrigger: Boolean(order.closeOnTrigger),
    positionIdx: Number(order.positionIdx || 0),
    source: order.source === "venue" ? "venue" : "black-terminal",
    ownership: order.ownership || (order.externallyCreated ? "external" : "black-terminal"),
    externallyCreated: Boolean(order.externallyCreated),
    createdTime,
    updatedTime: toMillis(order.updated_at || order.updatedTime || createdTime),
    venuePriceString: order.venuePriceString === undefined ? undefined : String(order.venuePriceString),
    venueUpdatedTime: toMillis(order.venueUpdatedTime || order.updated_at || order.updatedTime || createdTime),
    canonicalKey: order.canonicalKey,
    lastSource: order.lastSource || order.source,
    venueAccountId: order.venueAccountId
  };
}

function normalizeOrderSymbol(symbol: unknown) {
  return String(symbol || "").replace(/[^a-zA-Z0-9]/g, "").replace(/PERP(ETUAL)?$/i, "").toUpperCase();
}

function nullableOrderNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildCurves(summary: PortfolioSnapshot["summary"]) {
  const base = summary.totalEquity || 0;
  if (base <= 0) {
    return {
      equity: [],
      drawdown: [],
      dailyReturns: [],
      exposure: []
    };
  }

  return {
    equity: [0.97, 0.985, 0.978, 0.995, 0.99, 1].map((multiplier, index) => ({
      time: `D-${5 - index}`,
      value: base * multiplier
    })),
    drawdown: [0, 0.7, 1.2, 0.8, 1.6, summary.drawdownPct || 0].map((value, index) => ({
      time: `D-${5 - index}`,
      value
    })),
    dailyReturns: [0, 0, 0, 0, 0, summary.dailyPnl || 0].map((value, index) => ({
      time: `D-${5 - index}`,
      value
    })),
    exposure: [
      { label: "Margin", value: summary.totalEquity > 0 ? Math.round((summary.marginUsed / summary.totalEquity) * 100) : 0 },
      { label: "Cash", value: summary.totalEquity > 0 ? Math.round((summary.availableMargin / summary.totalEquity) * 100) : 0 }
    ].filter((item) => item.value > 0)
  };
}

function toMillis(value?: string | number | null) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

function recordResponseTiming(name: string, response: Response) {
  const routeMs = Number(response.headers.get("x-black-terminal-route-ms"));
  if (Number.isFinite(routeMs)) blackCorePerformanceMonitor.recordMetric(`${name}_ms`, routeMs, "ms");
}
