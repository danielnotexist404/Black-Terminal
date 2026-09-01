import crypto from "node:crypto";
import {
  calculateCapitalPreview,
  calculateEffectiveLeverage,
  assertCanArmStrategyTarget,
  assertCertifiedStrategyDefinition,
  canonicalRequestHash,
  defaultLiveCapitalPolicy,
  defaultPaperCapitalPolicy,
  normalizeCapitalPolicy,
  normalizeMarketType,
  normalizeStrategyDefinition,
  normalizeStrategyName,
  riskIncrease,
  strategyError
} from "./domain.js";
import { getBybitClosedKlines, getBybitInstrumentMetadata, getBybitTicker, validateBybitClosedKlineSnapshot } from "../exchanges/bybit.js";
import { preflightTargetExecution } from "./target-execution-preflight.js";
import { calculateFollowerAllocation } from "../cloud-execution/allocation-risk.js";

const ACTIVE_ORDER_STATUSES = ["created", "pending", "open", "working", "partially-filled", "partially_filled", "triggered"];
const ACCOUNT_EQUITY_STALE_MS = 90_000;

export async function listStrategies(supabase, userId) {
  const { data, error } = await supabase.from("strategy_automation_strategies")
    .select("id,name,runtime_kind,symbol,timeframe,market_type,exchange,current_version,published_version,running_version,draft_revision,draft_base_version,draft_updated_at,draft_definition,definition,status,created_at,updated_at")
    .eq("owner_user_id", userId).is("archived_at", null).order("updated_at", { ascending: false });
  if (error) throw persistenceError(error);
  const rows = data || [];
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [papers, bindings, runtimes, trades] = await Promise.all([
    many(supabase.from("strategy_paper_accounts").select("id,strategy_id,strategy_version,demo_equity,realized_pnl,unrealized_pnl,maximum_drawdown_percent,status").in("strategy_id", ids)),
    many(supabase.from("strategy_target_bindings").select("strategy_id,strategy_version,status").in("strategy_id", ids).neq("status", "DISCONNECTED")),
    many(supabase.from("strategy_automation_runtime_state").select("strategy_id,runtime_state,last_signal_at,last_heartbeat_at,running_version").in("strategy_id", ids)),
    many(supabase.from("strategy_automation_trades").select("strategy_id,paper_account_id").in("strategy_id", ids).eq("mode", "PAPER").limit(25_000))
  ]);
  return rows.map((row) => {
    const version = row.running_version ?? row.published_version;
    const paper = papers.find((item) => item.strategy_id === row.id && item.strategy_version === version);
    const runtime = runtimes.find((item) => item.strategy_id === row.id);
    const definition = row.draft_definition || row.definition || {};
    return {
      ...safeStrategySummary(row),
      indicatorName: definition.indicator?.name || runtimeLabel(definition.runtimeKind || row.runtime_kind),
      paperEquity: paper ? Number(paper.demo_equity || 0) + Number(paper.realized_pnl || 0) + Number(paper.unrealized_pnl || 0) : 0,
      paperPnl: paper ? Number(paper.realized_pnl || 0) + Number(paper.unrealized_pnl || 0) : 0,
      paperDrawdown: Number(paper?.maximum_drawdown_percent || 0),
      paperTrades: paper ? trades.filter((item) => item.paper_account_id === paper.id).length : 0,
      connectedTargets: bindings.filter((item) => item.strategy_id === row.id && item.strategy_version === version).length,
      runtimeState: runtime?.runtime_state || (row.running_version ? "RECOVERING" : "NOT STARTED"),
      lastSignalAt: runtime?.last_signal_at || null,
      lastHeartbeatAt: runtime?.last_heartbeat_at || null
    };
  });
}

export async function getStrategyWorkspace(supabase, userId, strategyId) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const operationalVersion = strategy.running_version ?? strategy.published_version ?? strategy.current_version;
  const [paper, bindings, runtime, audit, versions] = await Promise.all([
    oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion).eq("owner_user_id", userId).maybeSingle()),
    many(supabase.from("strategy_target_bindings").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion).eq("owner_user_id", userId).neq("status", "DISCONNECTED").order("slot_index")),
    oneOrNone(supabase.from("strategy_automation_runtime_state").select("*").eq("strategy_id", strategyId).eq("owner_user_id", userId).maybeSingle()),
    many(supabase.from("strategy_automation_audit_events").select("id,event_type,severity,message,safe_metadata,created_at,binding_id").eq("strategy_id", strategyId).eq("owner_user_id", userId).order("created_at", { ascending: false }).limit(100)),
    many(supabase.from("strategy_automation_versions").select("version,name,definition,status,created_at").eq("strategy_id", strategyId).eq("owner_user_id", userId).order("version", { ascending: false }))
  ]);
  const snapshots = await buildStrategySnapshots(supabase, userId, strategy, bindings);
  return {
    strategy: safeStrategy(strategy),
    paper: paper ? safePaperAccount(paper) : null,
    bindings: bindings.map(safeBinding),
    snapshots,
    runtime: runtime ? safeRuntime(runtime) : null,
    audit,
    versions: versions.map((item) => ({ version: item.version, name: item.name, definition: item.definition, status: item.status, createdAt: item.created_at }))
  };
}

export async function getStrategySnapshot(supabase, userId, strategyId) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const operationalVersion = strategy.running_version ?? strategy.published_version ?? strategy.current_version;
  const [paper, bindings, runtime] = await Promise.all([
    oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion).eq("owner_user_id", userId).maybeSingle()),
    many(supabase.from("strategy_target_bindings").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion).eq("owner_user_id", userId).neq("status", "DISCONNECTED").order("slot_index")),
    oneOrNone(supabase.from("strategy_automation_runtime_state").select("*").eq("strategy_id", strategyId).eq("owner_user_id", userId).maybeSingle())
  ]);
  return {
    strategyId,
    timestamp: Date.now(),
    paper: paper ? safePaperAccount(paper) : null,
    targets: await buildStrategySnapshots(supabase, userId, strategy, bindings),
    runtime: runtime ? safeRuntime(runtime) : null
  };
}

export async function getGroupExecutionDesks(supabase, userId, groupId) {
  const [group, membership] = await Promise.all([
    oneOrNone(supabase.from("investment_groups").select("id,owner_user_id,status").eq("id", groupId).maybeSingle()),
    oneOrNone(supabase.from("investment_group_members").select("id,role,status").eq("group_id", groupId).eq("user_id", userId).eq("status", "active").maybeSingle())
  ]);
  if (!group) throw strategyError(404, "INVESTMENT_GROUP_NOT_FOUND", "Investment Group not found.");
  if (group.owner_user_id !== userId && !membership) throw strategyError(403, "INVESTMENT_GROUP_DESK_FORBIDDEN", "Join this Investment Group before opening its Strategy Execution Desk.");

  const bindings = await many(supabase.from("strategy_target_bindings")
    .select("*")
    .eq("group_id", groupId)
    .eq("target_type", "INVESTMENT_GROUP")
    .neq("status", "DISCONNECTED")
    .order("updated_at", { ascending: false }));
  if (!bindings.length) return { groupId, desks: [] };
  const strategyIds = [...new Set(bindings.map((binding) => binding.strategy_id))];
  const bindingIds = bindings.map((binding) => binding.id);
  const [strategies, snapshotRows] = await Promise.all([
    many(supabase.from("strategy_automation_strategies").select("*").in("id", strategyIds).is("archived_at", null)),
    many(supabase.from("strategy_target_snapshots").select("binding_id,freshness,snapshot,captured_at").in("binding_id", bindingIds))
  ]);
  const strategyById = new Map(strategies.map((strategy) => [strategy.id, strategy]));
  const snapshotByBinding = new Map(snapshotRows.map((row) => [row.binding_id, {
    value: { ...(row.snapshot || {}), freshness: row.freshness, timestamp: Date.parse(row.captured_at) },
    capturedAt: Date.parse(row.captured_at)
  }]));
  const desks = await mapWithConcurrency(bindings.filter((binding) => strategyById.has(binding.strategy_id)), 3, async (binding) => {
    const cachedSnapshot = snapshotByBinding.get(binding.id);
    const snapshotPromise = cachedSnapshot && Date.now() - cachedSnapshot.capturedAt < 5_000
      ? Promise.resolve(cachedSnapshot.value)
      : buildGroupSnapshot(supabase, binding.owner_user_id, binding);
    const [positions, orders, executions, trades, snapshot] = await Promise.all([
      many(supabase.from("account_positions").select("id,symbol,direction,quantity,average_price,current_price,unrealized_pnl,realized_pnl,margin,leverage,liquidation_price,stop_loss,take_profit,opened_at,updated_at").eq("strategy_target_binding_id", binding.id).order("updated_at", { ascending: false }).limit(500)),
      many(supabase.from("execution_orders").select("id,exchange,symbol,side,order_type,quantity,limit_price,stop_price,take_profit,stop_loss,status,filled_quantity,estimated_fees,created_at,updated_at").eq("strategy_target_binding_id", binding.id).order("created_at", { ascending: false }).limit(500)),
      many(supabase.from("execution_fills").select("id,exchange,symbol,side,price,quantity,fee,fee_asset,liquidity,filled_at").eq("strategy_target_binding_id", binding.id).order("filled_at", { ascending: false }).limit(500)),
      many(supabase.from("strategy_automation_trades").select("id,mode,symbol,side,quantity,entry_price,exit_price,gross_pnl,fees,funding,net_pnl,entry_signal_key,exit_reason,opened_at,closed_at").eq("binding_id", binding.id).order("closed_at", { ascending: false }).limit(5000)),
      snapshotPromise
    ]);
    return {
      strategy: safeGroupDeskStrategy(strategyById.get(binding.strategy_id)),
      binding: safeBinding(binding),
      snapshot,
      data: { positions, orders, executions, trades, analytics: calculateTradeAnalytics([...trades].reverse()) }
    };
  });
  return { groupId, desks };
}

export async function createStrategyDraft(supabase, userId, body, idempotencyKey) {
  const name = normalizeStrategyName(body.name);
  const definition = normalizeStrategyDefinition(body.definition);
  const globalPolicy = normalizeGlobalPolicy(body.globalCapitalPolicy, definition.marketType);
  const canonicalHash = canonicalRequestHash({ name, definition, globalPolicy, state: "DRAFT" });
  const { data, error } = await supabase.rpc("black_core_create_strategy_draft", {
    p_owner_user_id: userId,
    p_name: name,
    p_definition: definition,
    p_global_policy: globalPolicy,
    p_canonical_hash: canonicalHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_NAME_CONFLICT", "A strategy with this name already exists.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, data.strategyId);
}

export async function saveStrategyDraft(supabase, userId, strategyId, body) {
  const name = normalizeStrategyName(body.name);
  const definition = normalizeStrategyDefinition(body.definition);
  const { error } = await supabase.rpc("black_core_save_strategy_draft", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_name: name,
    p_definition: definition,
    p_expected_revision: body.expectedRevision ?? null
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_NAME_CONFLICT", "A strategy with this name already exists.");
    if (error.code === "40001") throw strategyError(409, "STRATEGY_DRAFT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, strategyId);
}

export async function archiveStrategy(supabase, userId, strategyId, body, idempotencyKey) {
  const canonicalHash = canonicalRequestHash({
    action: "ARCHIVE_STRATEGY",
    strategyId,
    expectedName: body.expectedName,
    expectedRevision: body.expectedRevision
  });
  const { data, error } = await supabase.rpc("black_core_archive_strategy", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_expected_name: body.expectedName,
    p_expected_revision: body.expectedRevision,
    p_request_hash: canonicalHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "P0002") throw strategyError(404, "STRATEGY_NOT_FOUND", "Strategy not found.");
    if (error.code === "40001") throw strategyError(409, "STRATEGY_DELETE_CONFLICT", "This strategy changed in another session. Reload it before deleting.");
    if (error.code === "55000") throw strategyError(409, "STRATEGY_DELETE_REQUIRES_SAFE_STATE", "Pause and disconnect active targets, then wait for pending execution commands to settle before deleting this strategy.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different strategy deletion.");
    throw persistenceError(error);
  }
  return data;
}

export async function publishStrategyDraft(supabase, userId, strategyId, body) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const definition = assertCertifiedStrategyDefinition(normalizeStrategyDefinition(strategy.draft_definition || strategy.definition));
  const name = normalizeStrategyName(strategy.draft_name || strategy.name);
  const globalPolicy = normalizeGlobalPolicy(strategy.global_capital_policy, definition.marketType);
  const paperPolicy = definition.paper?.capitalPolicy
    ? normalizeCapitalPolicy(definition.paper.capitalPolicy, definition.marketType, { allowZeroAllocation: false })
    : defaultPaperCapitalPolicy(definition.marketType);
  const canonicalHash = canonicalRequestHash({ name, definition, globalPolicy, paperPolicy });
  const { error } = await supabase.rpc("black_core_publish_strategy_draft", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_expected_revision: body.expectedRevision,
    p_global_policy: globalPolicy,
    p_paper_policy: paperPolicy,
    p_canonical_hash: canonicalHash
  });
  if (error) {
    if (error.code === "40001") throw strategyError(409, "STRATEGY_DRAFT_CONFLICT", "This draft changed in another session. Reload it before publishing.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, strategyId);
}

export async function startStrategyVersion(supabase, userId, strategyId, body) {
  const { error } = await supabase.rpc("black_core_start_strategy_version", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_version: body.version
  });
  if (error) {
    if (error.code === "55000") throw strategyError(409, "STRATEGY_RUNTIME_POSITION_OPEN", "Close the current Paper position before switching the running version.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, strategyId);
}

export async function createStrategy(supabase, userId, body, idempotencyKey) {
  const name = normalizeStrategyName(body.name);
  const definition = normalizeStrategyDefinition(body.definition);
  const globalPolicy = normalizeGlobalPolicy(body.globalCapitalPolicy, definition.marketType);
  const paperPolicy = defaultPaperCapitalPolicy(definition.marketType);
  const canonicalHash = canonicalRequestHash({ name, definition, globalPolicy, paperPolicy });
  const { data, error } = await supabase.rpc("black_core_create_strategy", {
    p_owner_user_id: userId,
    p_name: name,
    p_definition: definition,
    p_global_policy: globalPolicy,
    p_paper_policy: paperPolicy,
    p_canonical_hash: canonicalHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_NAME_CONFLICT", "A strategy with this name already exists.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, data.strategyId);
}

export async function renameStrategy(supabase, userId, strategyId, body, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const name = normalizeStrategyName(body.name ?? strategy.name);
  const definition = body.definition ? normalizeStrategyDefinition(body.definition) : strategy.definition;
  if (strategy.status === "LIVE_ACTIVE") throw strategyError(409, "STRATEGY_LIVE_VERSION_LOCKED", "Pause live automation before changing its saved definition.");
  const globalPolicy = normalizeGlobalPolicy(strategy.global_capital_policy, definition.marketType);
  const paperPolicy = defaultPaperCapitalPolicy(definition.marketType);
  const canonicalHash = canonicalRequestHash({ name, definition, globalPolicy, paperPolicy });
  const { error } = await supabase.rpc("black_core_save_strategy", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_name: name,
    p_definition: definition,
    p_global_policy: globalPolicy,
    p_paper_policy: paperPolicy,
    p_canonical_hash: canonicalHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_NAME_CONFLICT", "A strategy with this name already exists.");
    if (error.code === "55000") throw strategyError(409, "STRATEGY_LIVE_VERSION_LOCKED", "Pause live automation before changing its saved definition.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different strategy save.");
    throw persistenceError(error);
  }
  return getStrategyWorkspace(supabase, userId, strategyId);
}

export async function listEligibleTargets(supabase, userId, strategyId, environment = process.env, excludeBindingId = null) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const [connections, accounts, capabilities, ownerGroups, managedMemberships] = await Promise.all([
    many(supabase.from("connectivity_connections").select("id,provider,label,status,account_id,capabilities,market_scope,connection_mode,execution_capability,health_status,last_private_event_at,last_reconciled_at,credential_state,worker_state,synchronization_state,execution_readiness,execution_environment,certification_state,control_state,revoked_at,disabled_at").eq("user_id", userId).is("revoked_at", null).is("disabled_at", null)),
    many(supabase.from("exchange_accounts").select("id,exchange,account_name,status,api_health,permissions,is_read_only,trading_enabled,network,execution_environment,permission_snapshot,last_synced_at").eq("user_id", userId)),
    many(supabase.from("broker_connection_capabilities").select("*").eq("user_id", userId)),
    many(supabase.from("investment_groups").select("id,firm_name,status").eq("owner_user_id", userId)),
    many(supabase.from("investment_group_members").select("group_id,role,status").eq("user_id", userId).eq("status", "active").in("role", ["owner", "manager"]))
  ]);
  const accountIds = accounts.length ? accounts.map((item) => item.id) : ["00000000-0000-0000-0000-000000000000"];
  const managedGroupIds = [...new Set([...ownerGroups.map((item) => item.id), ...managedMemberships.map((item) => item.group_id)])];
  const scopedGroupIds = managedGroupIds.length ? managedGroupIds : ["00000000-0000-0000-0000-000000000000"];
  const [risks, accountEquities, managedGroups, groupStats, mandates] = await Promise.all([
    many(supabase.from("account_risk_controls").select("*").in("account_id", accountIds)),
    many(supabase.from("broker_account_equity_snapshots").select("account_id,equity_usd,available_balance_usd,observed_at,captured_at").in("account_id", accountIds)),
    many(supabase.from("investment_groups").select("id,firm_name,status").in("id", scopedGroupIds)),
    many(supabase.from("investment_group_stats").select("*").in("group_id", scopedGroupIds)),
    many(supabase.from("group_execution_mandates").select("id,group_id,status,broker_connection_id,allocation_method,allocation_value,max_leverage,paused_at,expires_at").in("group_id", scopedGroupIds))
  ]);
  const accountMap = new Map(accounts.map((item) => [item.id, item]));
  const capabilityMap = new Map(capabilities.map((item) => [item.connection_id, item]));
  const riskMap = new Map(risks.map((item) => [item.account_id, item]));
  const accountEquityMap = new Map(accountEquities.map((item) => [item.account_id, item]));
  let existingQuery = supabase.from("strategy_target_bindings").select("id,target_type,target_id,status").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion(strategy)).neq("status", "DISCONNECTED");
  if (excludeBindingId) existingQuery = existingQuery.neq("id", excludeBindingId);
  const existing = await many(existingQuery);
  const conflicts = new Set(existing.map((item) => `${item.target_type}:${item.target_id}`));
  const brokerAccounts = connections.filter((item) => item.account_id).map((connection) => {
    const account = accountMap.get(connection.account_id);
    const capability = capabilityMap.get(connection.id);
    const risk = riskMap.get(connection.account_id);
    const amounts = authoritativeAccountMoney(accountEquityMap.get(connection.account_id));
    const validation = validateBrokerEligibility({ connection, account, capability, strategy, conflict: conflicts.has(`BROKER_ACCOUNT:${connection.id}`), environment });
    if (strategy.runtime_kind === "python-script" && strategy.market_type !== "FUTURES") {
      validation.reasons.push("Black Script v3 direct-broker automation is currently certified for futures targets only.");
      validation.eligible = false;
    }
    return {
      targetId: connection.id,
      accountId: connection.account_id,
      targetType: "BROKER_ACCOUNT",
      provider: String(connection.provider || account?.exchange || "broker").toUpperCase(),
      label: connection.label || account?.account_name || "Broker Account",
      environment: connection.execution_environment || account?.execution_environment || "UNKNOWN",
      marketCapabilities: capability?.supported_market_types || connection.market_scope || [],
      equity: amounts.equity,
      availableBalance: amounts.available,
      connectionHealth: connection.health_status || connection.status,
      privateStreamHealth: connection.worker_state,
      reconciliationStatus: connection.synchronization_state,
      maximumLeverage: Number(risk?.max_leverage || 1),
      validation
    };
  });
  const managedIds = new Set(managedGroupIds);
  const groups = managedGroups.filter((group) => managedIds.has(group.id)).map((group) => {
    const stats = groupStats.find((item) => item.group_id === group.id) || {};
    const groupMandates = mandates.filter((item) => item.group_id === group.id);
    const activeMandates = groupMandates.filter((item) => item.status === "ACTIVE" && (!item.expires_at || Date.parse(item.expires_at) > Date.now()));
    const validation = validateGroupEligibility({ group, activeMandates, conflict: conflicts.has(`INVESTMENT_GROUP:${group.id}`), environment });
    if (strategy.runtime_kind === "python-script") {
      validation.reasons.push("Black Script v3 Investment Group fanout remains fail-closed until per-follower resting-order reconciliation is certified.");
      validation.eligible = false;
    }
    return {
      targetId: group.id,
      targetType: "INVESTMENT_GROUP",
      label: group.firm_name,
      activeAuthorizedMembers: activeMandates.length,
      connectedAllocatedEquity: Number(stats.connected_equity || 0),
      copyTradingReadiness: environment.INVESTMENT_GROUP_EXECUTION_ENABLED === "true" ? "ENABLED" : "DISABLED",
      blackCloudReadiness: activeMandates.length > 0 ? "READY" : "UNAVAILABLE",
      riskState: group.status === "active" ? "NORMAL" : "SUSPENDED",
      pausedMembers: groupMandates.filter((item) => item.status === "PAUSED").length,
      degradedMembers: 0,
      validation
    };
  });
  return { strategyId, brokerAccounts, groups };
}

export async function addTarget(supabase, userId, strategyId, body, idempotencyKey, environment = process.env) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const eligible = await listEligibleTargets(supabase, userId, strategyId, environment);
  const collection = body.targetType === "INVESTMENT_GROUP" ? eligible.groups : eligible.brokerAccounts;
  const candidate = collection.find((item) => item.targetId === body.targetId);
  if (!candidate) throw strategyError(404, "STRATEGY_TARGET_NOT_FOUND", "The selected strategy target is unavailable.");
  if (!candidate.validation.eligible) throw strategyError(409, "STRATEGY_TARGET_VALIDATION_FAILED", "The selected strategy target failed validation.", { reasons: candidate.validation.reasons });
  const marketType = normalizeMarketType(body.marketType || strategy.market_type);
  const policy = body.capitalPolicy
    ? normalizeCapitalPolicy(body.capitalPolicy, marketType, { allowZeroAllocation: candidate.environment !== "DEMO" })
    : candidate.environment === "DEMO"
      ? defaultPaperCapitalPolicy(marketType)
      : defaultLiveCapitalPolicy(marketType);
  const canonicalHash = canonicalRequestHash(policy);
  const version = operationalVersion(strategy);
  const requestHash = canonicalRequestHash({ strategyId, strategyVersion: version, slotIndex: Number(body.slotIndex), targetType: body.targetType, targetId: body.targetId, marketType, policy });
  const isBroker = body.targetType === "BROKER_ACCOUNT";
  const connection = isBroker ? await oneOrNone(supabase.from("connectivity_connections").select("id,account_id").eq("id", body.targetId).eq("user_id", userId).maybeSingle()) : null;
  const { data, error } = await supabase.rpc("black_core_add_strategy_target", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_strategy_version: version,
    p_slot_index: Number(body.slotIndex),
    p_target_type: body.targetType,
    p_target_id: body.targetId,
    p_connection_id: isBroker ? body.targetId : null,
    p_account_id: isBroker ? connection?.account_id : null,
    p_group_id: isBroker ? null : body.targetId,
    p_market_type: marketType,
    p_policy: policy,
    p_validation: { ...candidate.validation, targetLabel: candidate.label, targetProvider: candidate.provider || null, targetEnvironment: candidate.environment || (body.targetType === "INVESTMENT_GROUP" ? "INVESTMENT_GROUP" : null) },
    p_canonical_hash: canonicalHash,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_TARGET_CONFLICT", "The slot or target is already occupied.");
    if (error.code === "23514") throw strategyError(409, "STRATEGY_TARGET_CAPACITY_REACHED", "All nine live target slots are occupied.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different target mutation.");
    throw persistenceError(error);
  }
  return getBinding(supabase, userId, strategyId, data.bindingId);
}

export async function reorderTargets(supabase, userId, strategyId, body, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const assignments = body.assignments.map((item) => ({ bindingId: item.bindingId, slotIndex: Number(item.slotIndex), expectedVersion: Number(item.expectedVersion) }));
  const version = operationalVersion(strategy);
  const requestHash = canonicalRequestHash({ strategyId, strategyVersion: version, assignments });
  const { error } = await supabase.rpc("black_core_reorder_strategy_targets", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_strategy_version: version,
    p_assignments: assignments,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "40001") throw strategyError(409, "STRATEGY_TARGET_VERSION_CONFLICT", "Target slots changed elsewhere. Refresh and try again.");
    if (error.code === "23505") throw strategyError(409, "STRATEGY_TARGET_SLOT_CONFLICT", "A requested target slot is occupied.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different target mutation.");
    throw persistenceError(error);
  }
  const workspace = await getStrategyWorkspace(supabase, userId, strategyId);
  return { bindings: workspace.bindings, snapshots: workspace.snapshots };
}

export async function updateTargetPolicy(supabase, userId, strategyId, bindingId, body, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const binding = await ownedBinding(supabase, userId, strategyId, bindingId);
  const nextPolicy = normalizeCapitalPolicy(body.capitalPolicy, binding.market_type, { allowZeroAllocation: true });
  const canonicalPolicyHash = canonicalRequestHash(nextPolicy);
  assertPolicyWithinGlobal(nextPolicy, strategy.global_capital_policy, binding.market_type);
  if (binding.target_type === "BROKER_ACCOUNT" && nextPolicy.tradeAmountMode === "FIXED_USDT") {
    const snapshot = await buildBindingSnapshot(supabase, userId, binding);
    const currentLimit = Math.max(0, Math.min(Number(snapshot.equity || 0), Number(snapshot.availableBalance || 0)));
    if (nextPolicy.tradeAmountValue > currentLimit + 1e-8) {
      throw strategyError(400, "STRATEGY_TRADE_AMOUNT_EXCEEDS_AVAILABLE_FUNDS", "The fixed per-trade amount exceeds the broker account's current available funds.", { requested: nextPolicy.tradeAmountValue, available: currentLimit, equity: snapshot.equity });
    }
  }
  let liveValidation = null;
  if (binding.status === "LIVE") {
    const armability = await validateArmableBinding(supabase, userId, strategyId, binding, process.env, nextPolicy);
    liveValidation = {
      ...armability.validation,
      policyCanonicalHash: canonicalPolicyHash,
      validatedAt: new Date().toISOString()
    };
    assertExecutionPreflight(liveValidation);
    assertCanArmStrategyTarget({
      policy: nextPolicy,
      marketType: binding.market_type,
      validation: liveValidation,
      executionEnvironment: armability.executionEnvironment,
      environment: process.env,
      operation: "remain-live"
    });
  }
  const increased = riskIncrease(policyFromBinding(binding), nextPolicy, binding.market_type);
  const requestHash = canonicalRequestHash({ action: "UPDATE_POLICY", expectedVersion: Number(body.expectedVersion), policy: nextPolicy });
  const { error } = await supabase.rpc("black_core_update_strategy_target_policy_v2", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_binding_id: bindingId,
    p_expected_row_version: Number(body.expectedVersion),
    p_policy: nextPolicy,
    p_canonical_hash: canonicalPolicyHash,
    p_risk_increased: increased,
    p_validation_snapshot: liveValidation || {},
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "40001") throw strategyError(409, "STRATEGY_TARGET_VERSION_CONFLICT", "Target settings changed elsewhere. Refresh and try again.");
    if (error.code === "55000") throw strategyError(409, "STRATEGY_TARGET_LIVE_REVALIDATION_REQUIRED", "The new policy was not saved because the live target could not be revalidated. Its previous policy and live state were preserved.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different target mutation.");
    throw persistenceError(error);
  }
  return getBinding(supabase, userId, strategyId, bindingId);
}

export async function updateGlobalCapitalPolicy(supabase, userId, strategyId, body, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  if (Number(strategy.draft_revision || 0) !== Number(body.expectedRevision)) throw strategyError(409, "STRATEGY_DRAFT_CONFLICT", "This strategy changed elsewhere. Refresh it before updating execution limits.");
  const policy = normalizeGlobalPolicy(body.capitalPolicy, strategy.market_type);
  const requestHash = canonicalRequestHash({ action: "UPDATE_GLOBAL_POLICY", expectedRevision: body.expectedRevision, policy });
  const { data: prior, error: priorError } = await supabase.from("strategy_automation_audit_events").select("id,safe_metadata").eq("strategy_id", strategyId).eq("owner_user_id", userId).eq("event_type", "STRATEGY_GLOBAL_POLICY_UPDATED").contains("safe_metadata", { idempotencyKey }).maybeSingle();
  if (priorError) throw persistenceError(priorError);
  if (!prior) {
    const { data, error } = await supabase.from("strategy_automation_strategies").update({ global_capital_policy: policy, updated_at: new Date().toISOString() }).eq("id", strategyId).eq("owner_user_id", userId).eq("draft_revision", body.expectedRevision).select("id").maybeSingle();
    if (error) throw persistenceError(error);
    if (!data) throw strategyError(409, "STRATEGY_DRAFT_CONFLICT", "This strategy changed elsewhere. Refresh it before updating execution limits.");
    const { error: auditError } = await supabase.from("strategy_automation_audit_events").insert({ owner_user_id: userId, strategy_id: strategyId, event_type: "STRATEGY_GLOBAL_POLICY_UPDATED", severity: "WARNING", message: "The owner explicitly updated global Strategy Lab execution ceilings from the Execution Desk.", safe_metadata: { idempotencyKey, requestHash, maximumLeverage: policy.maximumLeverage, maximumPositions: policy.maximumPositions } });
    if (auditError) throw persistenceError(auditError);
  }
  return getStrategyWorkspace(supabase, userId, strategyId);
}

export async function setTargetState(supabase, userId, strategyId, bindingId, action, expectedVersion, idempotencyKey, environment = process.env) {
  const binding = await ownedBinding(supabase, userId, strategyId, bindingId);
  let validation = {};
  if (action === "arm") {
    if (Number(expectedVersion) === Number(binding.row_version)) {
      if (binding.status !== "READY") throw strategyError(409, "STRATEGY_TARGET_STATE_CONFLICT", "Only a ready target can be activated.");
      const armability = await validateArmableBinding(supabase, userId, strategyId, binding, environment);
      validation = armability.validation;
      assertExecutionPreflight(validation);
      assertCanArmStrategyTarget({
        policy: policyFromBinding(binding),
        marketType: binding.market_type,
        validation,
        executionEnvironment: armability.executionEnvironment,
        environment
      });
    }
  } else if (action === "resume") {
    if (Number(expectedVersion) === Number(binding.row_version)) {
      if (binding.status !== "PAUSED") throw strategyError(409, "STRATEGY_TARGET_STATE_CONFLICT", "Only a paused target can be resumed.");
      const armability = await validateArmableBinding(supabase, userId, strategyId, binding, environment);
      validation = armability.validation;
      assertExecutionPreflight(validation);
      assertCanArmStrategyTarget({
        policy: policyFromBinding(binding),
        marketType: binding.market_type,
        validation,
        executionEnvironment: armability.executionEnvironment,
        environment
      });
    }
  } else if (action !== "pause") {
    throw strategyError(400, "STRATEGY_TARGET_ACTION_INVALID", "Unsupported target action.");
  }
  const normalizedAction = action.toUpperCase();
  await controlTarget(supabase, userId, strategyId, bindingId, expectedVersion, normalizedAction, validation, null, idempotencyKey);
  return getBinding(supabase, userId, strategyId, bindingId);
}

export async function disconnectTarget(supabase, userId, strategyId, bindingId, expectedVersion, policy = "DETACH_MANUAL", idempotencyKey) {
  const binding = await ownedBindingAny(supabase, userId, strategyId, bindingId);
  const normalizedPolicy = String(policy || "DETACH_MANUAL").toUpperCase();
  if (!["DETACH_MANUAL", "CLOSE_STRATEGY_POSITIONS", "KEEP_PROTECTED", "DISCONNECT_WHEN_FLAT"].includes(normalizedPolicy)) throw strategyError(400, "STRATEGY_DISCONNECT_POLICY_INVALID", "Unsupported disconnect policy.");
  if (Number(expectedVersion) === Number(binding.row_version) && binding.status !== "DISCONNECTED") {
    const positions = await many(supabase.from("account_positions").select("id").eq("strategy_target_binding_id", bindingId));
    if (normalizedPolicy === "DISCONNECT_WHEN_FLAT" && positions.length) throw strategyError(409, "STRATEGY_TARGET_NOT_FLAT", "The target still has strategy-owned positions.");
    if (["CLOSE_STRATEGY_POSITIONS", "KEEP_PROTECTED"].includes(normalizedPolicy) && positions.length) {
      throw strategyError(409, "STRATEGY_DISCONNECT_EXECUTION_REQUIRED", "This disconnect policy requires a separately authorized live position action. No order was submitted.");
    }
  }
  await controlTarget(supabase, userId, strategyId, bindingId, expectedVersion, "DISCONNECT", {}, normalizedPolicy, idempotencyKey);
  return safeBinding(await ownedBindingAny(supabase, userId, strategyId, bindingId));
}

export async function configurePaper(supabase, userId, strategyId, body, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const paper = await oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion(strategy)).eq("owner_user_id", userId).maybeSingle());
  if (!paper) throw strategyError(404, "STRATEGY_PAPER_NOT_FOUND", "The paper target is unavailable.");
  const policy = normalizeCapitalPolicy(body.capitalPolicy, paper.market_type, { allowZeroAllocation: false });
  const requestHash = canonicalRequestHash({ action: "CONFIGURE", expectedVersion: body.expectedVersion, policy });
  const { error } = await supabase.rpc("black_core_configure_paper_policy", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_paper_account_id: paper.id,
    p_expected_state_version: Number(body.expectedVersion),
    p_policy: policy,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) throw paperMutationError(error);
  const updated = await oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("id", paper.id).eq("owner_user_id", userId).maybeSingle());
  return safePaperAccount(updated);
}

export async function controlPaper(supabase, userId, strategyId, action, body = {}, idempotencyKey) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const paper = await oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion(strategy)).eq("owner_user_id", userId).maybeSingle());
  if (!paper) throw strategyError(404, "STRATEGY_PAPER_NOT_FOUND", "The paper target is unavailable.");
  if (!["start", "pause", "top-up", "reset"].includes(action)) throw strategyError(400, "PAPER_ACTION_INVALID", "Unsupported paper target action.");
  const amount = action === "top-up" ? Number(body.amount) : action === "reset" ? Number(body.demoEquity || 10_000) : null;
  const expectedVersion = Number(body.expectedVersion);
  const normalizedAction = action.toUpperCase().replace("-", "_");
  const requestHash = canonicalRequestHash({ action: normalizedAction, expectedVersion, amount });
  const { error } = await supabase.rpc("black_core_control_paper_target", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_paper_account_id: paper.id,
    p_expected_state_version: expectedVersion,
    p_action: normalizedAction,
    p_amount: amount,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) throw paperMutationError(error);
  const updated = await oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("id", paper.id).eq("owner_user_id", userId).maybeSingle());
  return safePaperAccount(updated);
}

export async function getBindingData(supabase, userId, strategyId, bindingId, resource) {
  const binding = await ownedBinding(supabase, userId, strategyId, bindingId);
  if (resource === "snapshot") return buildBindingSnapshot(supabase, userId, binding);
  if (resource === "members") {
    if (binding.target_type !== "INVESTMENT_GROUP") throw strategyError(404, "STRATEGY_TARGET_RESOURCE_NOT_FOUND", "Members are available only for an Investment Group target.");
    return many(supabase.from("group_execution_mandates").select("id,status,execution_mode,allocation_method,allocation_value,max_order_notional,max_total_exposure,max_daily_loss,max_drawdown,max_leverage,allowed_symbols,allowed_market_types,protective_orders_required,slippage_limit_bps,mandate_version,expires_at,paused_at,updated_at").eq("group_id", binding.group_id).order("updated_at", { ascending: false }).limit(1000));
  }
  if (resource === "positions") return many(supabase.from("account_positions").select("id,symbol,direction,quantity,average_price,current_price,unrealized_pnl,realized_pnl,margin,leverage,liquidation_price,stop_loss,take_profit,opened_at,updated_at").eq("strategy_target_binding_id", bindingId).order("updated_at", { ascending: false }));
  if (resource === "orders") return many(supabase.from("execution_orders").select("id,exchange,symbol,side,order_type,quantity,limit_price,stop_price,take_profit,stop_loss,status,filled_quantity,estimated_fees,created_at,updated_at").eq("strategy_target_binding_id", bindingId).order("created_at", { ascending: false }).limit(500));
  if (resource === "executions") return many(supabase.from("execution_fills").select("id,exchange,symbol,side,price,quantity,fee,fee_asset,liquidity,filled_at").eq("strategy_target_binding_id", bindingId).order("filled_at", { ascending: false }).limit(500));
  if (resource === "trades") return many(supabase.from("strategy_automation_trades").select("*").eq("binding_id", bindingId).eq("owner_user_id", userId).order("closed_at", { ascending: false }).limit(500));
  if (resource === "analytics") return calculateTradeAnalytics(await many(supabase.from("strategy_automation_trades").select("gross_pnl,net_pnl,fees,funding,closed_at").eq("binding_id", bindingId).eq("owner_user_id", userId).order("closed_at", { ascending: true }).limit(5000)));
  if (resource === "risk") {
    const policy = policyFromBinding(binding);
    const snapshot = await buildBindingSnapshot(supabase, userId, binding);
    return {
      status: binding.status,
      freshness: snapshot.freshness,
      capitalPolicyVersion: binding.capital_policy_version,
      strategyAllocation: policy.strategyAllocationValue,
      perTradeAmount: policy.tradeAmountValue,
      requestedLeverage: policy.requestedLeverage,
      effectiveLeverage: snapshot.effectiveLeverage,
      maximumPositionPercent: policy.maximumPositionPercent,
      maximumExposurePercent: policy.maximumExposurePercent,
      maximumDailyLoss: policy.maximumDailyLoss,
      maximumDrawdown: policy.maximumDrawdown,
      exposureUsed: snapshot.usedStrategyCapital,
      drawdownUsed: snapshot.currentDrawdownPercent,
      protectionStatus: snapshot.protectionHealth,
      validationEligible: binding.validation_snapshot?.eligible === true,
      validationReasons: binding.validation_snapshot?.reasons || []
    };
  }
  if (resource === "logs") return many(supabase.from("strategy_automation_audit_events").select("id,event_type,severity,message,safe_metadata,created_at").eq("binding_id", bindingId).eq("owner_user_id", userId).order("created_at", { ascending: false }).limit(250));
  throw strategyError(404, "STRATEGY_TARGET_RESOURCE_NOT_FOUND", "Target resource not found.");
}

export async function getPaperData(supabase, userId, strategyId) {
  const strategy = await ownedStrategy(supabase, userId, strategyId);
  const paper = await oneOrNone(supabase.from("strategy_paper_accounts").select("*").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion(strategy)).eq("owner_user_id", userId).maybeSingle());
  if (!paper) throw strategyError(404, "STRATEGY_PAPER_NOT_FOUND", "The paper target is unavailable.");
  const [positions, orders, executions, trades] = await Promise.all([
    many(supabase.from("strategy_paper_positions").select("*").eq("paper_account_id", paper.id).is("closed_at", null).order("updated_at", { ascending: false })),
    many(supabase.from("strategy_paper_orders").select("*").eq("paper_account_id", paper.id).order("created_at", { ascending: false }).limit(500)),
    many(supabase.from("strategy_automation_executions").select("*").eq("paper_account_id", paper.id).eq("mode", "PAPER").order("executed_at", { ascending: false }).limit(500)),
    many(supabase.from("strategy_automation_trades").select("*").eq("paper_account_id", paper.id).eq("mode", "PAPER").order("closed_at", { ascending: false }).limit(5000))
  ]);
  return { paper: safePaperAccount(paper), positions, orders, executions, trades, analytics: calculateTradeAnalytics([...trades].reverse()) };
}

export async function getBinding(supabase, userId, strategyId, bindingId) {
  return safeBinding(await ownedBinding(supabase, userId, strategyId, bindingId));
}

async function buildStrategySnapshots(supabase, userId, strategy, bindings) {
  return mapWithConcurrency(bindings, 3, (binding) => buildBindingSnapshot(supabase, userId, binding));
}

async function buildBindingSnapshot(supabase, userId, binding) {
  if (binding.target_type === "INVESTMENT_GROUP") return buildGroupSnapshot(supabase, userId, binding);
  const [accountEquity, positions, orders, trades, risk, health, commandHistory] = await Promise.all([
    oneOrNone(supabase.from("broker_account_equity_snapshots").select("equity_usd,available_balance_usd,observed_at,captured_at").eq("account_id", binding.account_id).eq("user_id", userId).maybeSingle()),
    many(supabase.from("account_positions").select("unrealized_pnl,realized_pnl,margin,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("execution_orders").select("status,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("strategy_automation_trades").select("gross_pnl,net_pnl,fees,funding,closed_at").eq("binding_id", binding.id).eq("owner_user_id", userId).order("closed_at", { ascending: true }).limit(5000)),
    oneOrNone(supabase.from("account_risk_controls").select("max_leverage,max_daily_loss_usd,max_portfolio_exposure_usd,emergency_stop").eq("account_id", binding.account_id).maybeSingle()),
    oneOrNone(supabase.from("broker_connection_health").select("health_status,private_stream_status,reconciliation_status,last_private_event_at,last_reconciled_at,stale_after,captured_at").eq("connection_id", binding.connection_id).order("captured_at", { ascending: false }).limit(1).maybeSingle()),
    bindingExecutionCommandHistory(supabase, userId, binding.id)
  ]);
  const money = authoritativeAccountMoney(accountEquity);
  const policy = policyFromBinding(binding);
  const effectiveLeverage = binding.market_type === "SPOT" ? 1 : calculateEffectiveLeverage({ requested: policy.requestedLeverage, targetMaximum: policy.maximumLeverage, accountRiskCap: risk?.max_leverage });
  const capital = calculateCapitalPreview({ equity: money.equity, availableBalance: money.available, policy, marketType: binding.market_type, caps: { accountRiskCap: risk?.max_leverage } });
  const analytics = calculateTradeAnalytics(trades);
  const unrealized = positions.reduce((sum, item) => sum + Number(item.unrealized_pnl || 0), 0);
  const connectionFreshness = resolveFreshness(health?.stale_after, health?.health_status, health?.reconciliation_status, health?.last_reconciled_at);
  const equityFreshness = resolveAccountEquityFreshness(accountEquity);
  const freshness = mergeFreshness(connectionFreshness, equityFreshness);
  const latestExecution = latestBindingExecutionTelemetry(commandHistory, binding);
  const snapshot = {
    bindingId: binding.id,
    slotIndex: binding.slot_index,
    timestamp: money.timestamp,
    freshness,
    equity: money.equity,
    availableBalance: money.available,
    allocatedStrategyCapital: capital.allocatedStrategyCapital,
    usedStrategyCapital: positions.reduce((sum, item) => sum + Number(item.margin || 0), 0),
    freeStrategyCapital: Math.max(0, capital.allocatedStrategyCapital - positions.reduce((sum, item) => sum + Number(item.margin || 0), 0)),
    requestedLeverage: policy.requestedLeverage,
    effectiveLeverage,
    openPositions: positions.length,
    openOrders: orders.filter((item) => ACTIVE_ORDER_STATUSES.includes(String(item.status).toLowerCase())).length,
    walletBalance: money.equity,
    marginUsed: positions.reduce((sum, item) => sum + Number(item.margin || 0), 0),
    marginUtilization: money.equity > 0 ? positions.reduce((sum, item) => sum + Number(item.margin || 0), 0) / money.equity * 100 : 0,
    realizedPnl: analytics.grossPnl,
    unrealizedPnl: unrealized,
    grossPnl: analytics.grossPnl + unrealized,
    fees: analytics.fees,
    funding: analytics.funding,
    netPnl: analytics.netPnl + unrealized,
    returnPercent: capital.allocatedStrategyCapital > 0 ? (analytics.netPnl + unrealized) / capital.allocatedStrategyCapital * 100 : 0,
    currentDrawdownPercent: analytics.currentDrawdownPercent,
    maximumDrawdownPercent: analytics.maximumDrawdownPercent,
    winRate: analytics.winRate,
    profitFactor: analytics.profitFactor,
    tradeCount: analytics.tradeCount,
    sharpe: analytics.sharpe,
    sortino: analytics.sortino,
    calmar: analytics.calmar,
    strategyState: binding.status,
    connectionHealth: health?.health_status || "UNAVAILABLE",
    protectionHealth: risk?.emergency_stop ? "EMERGENCY_STOP" : "MONITORED",
    ...latestExecution
  };
  await persistSnapshot(supabase, userId, binding, snapshot, freshness);
  return snapshot;
}

async function buildGroupSnapshot(supabase, userId, binding) {
  const [mandates, positions, orders, trades] = await Promise.all([
    many(supabase.from("group_execution_mandates").select("id,follower_user_id,broker_connection_id,status,allocation_method,allocation_value,max_leverage,paused_at,expires_at").eq("group_id", binding.group_id)),
    many(supabase.from("account_positions").select("unrealized_pnl,realized_pnl,margin,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("execution_orders").select("status,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("strategy_automation_trades").select("gross_pnl,net_pnl,fees,funding,closed_at").eq("binding_id", binding.id).eq("owner_user_id", userId).order("closed_at", { ascending: true }).limit(5000))
  ]);
  const active = mandates.filter((item) => item.status === "ACTIVE" && (!item.expires_at || Date.parse(item.expires_at) > Date.now()));
  const connectionIds = active.map((item) => item.broker_connection_id);
  const connections = connectionIds.length ? await many(supabase.from("connectivity_connections").select("id,account_id,worker_state,synchronization_state,execution_readiness,health_status").in("id", connectionIds)) : [];
  const accountIds = connections.map((item) => item.account_id).filter(Boolean);
  const accountEquities = accountIds.length ? await many(supabase.from("broker_account_equity_snapshots").select("account_id,equity_usd,available_balance_usd,observed_at,captured_at").in("account_id", accountIds)) : [];
  const moneyByAccount = new Map(accountIds.map((accountId) => [accountId, authoritativeAccountMoney(accountEquities.find((item) => item.account_id === accountId))]));
  const connectionMap = new Map(connections.map((item) => [item.id, item]));
  let connectedAllocatedEquity = 0;
  const leverageCaps = [];
  const sourceTimestamps = [];
  const accountFreshness = [];
  for (const mandate of active) {
    const connection = connectionMap.get(mandate.broker_connection_id);
    const money = moneyByAccount.get(connection?.account_id) || { equity: 0 };
    connectedAllocatedEquity += mandate.allocation_method === "FIXED_NOTIONAL" ? Math.min(money.equity, Number(mandate.allocation_value)) : money.equity * Number(mandate.allocation_value) / 100;
    leverageCaps.push(Number(mandate.max_leverage || 1));
    if (Number.isFinite(money.timestamp)) sourceTimestamps.push(money.timestamp);
    accountFreshness.push(resolveAccountEquityFreshness(accountEquities.find((item) => item.account_id === connection?.account_id)));
  }
  const degraded = connections.filter((item) => item.worker_state !== "LIVE" || item.synchronization_state !== "SYNCHRONIZED" || item.execution_readiness !== "READY").length;
  const groupConnectionFreshness = active.length && degraded === 0 ? "LIVE" : active.length ? "DEGRADED" : "UNAVAILABLE";
  const freshness = accountFreshness.reduce((current, item) => mergeFreshness(current, item), groupConnectionFreshness);
  const policy = policyFromBinding(binding);
  const analytics = calculateTradeAnalytics(trades);
  const unrealized = positions.reduce((sum, item) => sum + Number(item.unrealized_pnl || 0), 0);
  const usedStrategyCapital = positions.reduce((sum, item) => sum + Number(item.margin || 0), 0);
  const allocatedStrategyCapital = policy.strategyAllocationMode === "FIXED_USDT" ? Math.min(connectedAllocatedEquity, policy.strategyAllocationValue) : connectedAllocatedEquity * policy.strategyAllocationValue / 100;
  const snapshot = {
    bindingId: binding.id,
    slotIndex: binding.slot_index,
    timestamp: sourceTimestamps.length ? Math.min(...sourceTimestamps) : null,
    freshness,
    equity: connectedAllocatedEquity,
    availableBalance: connectedAllocatedEquity,
    allocatedStrategyCapital,
    usedStrategyCapital,
    freeStrategyCapital: Math.max(0, allocatedStrategyCapital - usedStrategyCapital),
    requestedLeverage: policy.requestedLeverage,
    effectiveLeverage: binding.market_type === "SPOT" ? 1 : calculateEffectiveLeverage({ requested: policy.requestedLeverage, targetMaximum: policy.maximumLeverage, groupMandateCap: leverageCaps.length ? Math.min(...leverageCaps) : 1 }),
    effectiveLeverageRange: leverageCaps.length ? [Math.min(...leverageCaps), Math.min(policy.requestedLeverage || 1, Math.max(...leverageCaps))] : [1, 1],
    members: mandates.length,
    eligibleMembers: active.length,
    pausedMembers: mandates.filter((item) => item.status === "PAUSED").length,
    degradedMembers: degraded,
    openPositions: positions.length,
    openOrders: orders.filter((item) => ACTIVE_ORDER_STATUSES.includes(String(item.status).toLowerCase())).length,
    walletBalance: connectedAllocatedEquity,
    marginUsed: usedStrategyCapital,
    marginUtilization: connectedAllocatedEquity > 0 ? usedStrategyCapital / connectedAllocatedEquity * 100 : 0,
    realizedPnl: analytics.grossPnl,
    unrealizedPnl: unrealized,
    grossPnl: analytics.grossPnl + unrealized,
    fees: analytics.fees,
    funding: analytics.funding,
    netPnl: analytics.netPnl + unrealized,
    returnPercent: allocatedStrategyCapital > 0 ? (analytics.netPnl + unrealized) / allocatedStrategyCapital * 100 : 0,
    currentDrawdownPercent: analytics.currentDrawdownPercent,
    maximumDrawdownPercent: analytics.maximumDrawdownPercent,
    winRate: analytics.winRate,
    profitFactor: analytics.profitFactor,
    tradeCount: analytics.tradeCount,
    sharpe: analytics.sharpe,
    sortino: analytics.sortino,
    calmar: analytics.calmar,
    strategyState: binding.status,
    connectionHealth: active.length ? (degraded ? "DEGRADED" : "LIVE") : "UNAVAILABLE",
    protectionHealth: active.length ? "MANDATE_BOUNDED" : "UNAVAILABLE",
    groupExecutionPreflight: binding.validation_snapshot?.executionPreflight?.targetType === "INVESTMENT_GROUP"
      ? binding.validation_snapshot.executionPreflight
      : null,
    followerPreflightFailures: Array.isArray(binding.validation_snapshot?.executionPreflight?.followers)
      ? binding.validation_snapshot.executionPreflight.followers
        .filter((report) => report?.ok === false)
        .map((report) => ({ mandateId: report.mandateId, connectionId: report.connectionId, reasons: report.reasons || [] }))
      : []
  };
  await persistSnapshot(supabase, userId, binding, snapshot, freshness);
  return snapshot;
}

async function bindingExecutionCommandHistory(supabase, userId, bindingId) {
  const columns = "id,command_type,status,last_error_code,last_error_message,execution_order_id,strategy_signal_key,payload,created_at,updated_at";
  const [placeOrders, terminalFailures] = await Promise.all([
    many(supabase.from("execution_commands").select(columns).eq("strategy_target_binding_id", bindingId).eq("user_id", userId).eq("command_type", "PLACE_ORDER").order("created_at", { ascending: false }).limit(50)),
    many(supabase.from("execution_commands").select(columns).eq("strategy_target_binding_id", bindingId).eq("user_id", userId).in("status", ["FAILED", "REJECTED", "DEAD_LETTER", "CANCELLED"]).order("updated_at", { ascending: false }).limit(50))
  ]);
  return [...new Map([...placeOrders, ...terminalFailures].map((command) => [command.id, command])).values()];
}

async function persistSnapshot(supabase, userId, binding, snapshot, freshness) {
  const { error } = await supabase.from("strategy_target_snapshots").upsert({ binding_id: binding.id, strategy_id: binding.strategy_id, owner_user_id: userId, freshness, snapshot, captured_at: new Date().toISOString() }, { onConflict: "binding_id" });
  if (error) throw persistenceError(error);
}

async function validateExistingBinding(supabase, userId, strategyId, binding, environment) {
  const eligible = await listEligibleTargets(supabase, userId, strategyId, environment, binding.id);
  const list = binding.target_type === "BROKER_ACCOUNT" ? eligible.brokerAccounts : eligible.groups;
  const candidate = list.find((item) => item.targetId === binding.target_id);
  return candidate?.validation || { eligible: false, reasons: ["Target is no longer available."] };
}

async function validateArmableBinding(supabase, userId, strategyId, binding, environment, policyOverride = null) {
  const validation = await validateExistingBinding(supabase, userId, strategyId, binding, environment);
  if (validation.eligible && binding.market_type === "SPOT") {
    const version = await oneOrNone(supabase.from("strategy_automation_versions")
      .select("definition")
      .eq("strategy_id", strategyId)
      .eq("owner_user_id", userId)
      .eq("version", binding.strategy_version)
      .maybeSingle());
    if (!version?.definition) {
      return {
        validation: { ...validation, eligible: false, reasons: [...(validation.reasons || []), "The immutable running strategy version is unavailable for Spot protection validation."] },
        executionEnvironment: binding.target_type === "INVESTMENT_GROUP" ? "INVESTMENT_GROUP" : null
      };
    }
    if (strategyTakeProfitPercentages(version.definition).length) {
      return {
        validation: {
          ...validation,
          eligible: false,
          reasons: [...(validation.reasons || []), "Spot automation with strategy take-profits is blocked until balance-owned partial exits and a certified fail-safe close are available."]
        },
        executionEnvironment: binding.target_type === "INVESTMENT_GROUP" ? "INVESTMENT_GROUP" : null
      };
    }
  }
  if (binding.target_type === "INVESTMENT_GROUP") {
    if (!validation.eligible || binding.market_type !== "FUTURES") {
      return { validation, executionEnvironment: "INVESTMENT_GROUP" };
    }
    const executionPreflight = await buildInvestmentGroupExecutionPreflight(supabase, userId, binding, policyOverride);
    return {
      executionEnvironment: "INVESTMENT_GROUP",
      validation: {
        ...validation,
        executionPreflightRequired: true,
        eligible: validation.eligible && executionPreflight.ok,
        reasons: [...(validation.reasons || []), ...executionPreflight.reasons],
        executionPreflight
      }
    };
  }
  const connection = await oneOrNone(supabase.from("connectivity_connections")
    .select("id,provider,account_id,execution_environment,endpoint_profile")
    .eq("id", binding.connection_id)
    .eq("user_id", userId)
    .maybeSingle());
  const executionEnvironment = connection?.execution_environment;
  if (!validation.eligible || binding.market_type !== "FUTURES") {
    return { validation, executionEnvironment };
  }
  const executionPreflight = await buildBrokerExecutionPreflight(supabase, userId, binding, connection, policyOverride);
  return {
    executionEnvironment,
    validation: {
      ...validation,
      executionPreflightRequired: true,
      eligible: validation.eligible && executionPreflight.ok,
      reasons: [...(validation.reasons || []), ...executionPreflight.reasons],
      executionPreflight
    }
  };
}

async function buildBrokerExecutionPreflight(supabase, userId, binding, connection, policyOverride = null) {
  const checkedAt = new Date().toISOString();
  const provider = String(connection?.provider || "").toLowerCase();
  if (!connection || provider !== "bybit") {
    return failedExecutionPreflight(checkedAt, provider || "unknown", "A certified venue sizing preflight is unavailable for this broker.");
  }
  const [version, accountEquity, riskControl, mandate] = await Promise.all([
    oneOrNone(supabase.from("strategy_automation_versions").select("definition").eq("strategy_id", binding.strategy_id).eq("owner_user_id", userId).eq("version", binding.strategy_version).maybeSingle()),
    oneOrNone(supabase.from("broker_account_equity_snapshots").select("equity_usd,available_balance_usd,observed_at,captured_at").eq("account_id", binding.account_id).eq("user_id", userId).maybeSingle()),
    oneOrNone(supabase.from("account_risk_controls").select("max_leverage,max_position_usd,emergency_stop").eq("account_id", binding.account_id).maybeSingle()),
    oneOrNone(supabase.from("broker_automation_mandates").select("allow_strategy_execution,allow_withdrawals,max_order_notional,max_leverage,allowed_strategies,allowed_symbols,status,expires_at").eq("connection_id", binding.connection_id).eq("user_id", userId).eq("status", "ACTIVE").maybeSingle())
  ]);
  const definition = version?.definition;
  const symbol = String(definition?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const money = authoritativeAccountMoney(accountEquity);
  const unavailableReasons = [];
  if (!definition) unavailableReasons.push("The immutable running strategy version is unavailable.");
  if (!symbol) unavailableReasons.push("The running strategy symbol is unavailable.");
  if (resolveAccountEquityFreshness(accountEquity) !== "LIVE") unavailableReasons.push("A fresh authoritative broker equity snapshot is required before activation.");
  if (!mandate) unavailableReasons.push("An active broker automation mandate is required.");
  if (mandate && mandate.allow_strategy_execution !== true) unavailableReasons.push("The broker mandate does not permit strategy execution.");
  if (mandate?.allow_withdrawals === true) unavailableReasons.push("Withdrawal-enabled broker credentials are forbidden.");
  if (mandate?.expires_at && Date.parse(mandate.expires_at) <= Date.now()) unavailableReasons.push("The broker automation mandate has expired.");
  if (mandate && !listAllowsMandateValue(mandate.allowed_strategies, binding.strategy_id)) unavailableReasons.push("The broker mandate does not permit this strategy.");
  if (mandate && !listAllowsMandateValue(mandate.allowed_symbols, symbol)) unavailableReasons.push(`The broker mandate does not permit ${symbol}.`);
  if (riskControl?.emergency_stop) unavailableReasons.push("The broker account emergency stop is active.");
  if (unavailableReasons.length) return failedExecutionPreflight(checkedAt, provider, ...unavailableReasons);

  try {
    const routing = {
      category: "linear",
      symbol,
      executionEnvironment: connection.execution_environment,
      endpointProfile: connection.endpoint_profile || "GLOBAL"
    };
    const [ticker, instruments] = await Promise.all([
      getBybitTicker(routing),
      getBybitInstrumentMetadata(routing)
    ]);
    const instrument = instruments.find((item) => String(item.nativeSymbol).toUpperCase() === symbol);
    const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
    if (!instrument || !(referencePrice > 0)) {
      return failedExecutionPreflight(checkedAt, provider, `Bybit did not return current execution rules and a reference price for ${symbol}.`);
    }
    if (String(instrument.tradingStatus || "").toLowerCase() !== "trading") {
      return failedExecutionPreflight(checkedAt, provider, `${symbol} is not currently tradable on Bybit (${instrument.tradingStatus || "unknown status"}).`);
    }
    const policy = policyOverride || policyFromBinding(binding);
    const commonCaps = {
      targetMaximum: policy.maximumLeverage,
      accountRiskCap: riskControl?.max_leverage,
      emsRiskCap: mandate.max_leverage,
      providerCap: instrument.leverageLimits?.max
    };
    const takeProfitPercentages = strategyTakeProfitPercentages(definition);
    let takeProfitPricing = null;
    if (takeProfitPercentages.length && definition.runtimeKind === "builtin-superatr-seven-step") {
      const atrLength = Math.max(1, Math.round(Number(definition.settings?.superAtrTakeProfitAtrLength ?? 100)));
      if (atrLength > 999) {
        return failedExecutionPreflight(checkedAt, provider, `SuperATR take-profit ATR length ${atrLength} exceeds the certified 1,000-candle VPS runtime window; activation is blocked until the runtime and preflight can seed the same history.`);
      }
      const candleSnapshot = await getBybitClosedKlines({
        ...routing,
        timeframe: definition.timeframe,
        // Match the certified VPS signal runtime's complete Bybit seed window;
        // Wilder RMA depends on every post-seed candle, not only ATR length.
        limit: 1000
      });
      takeProfitPricing = superAtrTakeProfitPreflightPrices(definition, referencePrice, candleSnapshot);
      if (!takeProfitPricing.ok) return failedExecutionPreflight(checkedAt, provider, ...takeProfitPricing.reasons);
    }
    const reports = {};
    for (const direction of ["long", "short"]) {
      const directionPolicy = policyWithAbsoluteNotionalCaps({
        policy,
        direction,
        equity: money.equity,
        availableBalance: money.available,
        caps: commonCaps,
        absoluteNotionalCap: minimumPositiveNumber(mandate.max_order_notional, riskControl?.max_position_usd)
      });
      reports[direction] = preflightTargetExecution({
        equity: money.equity,
        availableBalance: money.available,
        capitalPolicy: directionPolicy,
        direction,
        directionSpecificLeverageCaps: { [direction]: commonCaps },
        referencePrice,
        ...(takeProfitPricing ? {
          takeProfitReferencePrices: takeProfitPricing.directions[direction].prices,
          takeProfitPriceBasis: takeProfitPricing.basis
        } : {}),
        venue: {
          quantityStep: instrument.quantityStep,
          quantityPrecision: instrument.quantityPrecision,
          minQuantity: instrument.minQuantity,
          minNotional: instrument.minNotional,
          maxQuantity: instrument.maxQuantity,
          maxMarketQuantity: instrument.maxMarketQuantity
        },
        takeProfitPercentages
      });
    }
    const reasons = Object.entries(reports).flatMap(([direction, report]) => report.ok ? [] : summarizeDirectionPreflight(direction, symbol, report));
    return {
      ok: reasons.length === 0,
      checkedAt,
      provider,
      executionEnvironment: connection.execution_environment,
      strategyVersion: binding.strategy_version,
      symbol,
      referencePrice,
      venue: {
        quantityStep: instrument.quantityStep,
        minQuantity: instrument.minQuantity,
        minNotional: instrument.minNotional,
        maxQuantity: instrument.maxQuantity,
        maxMarketQuantity: instrument.maxMarketQuantity,
        maximumLeverage: instrument.leverageLimits?.max || null
      },
      takeProfitPercentages,
      takeProfitPricing: takeProfitPricing ? {
        basis: takeProfitPricing.basis,
        atrValue: takeProfitPricing.atrValue,
        closedCandleAt: takeProfitPricing.closedCandleAt
      } : null,
      directions: Object.fromEntries(Object.entries(reports).map(([direction, report]) => [direction, safeExecutionPreflightReport(report)])),
      reasons
    };
  } catch (error) {
    return failedExecutionPreflight(checkedAt, provider, `Bybit execution rules could not be verified: ${String(error?.message || "public venue metadata is unavailable").slice(0, 300)}`);
  }
}

async function buildInvestmentGroupExecutionPreflight(supabase, userId, binding, policyOverride = null) {
  const checkedAt = new Date().toISOString();
  const [version, mandates] = await Promise.all([
    oneOrNone(supabase.from("strategy_automation_versions")
      .select("definition")
      .eq("strategy_id", binding.strategy_id)
      .eq("owner_user_id", userId)
      .eq("version", binding.strategy_version)
      .maybeSingle()),
    many(supabase.from("group_execution_mandates")
      .select("id,group_id,follower_user_id,broker_connection_id,status,execution_mode,allocation_method,allocation_value,max_order_notional,max_total_exposure,max_daily_loss,max_drawdown,max_leverage,allowed_symbols,allowed_market_types,allowed_order_types,allow_reduce_only,allow_position_reversal,protective_orders_required,allow_open_positions,allow_close_positions,allow_modify_protection,expires_at,paused_at,accepted_at")
      .eq("group_id", binding.group_id)
      .eq("status", "ACTIVE"))
  ]);
  const definition = version?.definition;
  const symbol = String(definition?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const unavailableReasons = [];
  if (!definition) unavailableReasons.push("The immutable running strategy version is unavailable for Investment Group preflight.");
  if (!symbol) unavailableReasons.push("The running strategy symbol is unavailable for Investment Group preflight.");
  if (!mandates.length) unavailableReasons.push("No active Investment Group follower mandate is available for execution preflight.");
  if (unavailableReasons.length) {
    return {
      ...failedExecutionPreflight(checkedAt, "investment-group", ...unavailableReasons),
      targetType: "INVESTMENT_GROUP",
      strategyVersion: binding.strategy_version,
      symbol: symbol || null,
      followerCount: mandates.length,
      followers: []
    };
  }

  const connectionIds = [...new Set(mandates.map((item) => item.broker_connection_id).filter(Boolean))];
  const [connections, capabilities, automationMandates] = await Promise.all([
    many(supabase.from("connectivity_connections")
      .select("id,user_id,provider,account_id,connection_mode,health_status,credential_state,worker_state,synchronization_state,execution_readiness,execution_environment,endpoint_profile,control_state,revoked_at,disabled_at")
      .in("id", connectionIds)),
    many(supabase.from("broker_connection_capabilities")
      .select("connection_id,user_id,can_execute_while_offline,can_receive_group_orders,can_withdraw,can_transfer,supported_order_types")
      .in("connection_id", connectionIds)),
    many(supabase.from("broker_automation_mandates")
      .select("id,user_id,connection_id,status,allow_strategy_execution,allow_investment_group_execution,allow_withdrawals,max_order_notional,max_position_notional,max_leverage,allowed_strategies,allowed_symbols,execution_environment,expires_at")
      .in("connection_id", connectionIds)
      .eq("status", "ACTIVE"))
  ]);
  const accountIds = [...new Set(connections.map((item) => item.account_id).filter(Boolean))];
  const [accounts, accountEquities, riskControls, positions] = accountIds.length ? await Promise.all([
    many(supabase.from("exchange_accounts")
      .select("id,user_id,status,api_health,is_read_only,trading_enabled,execution_environment")
      .in("id", accountIds)),
    many(supabase.from("broker_account_equity_snapshots")
      .select("account_id,user_id,equity_usd,available_balance_usd,observed_at,captured_at")
      .in("account_id", accountIds)),
    many(supabase.from("account_risk_controls")
      .select("account_id,max_leverage,max_position_usd,emergency_stop")
      .in("account_id", accountIds)),
    many(supabase.from("account_positions")
      .select("account_id,quantity,margin")
      .in("account_id", accountIds))
  ]) : [[], [], [], []];

  const connectionMap = new Map(connections.map((item) => [item.id, item]));
  const capabilityMap = new Map(capabilities.map((item) => [item.connection_id, item]));
  const accountMap = new Map(accounts.map((item) => [item.id, item]));
  const riskMap = new Map(riskControls.map((item) => [item.account_id, item]));
  const automationMap = new Map(automationMandates.map((item) => [item.connection_id, item]));
  const positionsByAccount = groupBy(positions, "account_id");
  const equityByAccount = latestRowsByKey(accountEquities, "account_id");
  const marketCache = new Map();
  const takeProfitPercentages = strategyTakeProfitPercentages(definition);

  const followers = await mapWithConcurrency(mandates, 3, async (mandate) => {
    const connection = connectionMap.get(mandate.broker_connection_id) || null;
    const account = connection?.account_id ? accountMap.get(connection.account_id) || null : null;
    let marketSnapshot = null;
    let marketError = null;
    if (connection && String(connection.provider || "").toLowerCase() === "bybit" && symbol) {
      const cacheKey = [connection.execution_environment || "", connection.endpoint_profile || "GLOBAL", symbol, definition.timeframe || ""].join(":");
      if (!marketCache.has(cacheKey)) {
        marketCache.set(cacheKey, loadGroupFollowerMarketSnapshot({ connection, definition, symbol, takeProfitPercentages }));
      }
      try {
        marketSnapshot = await marketCache.get(cacheKey);
      } catch (error) {
        marketError = `Bybit execution rules could not be verified: ${String(error?.message || "public venue metadata is unavailable").slice(0, 300)}`;
      }
    }
    return preflightInvestmentGroupFollowerExecution({
      checkedAt,
      binding,
      definition,
      symbol,
      mandate,
      connection,
      capability: capabilityMap.get(mandate.broker_connection_id) || null,
      automationMandate: automationMap.get(mandate.broker_connection_id) || null,
      account,
      accountEquity: account?.id ? equityByAccount.get(account.id) || null : null,
      riskControl: account?.id ? riskMap.get(account.id) || null : null,
      positions: account?.id ? positionsByAccount.get(account.id) || [] : [],
      marketSnapshot,
      marketError,
      takeProfitPercentages,
      policyOverride
    });
  });
  const reasons = followers.flatMap((report, index) => report.ok
    ? []
    : report.reasons.map((reason) => `Follower ${index + 1} (${report.mandateId || "unknown mandate"}): ${reason}`));
  return {
    ok: reasons.length === 0 && followers.length === mandates.length,
    checkedAt,
    provider: "investment-group",
    targetType: "INVESTMENT_GROUP",
    strategyVersion: binding.strategy_version,
    symbol,
    followerCount: mandates.length,
    passedFollowerCount: followers.filter((item) => item.ok).length,
    takeProfitPercentages,
    followers,
    reasons
  };
}

async function loadGroupFollowerMarketSnapshot({ connection, definition, symbol, takeProfitPercentages }) {
  const routing = {
    category: "linear",
    symbol,
    executionEnvironment: connection.execution_environment,
    endpointProfile: connection.endpoint_profile || "GLOBAL"
  };
  const [ticker, instruments] = await Promise.all([
    getBybitTicker(routing),
    getBybitInstrumentMetadata(routing)
  ]);
  const instrument = instruments.find((item) => String(item.nativeSymbol).toUpperCase() === symbol);
  const referencePrice = Number(ticker.markPrice || ticker.lastPrice);
  if (!instrument || !(referencePrice > 0)) throw new Error(`Bybit did not return current execution rules and a reference price for ${symbol}.`);
  if (String(instrument.tradingStatus || "").toLowerCase() !== "trading") throw new Error(`${symbol} is not currently tradable on Bybit (${instrument.tradingStatus || "unknown status"}).`);
  let takeProfitPricing = null;
  if (takeProfitPercentages.length && definition.runtimeKind === "builtin-superatr-seven-step") {
    const atrLength = Math.max(1, Math.round(Number(definition.settings?.superAtrTakeProfitAtrLength ?? 100)));
    if (atrLength > 999) throw new Error(`SuperATR take-profit ATR length ${atrLength} exceeds the certified 1,000-candle VPS runtime window.`);
    const candles = await getBybitClosedKlines({ ...routing, timeframe: definition.timeframe, limit: 1000 });
    takeProfitPricing = superAtrTakeProfitPreflightPrices(definition, referencePrice, candles);
    if (!takeProfitPricing.ok) throw new Error(takeProfitPricing.reasons.join(" "));
  }
  return { instrument, referencePrice, takeProfitPricing };
}

export function preflightInvestmentGroupFollowerExecution(input = {}) {
  const {
    checkedAt = new Date().toISOString(), binding = {}, definition = {}, symbol = "", mandate = {}, connection,
    capability, automationMandate, account, accountEquity, riskControl, positions = [], marketSnapshot,
    marketError, takeProfitPercentages = [], policyOverride = null
  } = input;
  const reasons = [];
  const reject = (message) => { if (message && !reasons.includes(message)) reasons.push(message); };
  const followerUserId = String(mandate.follower_user_id || "");
  const now = Date.parse(checkedAt) || Date.now();
  if (String(mandate.status || "").toUpperCase() !== "ACTIVE") reject("The follower mandate is not active.");
  if (mandate.expires_at && Date.parse(mandate.expires_at) <= now) reject("The follower mandate has expired.");
  if (!connection) reject("The follower broker connection is unavailable.");
  if (connection && String(connection.user_id || "") !== followerUserId) reject("The follower mandate does not own its broker connection.");
  if (connection && String(connection.provider || "").toLowerCase() !== "bybit") reject("A certified venue sizing preflight is unavailable for this follower broker.");
  if (connection && !["CLOUD_DELEGATED", "HYBRID"].includes(String(connection.connection_mode || "").toUpperCase())) reject("The follower broker connection is not enabled for unattended cloud execution.");
  if (connection && !["CONNECTED_CLOUD", "CONNECTED_HYBRID"].includes(String(connection.health_status || "").toUpperCase())) reject("The follower broker connection is not cloud-healthy.");
  if (connection && String(connection.credential_state || "").toUpperCase() !== "AUTHENTICATED") reject("The follower broker credentials are not authenticated.");
  if (connection && String(connection.worker_state || "").toUpperCase() !== "LIVE") reject("The follower private broker worker is not live.");
  if (connection && String(connection.synchronization_state || "").toUpperCase() !== "SYNCHRONIZED") reject("The follower broker account is not synchronized.");
  if (connection && String(connection.execution_readiness || "").toUpperCase() !== "READY") reject("The follower broker account is not ready for execution.");
  if (connection && String(connection.control_state || "ACTIVE").toUpperCase() !== "ACTIVE") reject("The follower broker execution control is paused.");
  if (connection?.revoked_at || connection?.disabled_at) reject("The follower broker connection is disabled or revoked.");
  if (!account) reject("The follower exchange account is unavailable.");
  if (account && String(account.user_id || "") !== followerUserId) reject("The follower mandate does not own its exchange account.");
  if (account?.is_read_only === true || account?.trading_enabled !== true) reject("The follower exchange account is not approved for trading.");
  if (account?.execution_environment && connection?.execution_environment && account.execution_environment !== connection.execution_environment) reject("The follower account and broker connection execution environments differ.");
  if (!capability?.can_execute_while_offline || !capability?.can_receive_group_orders) reject("The follower connection lacks certified offline Investment Group execution capability.");
  if (capability?.can_withdraw === true || capability?.can_transfer === true) reject("Withdrawal- or transfer-capable follower credentials are forbidden.");
  if (!groupListAllows(capability?.supported_order_types, "MARKET") || (takeProfitPercentages.length && !groupListAllows(capability?.supported_order_types, "LIMIT"))) reject("The follower adapter does not support every required entry and take-profit order type.");
  if (!automationMandate) reject("An active follower broker automation mandate is required.");
  if (automationMandate && String(automationMandate.user_id || "") !== followerUserId) reject("The follower does not own the active broker automation mandate.");
  if (automationMandate?.allow_investment_group_execution !== true) reject("The broker automation mandate does not permit Investment Group execution.");
  if (automationMandate?.allow_strategy_execution !== true) reject("The broker automation mandate does not permit strategy execution.");
  if (automationMandate?.allow_withdrawals === true) reject("Withdrawal-enabled follower broker credentials are forbidden.");
  if (automationMandate?.expires_at && Date.parse(automationMandate.expires_at) <= now) reject("The follower broker automation mandate has expired.");
  if (automationMandate?.execution_environment && connection?.execution_environment && automationMandate.execution_environment !== connection.execution_environment) reject("The follower broker mandate and connection execution environments differ.");
  if (automationMandate && !listAllowsMandateValue(automationMandate.allowed_strategies, binding.strategy_id)) reject("The follower broker mandate does not permit this strategy.");
  if (automationMandate && !listAllowsMandateValue(automationMandate.allowed_symbols, symbol)) reject(`The follower broker mandate does not permit ${symbol}.`);
  if (!groupListAllows(mandate.allowed_symbols, symbol)) reject(`The Investment Group mandate does not permit ${symbol}.`);
  if (!groupListAllows(mandate.allowed_market_types, "PERPETUAL") && !groupListAllows(mandate.allowed_market_types, "FUTURES")) reject("The Investment Group mandate does not permit perpetual futures.");
  if (!groupListAllows(mandate.allowed_order_types, "MARKET") || (takeProfitPercentages.length && !groupListAllows(mandate.allowed_order_types, "LIMIT"))) reject("The Investment Group mandate does not permit every required entry and take-profit order type.");
  if (mandate.allow_open_positions === false) reject("The Investment Group mandate does not permit opening positions.");
  if (takeProfitPercentages.length && (mandate.allow_close_positions === false || mandate.allow_reduce_only === false)) reject("The Investment Group mandate does not permit reduce-only partial take-profits.");
  if (riskControl?.emergency_stop) reject("The follower account emergency stop is active.");
  if (accountEquity && String(accountEquity.user_id || "") !== followerUserId) reject("The authoritative follower equity snapshot belongs to a different user.");
  if (resolveAccountEquityFreshness(accountEquity, now) !== "LIVE") reject("A fresh authoritative follower equity and available-balance snapshot is required before activation.");
  const money = authoritativeAccountMoney(accountEquity);
  if (!(money.equity > 0) || !(money.available > 0)) reject("The follower account has no positive synchronized equity and available balance.");
  if (marketError) reject(marketError);
  if (!marketSnapshot?.instrument || !(Number(marketSnapshot?.referencePrice) > 0)) reject(`Current Bybit instrument rules and price are unavailable for ${symbol || "the strategy symbol"}.`);

  const policy = policyOverride || policyFromBinding(binding);
  const currentExposure = positions.reduce((sum, row) => sum + Math.abs(Number(row.margin || 0)), 0);
  const directionReports = {};
  if (reasons.length === 0) {
    for (const direction of ["long", "short"]) {
      const requestedLeverage = direction === "short"
        ? Number(policy.requestedShortLeverage || policy.requestedLeverage || 1)
        : Number(policy.requestedLongLeverage || policy.requestedLeverage || 1);
      const leverageLimit = minimumPositiveNumber(
        policy.maximumLeverage,
        mandate.max_leverage,
        automationMandate.max_leverage,
        riskControl?.max_leverage,
        marketSnapshot.instrument.leverageLimits?.max
      );
      const leverageReasons = [];
      if (leverageLimit && requestedLeverage > leverageLimit + 1e-12) {
        leverageReasons.push(`${direction.toUpperCase()}: requested ${formatQuantity(requestedLeverage)}x leverage exceeds the follower's ${formatQuantity(leverageLimit)}x effective limit.`);
      }
      let allocation;
      try {
        allocation = calculateFollowerAllocation({
          intent: { leverage: requestedLeverage, quantity_model: "MANDATE_ALLOCATION", quantity_value: 1 },
          mandate: {
            ...mandate,
            max_order_notional: minimumPositiveNumber(mandate.max_order_notional, automationMandate.max_order_notional, automationMandate.max_position_notional, riskControl?.max_position_usd) || mandate.max_order_notional
          },
          account: { equityUsd: money.equity, availableBalanceUsd: money.available },
          instrument: marketSnapshot.instrument,
          referencePrice: marketSnapshot.referencePrice,
          currentExposure
        });
      } catch (error) {
        allocation = null;
        leverageReasons.push(`${direction.toUpperCase()}: follower allocation is invalid (${String(error?.message || "unknown allocation error")}).`);
      }
      const fixedQuantityPolicy = {
        strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
        strategyAllocationValue: 100,
        tradeAmountMode: "FIXED_QUANTITY",
        tradeAmountValue: Number(allocation?.roundedQuantity || 0),
        requestedLeverage,
        requestedLongLeverage: requestedLeverage,
        requestedShortLeverage: requestedLeverage,
        maximumLeverage: requestedLeverage,
        maximumPositionPercent: 100,
        maximumExposurePercent: 100,
        maximumDailyLoss: Math.max(1, Number(policy.maximumDailyLoss || 1)),
        maximumDrawdown: Math.max(1, Number(policy.maximumDrawdown || 1)),
        maximumPositions: Math.max(1, Number(policy.maximumPositions || 1)),
        slippageBps: Math.max(0, Number(policy.slippageBps || 0)),
        marginMode: policy.marginMode || "CROSS"
      };
      const report = preflightTargetExecution({
        equity: money.equity,
        availableBalance: money.available,
        capitalPolicy: fixedQuantityPolicy,
        direction,
        directionSpecificLeverageCaps: { [direction]: { targetMaximum: requestedLeverage, groupMandateCap: leverageLimit, providerCap: marketSnapshot.instrument.leverageLimits?.max } },
        referencePrice: marketSnapshot.referencePrice,
        ...(marketSnapshot.takeProfitPricing ? {
          takeProfitReferencePrices: marketSnapshot.takeProfitPricing.directions[direction].prices,
          takeProfitPriceBasis: marketSnapshot.takeProfitPricing.basis
        } : {}),
        venue: {
          quantityStep: marketSnapshot.instrument.quantityStep,
          quantityPrecision: marketSnapshot.instrument.quantityPrecision,
          minQuantity: marketSnapshot.instrument.minQuantity,
          minNotional: marketSnapshot.instrument.minNotional,
          maxQuantity: marketSnapshot.instrument.maxQuantity,
          maxMarketQuantity: marketSnapshot.instrument.maxMarketQuantity
        },
        takeProfitPercentages
      });
      const reportReasons = [...report.reasons, ...leverageReasons];
      directionReports[direction] = {
        ...safeExecutionPreflightReport(report),
        ok: report.ok && leverageReasons.length === 0,
        allocation: allocation ? {
          calculatedEquity: allocation.calculatedEquity,
          calculatedAvailableMargin: allocation.calculatedAvailableMargin,
          requestedNotional: allocation.requestedNotional,
          targetNotional: allocation.targetNotional,
          roundedQuantity: allocation.roundedQuantity,
          estimatedMargin: allocation.estimatedMargin,
          constrained: allocation.constrained
        } : null,
        reasons: reportReasons
      };
    }
  }
  const directionReasons = Object.values(directionReports).flatMap((report) => report.ok ? [] : report.reasons);
  const allReasons = [...new Set([...reasons, ...directionReasons])];
  return {
    ok: allReasons.length === 0 && ["long", "short"].every((direction) => directionReports[direction]?.ok === true),
    checkedAt,
    mandateId: mandate.id || null,
    connectionId: connection?.id || mandate.broker_connection_id || null,
    executionEnvironment: connection?.execution_environment || null,
    equity: money.equity,
    availableBalance: money.available,
    venue: marketSnapshot?.instrument ? {
      quantityStep: marketSnapshot.instrument.quantityStep,
      minQuantity: marketSnapshot.instrument.minQuantity,
      minNotional: marketSnapshot.instrument.minNotional,
      maxQuantity: marketSnapshot.instrument.maxQuantity,
      maxMarketQuantity: marketSnapshot.instrument.maxMarketQuantity,
      maximumLeverage: marketSnapshot.instrument.leverageLimits?.max || null
    } : null,
    directions: directionReports,
    reasons: allReasons
  };
}

export function superAtrTakeProfitPreflightPrices(definition, referencePrice, candleSnapshot = {}) {
  const settings = definition?.settings || {};
  const atrLength = Math.max(1, Math.round(Number(settings.superAtrTakeProfitAtrLength ?? 100)));
  const candles = Array.isArray(candleSnapshot.candles) ? candleSnapshot.candles : [];
  const integrity = validateBybitClosedKlineSnapshot(candleSnapshot);
  if (!integrity.ok) {
    return { ok: false, reasons: integrity.reasons.map((reason) => `SuperATR closed-candle integrity failed: ${reason}`), integrity };
  }
  const atrValue = latestPineAtr(candles, atrLength);
  const closedCandle = candles.at(-1);
  if (!(Number(referencePrice) > 0)) return { ok: false, reasons: ["SuperATR take-profit pricing requires a positive current Bybit reference price."] };
  if (!(atrValue > 0) || !closedCandle) {
    return { ok: false, reasons: [`SuperATR take-profit ATR(${atrLength}) is unavailable from the latest authoritative closed-candle window; activation is blocked.`] };
  }
  const atrMultipliers = normalizedPositiveList(settings.superAtrAtrMultipliers, [100, 70, 120, 300], 4);
  const fixedPercentages = normalizedPositiveList(settings.superAtrFixedPercentages, [21, 21, 75], 3);
  const directions = {};
  for (const direction of ["long", "short"]) {
    const sign = direction === "long" ? 1 : -1;
    const prices = [
      ...atrMultipliers.map((multiplier) => Number(referencePrice) + sign * atrValue * multiplier),
      ...fixedPercentages.map((percentage) => Number(referencePrice) * (1 + sign * percentage / 100))
    ];
    const invalidIndex = prices.findIndex((price) => !Number.isFinite(price) || price <= 0);
    if (invalidIndex >= 0) {
      return { ok: false, reasons: [`${direction.toUpperCase()}: ${direction === "short" ? "A short" : "A long"} TP${invalidIndex + 1} formula resolves to a non-positive or invalid price under the latest closed-candle ATR snapshot; activation is blocked.`] };
    }
    directions[direction] = { prices };
  }
  return {
    ok: true,
    basis: "SUPERATR_LATEST_CLOSED_CANDLE_FORMULAS",
    atrValue,
    atrLength,
    closedCandleAt: integrity.latestClosedCandleAt,
    closedCandleOpenAt: new Date(Number(closedCandle.time)).toISOString(),
    integrity,
    directions,
    reasons: []
  };
}

function latestPineAtr(candles, period) {
  if (!Array.isArray(candles) || candles.length < period || !(period > 0)) return null;
  const ranges = candles.map((candle, index) => index === 0
    ? Number(candle.high) - Number(candle.low)
    : Math.max(
      Number(candle.high) - Number(candle.low),
      Math.abs(Number(candle.high) - Number(candles[index - 1].close)),
      Math.abs(Number(candle.low) - Number(candles[index - 1].close))
    ));
  if (ranges.some((value) => !Number.isFinite(value) || value < 0)) return null;
  let current = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < ranges.length; index += 1) current = (current * (period - 1) + ranges[index]) / period;
  return Number.isFinite(current) && current > 0 ? current : null;
}

function normalizedPositiveList(value, fallback, length) {
  const source = Array.isArray(value) ? value : fallback;
  return Array.from({ length }, (_, index) => {
    const parsed = Number(source[index] ?? fallback[index] ?? 1);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number(fallback[index] || 1);
  });
}

function assertExecutionPreflight(validation) {
  const required = validation?.executionPreflightRequired === true
    || (validation && Object.prototype.hasOwnProperty.call(validation, "executionPreflight"));
  if (!required) return;
  const preflight = validation?.executionPreflight;
  const malformed = !preflight
    || typeof preflight !== "object"
    || Array.isArray(preflight)
    || typeof preflight.ok !== "boolean"
    || !Array.isArray(preflight.reasons)
    || preflight.reasons.some((reason) => typeof reason !== "string");
  if (malformed) {
    throw strategyError(409, "STRATEGY_TARGET_EXECUTION_PREFLIGHT_UNAVAILABLE", "This target cannot be armed because a complete certified execution preflight is unavailable.", {
      reasons: ["A complete certified execution preflight is required before broker activation."]
    });
  }
  if (preflight.ok !== false) return;
  throw strategyError(409, "STRATEGY_TARGET_EXECUTION_PREFLIGHT_FAILED", `This target cannot execute the running strategy: ${preflight.reasons.join(" ")}`, {
    reasons: preflight.reasons,
    executionPreflight: preflight
  });
}

export function strategyTakeProfitPercentages(definition = {}) {
  const settings = definition.settings || {};
  if (definition.runtimeKind === "builtin-superatr-seven-step") {
    if (settings.superAtrMultiStepTakeProfit === false) return [];
    const atrPercent = boundedPercent(settings.superAtrAtrExitPercent ?? 10, 10);
    const fixedPercent = boundedPercent(settings.superAtrFixedExitPercent ?? 10, 10);
    return [atrPercent, atrPercent, atrPercent, atrPercent, fixedPercent, fixedPercent, fixedPercent];
  }
  return (Array.isArray(definition.exits?.takeProfits) ? definition.exits.takeProfits : [])
    .map((target) => boundedPercent(target?.closePercent, 0))
    .filter((value) => value > 0)
    .slice(0, 7);
}

function policyWithAbsoluteNotionalCaps({ policy, direction, equity, availableBalance, caps, absoluteNotionalCap }) {
  if (!(absoluteNotionalCap > 0)) return policy;
  const requested = direction === "short"
    ? policy.requestedShortLeverage || policy.requestedLeverage
    : policy.requestedLongLeverage || policy.requestedLeverage;
  const effectiveLeverage = calculateEffectiveLeverage({ requested, ...caps });
  const preview = calculateCapitalPreview({ equity, availableBalance, policy: { ...policy, requestedLeverage: effectiveLeverage }, marketType: "FUTURES" });
  if (!(preview.allocatedStrategyCapital > 0) || !(effectiveLeverage > 0)) return policy;
  const absoluteCapPercent = absoluteNotionalCap / (preview.allocatedStrategyCapital * effectiveLeverage) * 100;
  return {
    ...policy,
    maximumPositionPercent: Math.min(policy.maximumPositionPercent, absoluteCapPercent),
    maximumExposurePercent: Math.min(policy.maximumExposurePercent, absoluteCapPercent)
  };
}

function safeExecutionPreflightReport(report) {
  return {
    ok: report.ok,
    effectiveLeverage: report.effectiveLeverage,
    pricing: report.pricing,
    estimated: report.estimated,
    fullLadder: {
      configured: report.fullLadder.configured,
      feasible: report.fullLadder.feasible,
      priceBasis: report.fullLadder.priceBasis,
      referencePrice: report.fullLadder.referencePrice,
      requestedPercentages: report.fullLadder.requestedPercentages,
      effectivePercentages: report.fullLadder.effectivePercentages,
      reasons: report.fullLadder.reasons
    },
    minimumExecutable: report.minimumExecutable,
    reasons: report.reasons,
    reasonDetails: report.reasonDetails
  };
}

function summarizeDirectionPreflight(direction, symbol, report) {
  const label = direction.toUpperCase();
  const primary = report.reasons.slice(0, 2).join(" ") || "The configured entry is not executable.";
  const minimum = report.minimumExecutable;
  const minimumText = minimum?.available
    ? `Minimum complete ladder: ${formatQuantity(minimum.entryQuantity)} ${symbol}, approximately ${formatMoney(minimum.entryMargin)} USDT margin at ${formatQuantity(report.effectiveLeverage)}x${Number.isFinite(minimum.tradePercent) ? ` (${formatQuantity(minimum.tradePercent)}% ${String(minimum.tradePercentBasis || "capital").toLowerCase().replaceAll("_", " ")})` : ""}.`
    : "";
  return [`${label}: ${primary} ${minimumText}`.trim()];
}

function failedExecutionPreflight(checkedAt, provider, ...reasons) {
  return { ok: false, checkedAt, provider, reasons: reasons.filter(Boolean) };
}

export function latestBindingExecutionTelemetry(commandHistory = [], binding = {}) {
  const lifecycleResetAt = maximumTimestamp(binding.armed_at, binding.updated_at);
  const createdOrder = [...commandHistory].sort((left, right) => timestampOf(right.created_at) - timestampOf(left.created_at));
  const latestPrimary = createdOrder.find((command) => ["ENTRY", "REVERSE", "CLOSE"].includes(String(command.payload?.action || "").toUpperCase()));
  if (!latestPrimary) return {};
  const primarySignalKey = String(latestPrimary.strategy_signal_key || "");
  const primaryExecutionOrderId = String(latestPrimary.execution_order_id || "");
  const generation = commandHistory.filter((command) => command === latestPrimary
    || (primarySignalKey && String(command.payload?.parentStrategySignalKey || "") === primarySignalKey)
    || (primaryExecutionOrderId
      && String(command.payload?.strategyAction || "").toUpperCase() === "TAKE_PROFIT_REPRICE"
      && String(command.payload?.expectedEntryOrderId || "") === primaryExecutionOrderId));
  const latestFailure = generation
    .filter(isProminentExecutionFailure)
    .sort((left, right) => timestampOf(right.updated_at || right.created_at) - timestampOf(left.updated_at || left.created_at))[0];
  if (!latestFailure) return {};
  const failureAt = timestampOf(latestFailure.updated_at || latestFailure.created_at);
  if (Number.isFinite(lifecycleResetAt) && (!Number.isFinite(failureAt) || lifecycleResetAt > failureAt)) return {};
  const code = String(latestFailure.last_error_code || "EXECUTION_FAILED").toUpperCase();
  return {
    latestExecutionStatus: String(latestFailure.status || "FAILED").toUpperCase(),
    latestExecutionAction: String(latestFailure.payload?.action || latestFailure.payload?.strategyAction || "UNKNOWN").toUpperCase(),
    latestExecutionDirection: String(latestFailure.payload?.direction || latestFailure.payload?.positionDirection || "UNKNOWN").toUpperCase(),
    latestExecutionAt: latestFailure.updated_at || latestFailure.created_at || null,
    latestExecutionErrorCode: code,
    latestExecutionErrorMessage: latestFailure.last_error_message || "The broker execution command failed.",
    latestExecutionVenueOrderSubmitted: failedCommandVenueSubmission(latestFailure, code)
  };
}

function failedCommandVenueSubmission(command, code) {
  // execution_order_id on CANCEL/MODIFY identifies the pre-existing order being
  // mutated; it is not proof that the failed mutation reached Bybit. Only a
  // PLACE_ORDER command's own durable OMS acknowledgement proves submission.
  if (String(command?.command_type || "").toUpperCase() === "PLACE_ORDER" && command?.execution_order_id) return true;
  if (knownPreSubmissionFailure(code)) return false;
  return undefined;
}

function isProminentExecutionFailure(command) {
  const status = String(command?.status || "").toUpperCase();
  if (["FAILED", "REJECTED", "DEAD_LETTER"].includes(status)) return true;
  const code = String(command?.last_error_code || "").toUpperCase();
  return status === "CANCELLED" && [
    "PARENT_ENTRY_FAILED",
    "PARENT_ENTRY_UNFILLED",
    "PARENT_GROUP_ENTRY_FAILED",
    "PARENT_GROUP_ENTRY_UNFILLED"
  ].includes(code);
}

function maximumTimestamp(...values) {
  const timestamps = values.map(timestampOf).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NaN;
}

function timestampOf(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function knownPreSubmissionFailure(code) {
  return [
    "STRATEGY_QUANTITY_BELOW_VENUE_STEP",
    "STRATEGY_TP_LADDER_BELOW_VENUE_MINIMUM",
    "VENUE_VALIDATION_REJECTED",
    "STRATEGY_TARGET_EXECUTION_PREFLIGHT_FAILED",
    "TP_REPRICE_REJECTED"
  ].includes(String(code || "").toUpperCase());
}

function listAllowsMandateValue(values, requestedValue) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const requested = String(requestedValue || "").trim().toUpperCase();
  return values.some((value) => {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized === "*" || normalized === requested;
  });
}

function groupListAllows(values, requestedValue) {
  if (!Array.isArray(values)) return false;
  const requested = String(requestedValue || "").trim().toUpperCase();
  return values.some((value) => {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized === "*" || normalized === requested;
  });
}

function minimumPositiveNumber(...values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : null;
}

function boundedPercent(value, fallback) {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? parsed : fallback));
}

function formatQuantity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "unavailable";
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 8, useGrouping: false });
}

function formatMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "unavailable";
  return parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}

async function controlTarget(supabase, userId, strategyId, bindingId, expectedVersion, action, validation, disconnectPolicy, idempotencyKey) {
  const requestHash = canonicalRequestHash({ action, expectedVersion: Number(expectedVersion), disconnectPolicy });
  const { error } = await supabase.rpc("black_core_control_strategy_target", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_binding_id: bindingId,
    p_expected_row_version: Number(expectedVersion),
    p_action: action,
    p_validation_snapshot: validation || {},
    p_disconnect_policy: disconnectPolicy,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "40001") throw strategyError(409, "STRATEGY_TARGET_VERSION_CONFLICT", "Target state changed elsewhere. Refresh and try again.");
    if (error.code === "55000") throw strategyError(409, "STRATEGY_TARGET_STATE_CONFLICT", "This target cannot perform that action from its current state.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different target mutation.");
    throw persistenceError(error);
  }
}

function validateBrokerEligibility({ connection, account, capability, strategy, conflict, environment }) {
  const reasons = [];
  if (!account) reasons.push("Canonical broker account is missing.");
  if (connection.connection_mode !== "CLOUD_DELEGATED" && connection.connection_mode !== "HYBRID") reasons.push("Persistent Black Cloud delegation is not enabled.");
  if (!['CONNECTED_CLOUD','CONNECTED_HYBRID'].includes(connection.health_status)) reasons.push("Black Cloud connection is not healthy.");
  if (connection.credential_state !== "AUTHENTICATED") reasons.push("Broker credentials are not authenticated.");
  if (connection.worker_state !== "LIVE") reasons.push("Private broker worker is not live.");
  if (connection.synchronization_state !== "SYNCHRONIZED") reasons.push("Broker reconciliation is incomplete.");
  if (connection.execution_readiness !== "READY") reasons.push("Broker execution readiness is blocked.");
  if (connection.control_state && connection.control_state !== "ACTIVE") reasons.push("Broker control is paused or emergency stopped.");
  if (account?.is_read_only || !account?.trading_enabled) reasons.push("The broker account lacks trade permission.");
  if (capability?.can_withdraw) reasons.push("Withdrawal-enabled credentials are forbidden.");
  if (!capability?.can_read_balances || !capability?.can_read_positions || !capability?.can_read_orders) reasons.push("Required account read capabilities are missing.");
  if (!capability?.can_execute_while_offline) reasons.push("Persistent server execution is not certified.");
  if (strategy.market_type === "FUTURES" && !includesMarket(capability?.supported_market_types, "FUTURES")) reasons.push("The connection does not certify Futures for this strategy.");
  if (strategy.market_type === "SPOT" && !includesMarket(capability?.supported_market_types, "SPOT")) reasons.push("The connection does not certify Spot for this strategy.");
  const executionEnvironment = connection.execution_environment || account?.execution_environment;
  if (!['DEMO','MAINNET_LIVE'].includes(executionEnvironment) || account?.execution_environment !== executionEnvironment) reasons.push("The broker account and cloud connection execution environments do not match.");
  if (conflict) reasons.push("This account already occupies a target slot in this strategy version.");
  if (environment.STRATEGY_AUTOMATION_TARGET_CONFIGURATION_ENABLED === "false") reasons.push("Strategy target configuration is disabled by rollout policy.");
  if (executionEnvironment === "DEMO" && (environment.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED !== "true" || environment.BYBIT_DEMO_ENABLED !== "true")) reasons.push("Bybit Demo strategy execution is disabled by rollout policy.");
  if (executionEnvironment === "MAINNET_LIVE" && (environment.STRATEGY_AUTOMATION_LIVE_EXECUTION_ENABLED !== "true" || environment.STRATEGY_AUTOMATION_LIVE_EXECUTION_CERTIFIED !== "true")) reasons.push("Bybit Mainnet strategy execution is disabled or not certified by rollout policy.");
  if (environment.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") reasons.push("The Black Cloud global execution kill switch is engaged.");
  return { eligible: reasons.length === 0, reasons, checkedAt: new Date().toISOString(), withdrawalPermission: "NONE" };
}

function validateGroupEligibility({ group, activeMandates, conflict, environment }) {
  const reasons = [];
  if (group.status !== "active") reasons.push("Investment Group is not active.");
  if (environment.INVESTMENT_GROUP_EXECUTION_ENABLED !== "true") reasons.push("Investment Group execution is disabled by rollout policy.");
  if (environment.STRATEGY_AUTOMATION_GROUP_EXECUTION_ENABLED !== "true") reasons.push("Strategy-to-group signal fanout is not certified on this Black Cloud deployment.");
  if (environment.BLACK_CLOUD_GLOBAL_EXECUTION_KILL_SWITCH === "true") reasons.push("The Black Cloud global execution kill switch is engaged.");
  if (!activeMandates.length) reasons.push("No active authorized follower mandate is available.");
  if (conflict) reasons.push("This Investment Group already occupies a target slot in this strategy version.");
  return { eligible: reasons.length === 0, reasons, checkedAt: new Date().toISOString(), authorizedMembers: activeMandates.length };
}

function assertPolicyWithinGlobal(target, global, marketType) {
  const hard = normalizeGlobalPolicy(global, marketType);
  const violations = [];
  if (target.strategyAllocationMode === hard.strategyAllocationMode && target.strategyAllocationValue > hard.strategyAllocationValue) violations.push("strategy allocation");
  if (target.tradeAmountMode === hard.tradeAmountMode && target.tradeAmountValue > hard.tradeAmountValue) violations.push("per-trade amount");
  if ((target.maximumLeverage || 1) > (hard.maximumLeverage || 1)) violations.push("maximum leverage");
  if (target.maximumPositionPercent > hard.maximumPositionPercent) violations.push("maximum position size");
  if (target.maximumExposurePercent > hard.maximumExposurePercent) violations.push("maximum exposure");
  if (target.maximumDailyLoss > hard.maximumDailyLoss) violations.push("maximum daily loss");
  if (target.maximumDrawdown > hard.maximumDrawdown) violations.push("maximum drawdown");
  if (target.maximumPositions > hard.maximumPositions) violations.push("maximum positions");
  if (marketType === "SPOT" && (target.quoteAssetReservePercent || 0) < (hard.quoteAssetReservePercent || 0)) violations.push("quote asset reserve");
  if (marketType === "SPOT" && (target.maximumBaseAssetExposurePercent || 0) > (hard.maximumBaseAssetExposurePercent || 0)) violations.push("maximum base-asset exposure");
  if (violations.length) throw strategyError(400, "STRATEGY_TARGET_EXCEEDS_GLOBAL_LIMIT", "Target overrides cannot exceed global strategy limits.", { violations });
}

function normalizeGlobalPolicy(value, marketType) {
  return normalizeCapitalPolicy(value || {
    strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY",
    strategyAllocationValue: 100,
    tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION",
    tradeAmountValue: 100,
    requestedLeverage: marketType === "FUTURES" ? 3 : undefined,
    maximumLeverage: marketType === "FUTURES" ? 10 : undefined,
    maximumPositionPercent: 100,
    maximumExposurePercent: 100,
    maximumDailyLoss: 1_000_000_000,
    maximumDrawdown: 100,
    maximumPositions: 1000,
    slippageBps: 10000,
    marginMode: marketType === "FUTURES" ? "CROSS" : undefined,
    quoteAssetReservePercent: marketType === "SPOT" ? 0 : undefined,
    maximumBaseAssetExposurePercent: marketType === "SPOT" ? 100 : undefined
  }, marketType, { allowZeroAllocation: false });
}

function policyFromBinding(row) {
  return {
    strategyAllocationMode: row.strategy_allocation_mode,
    strategyAllocationValue: Number(row.strategy_allocation_value),
    tradeAmountMode: row.trade_amount_mode,
    tradeAmountValue: Number(row.trade_amount_value),
    requestedLeverage: row.requested_leverage == null ? undefined : Number(row.requested_leverage),
    requestedLongLeverage: row.requested_long_leverage == null ? (row.requested_leverage == null ? undefined : Number(row.requested_leverage)) : Number(row.requested_long_leverage),
    requestedShortLeverage: row.requested_short_leverage == null ? (row.requested_leverage == null ? undefined : Number(row.requested_leverage)) : Number(row.requested_short_leverage),
    maximumLeverage: row.maximum_leverage == null ? undefined : Number(row.maximum_leverage),
    maximumPositionPercent: Number(row.maximum_position_percent),
    maximumExposurePercent: Number(row.maximum_exposure_percent),
    maximumDailyLoss: Number(row.maximum_daily_loss),
    maximumDrawdown: Number(row.maximum_drawdown),
    maximumPositions: Number(row.maximum_positions),
    slippageBps: Number(row.slippage_bps),
    marginMode: row.margin_mode || undefined,
    quoteAssetReservePercent: row.quote_asset_reserve_percent == null ? undefined : Number(row.quote_asset_reserve_percent),
    maximumBaseAssetExposurePercent: row.maximum_base_asset_exposure_percent == null ? undefined : Number(row.maximum_base_asset_exposure_percent)
  };
}

async function ownedStrategy(supabase, userId, strategyId) {
  const { data, error } = await supabase.from("strategy_automation_strategies").select("*").eq("id", strategyId).eq("owner_user_id", userId).is("archived_at", null).maybeSingle();
  if (error) throw persistenceError(error);
  if (!data) throw strategyError(404, "STRATEGY_NOT_FOUND", "Strategy not found.");
  return data;
}

async function ownedBinding(supabase, userId, strategyId, bindingId) {
  const { data, error } = await supabase.from("strategy_target_bindings").select("*").eq("id", bindingId).eq("strategy_id", strategyId).eq("owner_user_id", userId).neq("status", "DISCONNECTED").maybeSingle();
  if (error) throw persistenceError(error);
  if (!data) throw strategyError(404, "STRATEGY_TARGET_NOT_FOUND", "Strategy target not found.");
  return data;
}

async function ownedBindingAny(supabase, userId, strategyId, bindingId) {
  const { data, error } = await supabase.from("strategy_target_bindings").select("*").eq("id", bindingId).eq("strategy_id", strategyId).eq("owner_user_id", userId).maybeSingle();
  if (error) throw persistenceError(error);
  if (!data) throw strategyError(404, "STRATEGY_TARGET_NOT_FOUND", "Strategy target not found.");
  return data;
}

function safeStrategySummary(row) {
  // These columns are authoritative lifecycle state. Falling back to
  // current_version makes a merely published version look started and causes
  // the client to skip black_core_start_strategy_version, leaving no runtime
  // row for the VPS worker to lease.
  const publishedVersion = row.published_version ?? null;
  const runningVersion = row.running_version ?? null;
  return {
    id: row.id,
    name: row.name,
    runtimeKind: row.runtime_kind,
    symbol: row.symbol,
    timeframe: row.timeframe,
    marketType: row.market_type,
    exchange: row.exchange,
    currentVersion: row.current_version,
    publishedVersion,
    runningVersion,
    draftRevision: Number(row.draft_revision || 0),
    draftUpdatedAt: row.draft_updated_at || null,
    hasDraftChanges: row.draft_definition
      ? canonicalRequestHash({ name: row.draft_name || row.name, definition: row.draft_definition }) !== canonicalRequestHash({ name: row.name, definition: row.definition })
      : false,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeStrategy(row) {
  return {
    ...safeStrategySummary(row),
    definition: row.definition,
    draftDefinition: row.draft_definition || row.definition,
    draftName: row.draft_name || row.name,
    draftBaseVersion: row.draft_base_version ?? row.published_version ?? null,
    globalCapitalPolicy: row.global_capital_policy
  };
}

function safeGroupDeskStrategy(row) {
  const definition = row.definition || {};
  const indicator = definition.indicator && typeof definition.indicator === "object"
    ? {
        indicatorId: definition.indicator.indicatorId,
        instanceId: definition.indicator.instanceId,
        name: definition.indicator.name,
        instanceName: definition.indicator.instanceName,
        version: definition.indicator.version,
        settingsHash: definition.indicator.settingsHash,
        settingsSummary: definition.indicator.settingsSummary,
        alertManifestVersion: definition.indicator.alertManifestVersion,
        runtimeVersion: definition.indicator.runtimeVersion,
        warmupBars: definition.indicator.warmupBars,
        runtimeStatus: definition.indicator.runtimeStatus,
        useCurrentChartSettings: false,
        alerts: []
      }
    : undefined;
  return {
    ...safeStrategySummary(row),
    definition: {
      runtimeKind: definition.runtimeKind || row.runtime_kind,
      symbol: row.symbol,
      timeframe: row.timeframe,
      marketType: row.market_type,
      exchange: row.exchange,
      settings: {},
      execution: {},
      indicator,
      metadata: { description: "Investment Group automated strategy execution projection." }
    },
    globalCapitalPolicy: row.global_capital_policy
  };
}

function runtimeLabel(kind) {
  if (kind === "builtin-ema-cross") return "EMA Cross Baseline";
  if (kind === "builtin-adaptive-swing") return "Hidden Distribution Swing";
  if (kind === "builtin-superatr-seven-step") return "SuperATR 7-Step Profit";
  if (kind === "python-script") return "Python Indicator";
  return "External Indicator";
}

function operationalVersion(strategy) {
  const version = strategy.running_version ?? strategy.published_version ?? strategy.current_version;
  if (!Number.isInteger(Number(version)) || Number(version) < 1) {
    throw strategyError(409, "STRATEGY_VERSION_NOT_PUBLISHED", "Publish a strategy version before configuring Paper or live targets.");
  }
  return Number(version);
}

function safeBinding(row) {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    slotIndex: row.slot_index,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.validation_snapshot?.targetLabel || null,
    targetProvider: row.validation_snapshot?.targetProvider || null,
    executionEnvironment: row.validation_snapshot?.targetEnvironment || null,
    connectionId: row.connection_id,
    accountId: row.account_id,
    groupId: row.group_id,
    marketType: row.market_type,
    status: row.status,
    capitalPolicyVersion: row.capital_policy_version,
    capitalPolicy: policyFromBinding(row),
    validation: row.validation_snapshot,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    armedAt: row.armed_at,
    disconnectedAt: row.disconnected_at
  };
}

function safePaperAccount(row) {
  const preview = calculateCapitalPreview({ equity: Number(row.demo_equity), availableBalance: Number(row.available_balance), policy: row.capital_policy, marketType: row.market_type });
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    marketType: row.market_type,
    status: row.status,
    demoEquity: Number(row.demo_equity),
    availableBalance: Number(row.available_balance),
    usedStrategyCapital: Number(row.used_strategy_capital),
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    fees: Number(row.fees),
    funding: Number(row.funding),
    capitalPolicyVersion: row.capital_policy_version,
    rowVersion: Number(row.state_version),
    capitalPolicy: row.capital_policy,
    maximumDrawdownPercent: Number(row.maximum_drawdown_percent),
    preview,
    updatedAt: row.updated_at
  };
}

function safeRuntime(row) {
  return { state: row.runtime_state, stateVersion: Number(row.state_version), lastClosedCandleAt: row.last_closed_candle_at, lastSignalAt: row.last_signal_at, lastHeartbeatAt: row.last_heartbeat_at, safeErrorCode: row.safe_error_code, updatedAt: row.updated_at };
}

export function authoritativeAccountMoney(row) {
  if (!row) return { equity: 0, available: 0, timestamp: null };
  const equity = Number(row.equity_usd);
  const available = Number(row.available_balance_usd);
  const timestamp = Date.parse(row.observed_at || row.captured_at || "");
  if (!Number.isFinite(equity) || !Number.isFinite(available) || !Number.isFinite(timestamp)) {
    return { equity: 0, available: 0, timestamp: null };
  }
  return {
    equity: Math.max(0, equity),
    available: Math.max(0, available),
    timestamp
  };
}

function calculateTradeAnalytics(rows) {
  const pnls = rows.map((row) => Number(row.net_pnl || 0));
  const grossPnls = rows.map((row) => row.gross_pnl == null ? Number(row.net_pnl || 0) : Number(row.gross_pnl || 0));
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let downsideSquares = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0);
    if (pnl < 0) downsideSquares += pnl * pnl;
  }
  for (const pnl of grossPnls) {
    if (pnl >= 0) grossProfit += pnl; else grossLoss += Math.abs(pnl);
  }
  const mean = pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : 0;
  const variance = pnls.length > 1 ? pnls.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pnls.length - 1) : 0;
  const standardDeviation = Math.sqrt(variance);
  const downsideDeviation = pnls.length ? Math.sqrt(downsideSquares / pnls.length) : 0;
  const netPnl = pnls.reduce((sum, value) => sum + value, 0);
  return {
    tradeCount: pnls.length,
    wins: pnls.filter((value) => value > 0).length,
    winRate: pnls.length ? pnls.filter((value) => value > 0).length / pnls.length * 100 : 0,
    grossPnl: grossPnls.reduce((sum, value) => sum + value, 0),
    netPnl,
    fees: rows.reduce((sum, row) => sum + Number(row.fees || 0), 0),
    funding: rows.reduce((sum, row) => sum + Number(row.funding || 0), 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    currentDrawdownPercent: peak > 0 ? (peak - equity) / peak * 100 : 0,
    maximumDrawdownPercent: maximumDrawdown,
    sharpe: standardDeviation > 0 ? mean / standardDeviation * Math.sqrt(Math.max(1, pnls.length)) : 0,
    sortino: downsideDeviation > 0 ? mean / downsideDeviation * Math.sqrt(Math.max(1, pnls.length)) : 0,
    calmar: maximumDrawdown > 0 ? netPnl / maximumDrawdown : 0
  };
}

export function resolveAccountEquityFreshness(row, now = Date.now()) {
  const money = authoritativeAccountMoney(row);
  if (!Number.isFinite(money.timestamp)) return "UNAVAILABLE";
  const age = now - money.timestamp;
  return age < -30_000 || age > ACCOUNT_EQUITY_STALE_MS ? "STALE" : "LIVE";
}

export function mergeFreshness(left, right) {
  const rank = { LIVE: 0, DEGRADED: 1, STALE: 2, UNAVAILABLE: 3 };
  return (rank[right] ?? rank.UNAVAILABLE) > (rank[left] ?? rank.UNAVAILABLE) ? right : left;
}

function resolveFreshness(staleAfter, healthStatus, reconciliationStatus, lastReconciledAt) {
  if (!healthStatus) return "UNAVAILABLE";
  if (staleAfter && Date.parse(staleAfter) < Date.now()) return "STALE";
  const reconciled = ["SYNCHRONIZED", "IDLE"].includes(String(reconciliationStatus || "")) && Number.isFinite(Date.parse(lastReconciledAt || ""));
  if (healthStatus !== "CONNECTED_CLOUD" || !reconciled) return "DEGRADED";
  return "LIVE";
}

function includesMarket(value, market) {
  const normalized = Array.isArray(value) ? value.map((item) => String(item).toUpperCase()) : [];
  if (market === "FUTURES") return normalized.some((item) => ["FUTURES", "FUTURE", "PERPETUAL", "PERP"].includes(item));
  return normalized.includes("SPOT");
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) result.set(row[key], [...(result.get(row[key]) || []), row]);
  return result;
}

export function latestRowsByKey(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const existing = result.get(row[key]);
    const rowTimestamp = timestampOf(row.observed_at || row.captured_at);
    const existingTimestamp = timestampOf(existing?.observed_at || existing?.captured_at);
    if (!existing || (!Number.isFinite(existingTimestamp) || rowTimestamp > existingTimestamp)) result.set(row[key], row);
  }
  return result;
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function many(query) {
  const { data, error } = await query;
  if (error) throw persistenceError(error);
  return data || [];
}

async function oneOrNone(query) {
  const { data, error } = await query;
  if (error) throw persistenceError(error);
  return data || null;
}

function persistenceError(cause) {
  const error = strategyError(503, "STRATEGY_PERSISTENCE_UNAVAILABLE", "Strategy automation storage is temporarily unavailable.");
  error.cause = cause;
  return error;
}

function paperMutationError(cause) {
  if (cause.code === "40001") return strategyError(409, "PAPER_TARGET_VERSION_CONFLICT", "Paper state changed elsewhere. Refresh and try again.");
  if (cause.code === "55000") return strategyError(409, "PAPER_RESET_OPEN_POSITION", "Pause and close the paper position before resetting the account.");
  if (cause.code === "22023" && String(cause.message).includes("idempotency")) return strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different paper action.");
  return persistenceError(cause);
}
