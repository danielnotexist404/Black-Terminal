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

const ACTIVE_ORDER_STATUSES = ["created", "pending", "open", "working", "partially-filled", "partially_filled", "triggered"];

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
  const [risks, balances, managedGroups, groupStats, mandates] = await Promise.all([
    many(supabase.from("account_risk_controls").select("*").in("account_id", accountIds)),
    many(supabase.from("account_balances").select("account_id,asset,free,locked,total,usd_value").in("account_id", accountIds)),
    many(supabase.from("investment_groups").select("id,firm_name,status").in("id", scopedGroupIds)),
    many(supabase.from("investment_group_stats").select("*").in("group_id", scopedGroupIds)),
    many(supabase.from("group_execution_mandates").select("id,group_id,status,broker_connection_id,allocation_method,allocation_value,max_leverage,paused_at,expires_at").in("group_id", scopedGroupIds))
  ]);
  const accountMap = new Map(accounts.map((item) => [item.id, item]));
  const capabilityMap = new Map(capabilities.map((item) => [item.connection_id, item]));
  const riskMap = new Map(risks.map((item) => [item.account_id, item]));
  const balanceMap = groupBy(balances, "account_id");
  let existingQuery = supabase.from("strategy_target_bindings").select("id,target_type,target_id,status").eq("strategy_id", strategyId).eq("strategy_version", operationalVersion(strategy)).neq("status", "DISCONNECTED");
  if (excludeBindingId) existingQuery = existingQuery.neq("id", excludeBindingId);
  const existing = await many(existingQuery);
  const conflicts = new Set(existing.map((item) => `${item.target_type}:${item.target_id}`));
  const brokerAccounts = connections.filter((item) => item.account_id).map((connection) => {
    const account = accountMap.get(connection.account_id);
    const capability = capabilityMap.get(connection.id);
    const risk = riskMap.get(connection.account_id);
    const amounts = summarizeBalances(balanceMap.get(connection.account_id) || []);
    const validation = validateBrokerEligibility({ connection, account, capability, strategy, conflict: conflicts.has(`BROKER_ACCOUNT:${connection.id}`), environment });
    return {
      targetId: connection.id,
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
    p_validation: { ...candidate.validation, targetLabel: candidate.label, targetProvider: candidate.provider || null },
    p_canonical_hash: canonicalHash,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "23505") throw strategyError(409, "STRATEGY_TARGET_CONFLICT", "The slot or target is already occupied.");
    if (error.code === "23514") throw strategyError(409, "STRATEGY_TARGET_CAPACITY_REACHED", "All ten live target slots are occupied.");
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
  assertPolicyWithinGlobal(nextPolicy, strategy.global_capital_policy, binding.market_type);
  const increased = riskIncrease(policyFromBinding(binding), nextPolicy, binding.market_type);
  const requestHash = canonicalRequestHash({ action: "UPDATE_POLICY", expectedVersion: Number(body.expectedVersion), policy: nextPolicy });
  const { error } = await supabase.rpc("black_core_update_strategy_target_policy", {
    p_owner_user_id: userId,
    p_strategy_id: strategyId,
    p_binding_id: bindingId,
    p_expected_row_version: Number(body.expectedVersion),
    p_policy: nextPolicy,
    p_canonical_hash: canonicalRequestHash(nextPolicy),
    p_risk_increased: increased,
    p_request_hash: requestHash,
    p_idempotency_key: idempotencyKey
  });
  if (error) {
    if (error.code === "40001") throw strategyError(409, "STRATEGY_TARGET_VERSION_CONFLICT", "Target settings changed elsewhere. Refresh and try again.");
    if (error.code === "22023" && String(error.message).includes("idempotency")) throw strategyError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key was already used for a different target mutation.");
    throw persistenceError(error);
  }
  return getBinding(supabase, userId, strategyId, bindingId);
}

export async function setTargetState(supabase, userId, strategyId, bindingId, action, expectedVersion, idempotencyKey, environment = process.env) {
  const binding = await ownedBinding(supabase, userId, strategyId, bindingId);
  let validation = {};
  if (action === "arm") {
    if (Number(expectedVersion) === Number(binding.row_version)) {
      if (binding.status !== "READY") throw strategyError(409, "STRATEGY_TARGET_STATE_CONFLICT", "Only a ready target can be activated.");
      validation = await validateExistingBinding(supabase, userId, strategyId, binding, environment);
      const connection = await oneOrNone(supabase.from("connectivity_connections").select("execution_environment").eq("id", binding.connection_id).eq("user_id", userId).maybeSingle());
      assertCanArmStrategyTarget({
        policy: policyFromBinding(binding),
        marketType: binding.market_type,
        validation,
        executionEnvironment: connection?.execution_environment,
        environment
      });
    }
  } else if (action === "resume") {
    if (Number(expectedVersion) === Number(binding.row_version)) {
      if (binding.status !== "PAUSED") throw strategyError(409, "STRATEGY_TARGET_STATE_CONFLICT", "Only a paused target can be resumed.");
      validation = await validateExistingBinding(supabase, userId, strategyId, binding, environment);
      if (!validation.eligible) throw strategyError(409, "STRATEGY_TARGET_VALIDATION_FAILED", "The target cannot resume until validation succeeds.", { reasons: validation.reasons });
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
  const [balances, positions, orders, trades, risk, health] = await Promise.all([
    many(supabase.from("account_balances").select("asset,free,locked,total,usd_value,updated_at").eq("account_id", binding.account_id)),
    many(supabase.from("account_positions").select("unrealized_pnl,realized_pnl,margin,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("execution_orders").select("status,updated_at").eq("strategy_target_binding_id", binding.id)),
    many(supabase.from("strategy_automation_trades").select("gross_pnl,net_pnl,fees,funding,closed_at").eq("binding_id", binding.id).eq("owner_user_id", userId).order("closed_at", { ascending: true }).limit(5000)),
    oneOrNone(supabase.from("account_risk_controls").select("max_leverage,max_daily_loss_usd,max_portfolio_exposure_usd,emergency_stop").eq("account_id", binding.account_id).maybeSingle()),
    oneOrNone(supabase.from("broker_connection_health").select("health_status,private_stream_status,reconciliation_status,last_private_event_at,last_reconciled_at,stale_after,captured_at").eq("connection_id", binding.connection_id).order("captured_at", { ascending: false }).limit(1).maybeSingle())
  ]);
  const money = summarizeBalances(balances);
  const policy = policyFromBinding(binding);
  const effectiveLeverage = binding.market_type === "SPOT" ? 1 : calculateEffectiveLeverage({ requested: policy.requestedLeverage, targetMaximum: policy.maximumLeverage, accountRiskCap: risk?.max_leverage });
  const capital = calculateCapitalPreview({ equity: money.equity, availableBalance: money.available, policy, marketType: binding.market_type, caps: { accountRiskCap: risk?.max_leverage } });
  const analytics = calculateTradeAnalytics(trades);
  const unrealized = positions.reduce((sum, item) => sum + Number(item.unrealized_pnl || 0), 0);
  const freshness = resolveFreshness(health?.stale_after, health?.health_status, health?.reconciliation_status);
  const snapshot = {
    bindingId: binding.id,
    slotIndex: binding.slot_index,
    timestamp: Date.now(),
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
    protectionHealth: risk?.emergency_stop ? "EMERGENCY_STOP" : "MONITORED"
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
  const balances = accountIds.length ? await many(supabase.from("account_balances").select("account_id,free,total,usd_value").in("account_id", accountIds)) : [];
  const moneyByAccount = new Map(accountIds.map((accountId) => [accountId, summarizeBalances(balances.filter((item) => item.account_id === accountId))]));
  const connectionMap = new Map(connections.map((item) => [item.id, item]));
  let connectedAllocatedEquity = 0;
  const leverageCaps = [];
  for (const mandate of active) {
    const connection = connectionMap.get(mandate.broker_connection_id);
    const money = moneyByAccount.get(connection?.account_id) || { equity: 0 };
    connectedAllocatedEquity += mandate.allocation_method === "FIXED_NOTIONAL" ? Math.min(money.equity, Number(mandate.allocation_value)) : money.equity * Number(mandate.allocation_value) / 100;
    leverageCaps.push(Number(mandate.max_leverage || 1));
  }
  const degraded = connections.filter((item) => item.worker_state !== "LIVE" || item.synchronization_state !== "SYNCHRONIZED" || item.execution_readiness !== "READY").length;
  const policy = policyFromBinding(binding);
  const analytics = calculateTradeAnalytics(trades);
  const unrealized = positions.reduce((sum, item) => sum + Number(item.unrealized_pnl || 0), 0);
  const usedStrategyCapital = positions.reduce((sum, item) => sum + Number(item.margin || 0), 0);
  const allocatedStrategyCapital = policy.strategyAllocationMode === "FIXED_USDT" ? Math.min(connectedAllocatedEquity, policy.strategyAllocationValue) : connectedAllocatedEquity * policy.strategyAllocationValue / 100;
  const snapshot = {
    bindingId: binding.id,
    slotIndex: binding.slot_index,
    timestamp: Date.now(),
    freshness: active.length && degraded === 0 ? "LIVE" : active.length ? "DEGRADED" : "UNAVAILABLE",
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
    protectionHealth: active.length ? "MANDATE_BOUNDED" : "UNAVAILABLE"
  };
  await persistSnapshot(supabase, userId, binding, snapshot, snapshot.freshness);
  return snapshot;
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
  if (connection.execution_environment !== "DEMO" || account?.execution_environment !== "DEMO") reasons.push("Strategy automation currently requires a Bybit Demo Trading account.");
  if (conflict) reasons.push("This account already occupies a target slot in this strategy version.");
  if (environment.STRATEGY_AUTOMATION_TARGET_CONFIGURATION_ENABLED === "false") reasons.push("Strategy target configuration is disabled by rollout policy.");
  if (environment.STRATEGY_AUTOMATION_DEMO_EXECUTION_ENABLED !== "true") reasons.push("Bybit Demo strategy execution is disabled by rollout policy.");
  return { eligible: reasons.length === 0, reasons, checkedAt: new Date().toISOString(), withdrawalPermission: "NONE" };
}

function validateGroupEligibility({ group, activeMandates, conflict, environment }) {
  const reasons = [];
  if (group.status !== "active") reasons.push("Investment Group is not active.");
  if (environment.INVESTMENT_GROUP_EXECUTION_ENABLED !== "true") reasons.push("Investment Group execution is disabled by rollout policy.");
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
  const publishedVersion = row.published_version ?? (row.status === "DRAFT" ? null : row.current_version ?? null);
  const runningVersion = row.running_version ?? (row.status === "DRAFT" ? null : row.current_version ?? null);
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

function runtimeLabel(kind) {
  if (kind === "builtin-ema-cross") return "EMA Cross Baseline";
  if (kind === "builtin-adaptive-swing") return "Hidden Distribution Swing";
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

function summarizeBalances(rows) {
  let equity = 0;
  let available = 0;
  for (const row of rows) {
    const totalUsd = row.usd_value == null ? (String(row.asset).toUpperCase() === "USDT" || String(row.asset).toUpperCase() === "USDC" ? Number(row.total || 0) : 0) : Number(row.usd_value || 0);
    const total = Number(row.total || 0);
    const free = Number(row.free || 0);
    equity += totalUsd;
    available += total > 0 ? totalUsd * Math.max(0, Math.min(1, free / total)) : 0;
  }
  return { equity, available };
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

function resolveFreshness(staleAfter, healthStatus, reconciliationStatus) {
  if (!healthStatus) return "UNAVAILABLE";
  if (staleAfter && Date.parse(staleAfter) < Date.now()) return "STALE";
  if (healthStatus !== "CONNECTED_CLOUD" || reconciliationStatus !== "SYNCHRONIZED") return "DEGRADED";
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
