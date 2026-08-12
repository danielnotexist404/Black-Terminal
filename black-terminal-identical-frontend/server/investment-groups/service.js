import { hashCanonicalPayload } from "../cloud-execution/canonical.js";
import {
  aggregateMemberSnapshots,
  assertManagerLeverageRequest,
  coarseMembershipStatus,
  normalizeRiskPolicy,
  policyError,
  validateRiskAcknowledgement
} from "./policy.js";

const ACTIVE_MEMBER_STATES = new Set(["ACTIVE", "PAUSED_BY_USER", "PAUSED_BY_MANAGER", "RISK_SUSPENDED", "LEAVING"]);
const PENDING_MEMBER_STATES = new Set(["RISK_ACCEPTED", "METHOD_SELECTED", "CONFIGURING", "PENDING_APPROVAL", "APPROVED", "ACTIVATING"]);
const ACTIONABLE_PLAN_STATES = ["PENDING", "QUEUED"];
const ACTIONABLE_COMMAND_STATES = ["QUEUED", "RETRY"];

export async function listInvestmentGroupWorkspace(supabase, user) {
  const [groupsResult, membershipsResult, invitesResult] = await Promise.all([
    supabase.from("investment_groups").select("*,investment_group_stats(*)").eq("status", "active").order("created_at", { ascending: false }),
    supabase.from("investment_group_members").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
    supabase.from("investment_group_invites").select("group_id").eq("recipient_user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString())
  ]);
  throwResult(groupsResult);
  throwResult(membershipsResult);
  throwResult(invitesResult);
  const memberships = membershipsResult.data || [];
  const relatedIds = new Set(memberships.map((row) => row.group_id));
  const invitedGroupIds = new Set((invitesResult.data || []).map((row) => row.group_id));
  const groups = (groupsResult.data || []).filter((group) => group.visibility === "public" || group.owner_user_id === user.id || relatedIds.has(group.id) || invitedGroupIds.has(group.id));
  const ownerIds = [...new Set(groups.map((group) => group.owner_user_id).filter(Boolean))];
  const profilesResult = ownerIds.length
    ? await supabase.from("profiles_extended").select("user_id,handle,display_name,avatar_storage_path,verified_role").in("user_id", ownerIds).is("deleted_at", null)
    : { data: [], error: null };
  throwResult(profilesResult);
  const profileMap = new Map((profilesResult.data || []).map((row) => [row.user_id, row]));
  const membershipMap = new Map(memberships.map((row) => [row.group_id, row]));
  const membershipIds = memberships.map((row) => row.id);
  const [snapshotsResult, policiesResult, mandatesResult] = membershipIds.length ? await Promise.all([
    supabase.from("group_member_portfolio_snapshots").select("*").in("membership_id", membershipIds),
    supabase.from("group_member_risk_policies").select("*").in("membership_id", membershipIds),
    supabase.from("group_execution_mandates").select("id,membership_id,status,broker_connection_id,execution_mode,accepted_at,expires_at").eq("follower_user_id", user.id)
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  for (const result of [snapshotsResult, policiesResult, mandatesResult]) throwResult(result);
  const snapshotMap = new Map((snapshotsResult.data || []).map((row) => [row.membership_id, row]));
  const policyMap = new Map((policiesResult.data || []).map((row) => [row.membership_id, row]));
  const mandateMap = new Map((mandatesResult.data || []).map((row) => [row.membership_id, row]));
  const mapped = groups.map((group) => {
    const membership = membershipMap.get(group.id);
    const snapshot = membership && snapshotMap.get(membership.id);
    const policy = membership && policyMap.get(membership.id);
    const mandate = membership && mandateMap.get(membership.id);
    return {
      ...mapGroup(group, profileMap.get(group.owner_user_id), membership, user.id, undefined, invitedGroupIds.has(group.id)),
      memberCapital: membership ? {
        allocatedEquity: snapshot ? Number(snapshot.allocated_equity) : null,
        realizedPnl: snapshot ? Number(snapshot.realized_pnl) : null,
        unrealizedPnl: snapshot ? Number(snapshot.unrealized_pnl) : null,
        netPnl: snapshot ? Number(snapshot.net_pnl) : null,
        drawdownPercent: snapshot ? numberOrNull(snapshot.current_drawdown_percent) : null,
        activePositions: snapshot ? Number(snapshot.open_position_count) : null,
        freshness: snapshot?.freshness || "STALE",
        allocationPercent: policy ? Number(policy.allocation_percent) : null,
        effectiveLeverage: policy ? Number(policy.effective_leverage) : null,
        mandateStatus: mandate?.status || null,
        executionMode: mandate?.execution_mode || null
      } : null
    };
  });
  return {
    discover: mapped.filter((group) => group.visibility === "public" || group.validInvite),
    joined: mapped.filter((group) => group.membership && group.membership.role === "member" && !["LEFT", "REMOVED", "REJECTED", "EXPIRED"].includes(group.membership.state)),
    managed: mapped.filter((group) => group.ownerUserId === user.id || ["owner", "manager"].includes(group.membership?.role)),
    pending: mapped.filter((group) => PENDING_MEMBER_STATES.has(group.membership?.state))
  };
}

export async function getInvestmentGroupDetail(supabase, user, groupId) {
  const [group, membership, disclosure, invite] = await Promise.all([
    requiredSingle(supabase.from("investment_groups").select("*,investment_group_stats(*)").eq("id", groupId), "Investment Group not found."),
    maybeSingle(supabase.from("investment_group_members").select("*").eq("group_id", groupId).eq("user_id", user.id)),
    maybeSingle(supabase.from("group_risk_disclosure_documents").select("version,locale,title,document_text,mandatory_acknowledgements,document_hash,effective_at").eq("status", "ACTIVE").order("effective_at", { ascending: false }).limit(1)),
    maybeSingle(supabase.from("investment_group_invites").select("id").eq("group_id", groupId).eq("recipient_user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString()))
  ]);
  if (group.visibility !== "public" && group.owner_user_id !== user.id && !membership && !invite) throw policyError(403, "This Investment Group is not visible to your account.", "GROUP_NOT_VISIBLE");
  const profile = await maybeSingle(supabase.from("profiles_extended").select("user_id,handle,display_name,headline,bio,avatar_storage_path,verified_role").eq("user_id", group.owner_user_id));
  const [capacityResult, eligibility, draft, acknowledgement] = await Promise.all([
    supabase.from("investment_group_members").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("status", "active"),
    listEligibleConnections(supabase, user.id, group, membership?.id),
    maybeSingle(supabase.from("investment_group_join_drafts").select("*").eq("group_id", groupId).eq("user_id", user.id).gt("expires_at", new Date().toISOString())),
    disclosure ? maybeSingle(supabase.from("group_risk_acknowledgements").select("id,disclosure_version,document_hash,accepted_at").eq("group_id", groupId).eq("user_id", user.id).eq("disclosure_version", disclosure.version)) : null
  ]);
  throwResult(capacityResult);
  const memberCount = capacityResult.count || 0;
  return {
    group: mapGroup(group, profile, membership, user.id, memberCount, Boolean(invite)),
    owner: profile ? { handle: profile.handle, displayName: profile.display_name, headline: profile.headline, bio: profile.bio, verified: Boolean(profile.verified_role) } : null,
    riskDocument: disclosure ? {
      version: disclosure.version,
      locale: disclosure.locale,
      title: disclosure.title,
      text: disclosure.document_text,
      acknowledgementKeys: disclosure.mandatory_acknowledgements,
      documentHash: disclosure.document_hash,
      effectiveAt: disclosure.effective_at,
      legalReviewRequired: true
    } : null,
    riskAcknowledged: Boolean(acknowledgement),
    eligibleConnections: eligibility.connections,
    eligibility: eligibility.summary,
    joinDraft: draft ? mapJoinDraft(draft) : null,
    capacity: { current: memberCount, maximum: group.max_followers, available: !group.max_followers || memberCount < Number(group.max_followers) }
  };
}

export async function acknowledgeGroupRisk(supabase, user, groupId, input) {
  const group = await requireActiveGroup(supabase, groupId);
  await assertGroupVisible(supabase, user, group);
  const document = await maybeSingle(supabase.from("group_risk_disclosure_documents").select("*").eq("status", "ACTIVE").eq("version", input.version));
  if (!document) throw policyError(503, "No active risk disclosure is available.", "RISK_DISCLOSURE_UNAVAILABLE");
  validateRiskAcknowledgement(input, document);
  const acceptedAt = new Date().toISOString();
  const snapshot = Object.fromEntries(document.mandatory_acknowledgements.map((key) => [key, true]));
  const acknowledgement = await upsertSingle(supabase.from("group_risk_acknowledgements"), {
    user_id: user.id,
    group_id: group.id,
    participation_method: input.participationMethod || null,
    disclosure_version: document.version,
    document_hash: document.document_hash,
    locale: String(input.locale || document.locale || "en").slice(0, 16),
    acknowledgement_snapshot: snapshot,
    application_version: String(input.applicationVersion || "web-preview").slice(0, 80),
    accepted_at: acceptedAt
  }, { onConflict: "user_id,group_id,disclosure_version" });
  await upsertSingle(supabase.from("investment_group_join_drafts"), {
    user_id: user.id,
    group_id: group.id,
    risk_acknowledgement_id: acknowledgement.id,
    current_step: "RISK_ACCEPTED",
    participation_method: input.participationMethod || null,
    safe_configuration: {},
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
  }, { onConflict: "user_id,group_id" });
  await writeAudit(supabase, {
    userId: user.id, groupId, eventType: "GROUP_RISK_ACKNOWLEDGED", message: "The member accepted the current versioned Investment Group risk disclosure.",
    metadata: { disclosureVersion: document.version, documentHash: document.document_hash, locale: input.locale || document.locale }
  });
  return { id: acknowledgement.id, version: document.version, documentHash: document.document_hash, acceptedAt };
}

export async function getOrSaveJoinDraft(supabase, user, groupId, input) {
  const group = await requireActiveGroup(supabase, groupId);
  await assertGroupVisible(supabase, user, group);
  if (!input) {
    const draft = await maybeSingle(supabase.from("investment_group_join_drafts").select("*").eq("group_id", groupId).eq("user_id", user.id).gt("expires_at", new Date().toISOString()));
    return draft ? mapJoinDraft(draft) : null;
  }
  const current = await maybeSingle(supabase.from("investment_group_join_drafts").select("*").eq("group_id", groupId).eq("user_id", user.id));
  if (!current?.risk_acknowledgement_id) throw policyError(409, "Accept the active risk disclosure before saving method configuration.", "RISK_ACKNOWLEDGEMENT_REQUIRED");
  const method = String(input.participationMethod || current.participation_method || "").toUpperCase();
  if (!["COPY_TRADING", "OBSIDIAN_VAULT"].includes(method)) throw policyError(400, "Select one participation method.", "PARTICIPATION_METHOD_INVALID");
  const safeConfiguration = sanitizeJoinDraft(input.configuration || {});
  const currentStep = String(input.currentStep || (Object.keys(safeConfiguration).length ? "CONFIGURING" : "METHOD_SELECTED")).toUpperCase();
  if (!["METHOD_SELECTED", "CONFIGURING", "REVIEW"].includes(currentStep)) throw policyError(400, "Unsupported join-draft step.", "JOIN_DRAFT_STEP_INVALID");
  const saved = await upsertSingle(supabase.from("investment_group_join_drafts"), {
    user_id: user.id,
    group_id: groupId,
    risk_acknowledgement_id: current.risk_acknowledgement_id,
    current_step: currentStep,
    participation_method: method,
    safe_configuration: safeConfiguration,
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
  }, { onConflict: "user_id,group_id" });
  return mapJoinDraft(saved);
}

export async function joinInvestmentGroup(supabase, user, groupId, input) {
  const group = await requireActiveGroup(supabase, groupId);
  await assertGroupVisible(supabase, user, group);
  requireIdempotency(input.idempotencyKey);
  if (group.owner_user_id === user.id) throw policyError(409, "The group owner already has manager access.", "OWNER_CANNOT_JOIN");
  const method = String(input.participationMethod || "").toUpperCase();
  if (method === "OBSIDIAN_VAULT") throw policyError(409, "Obsidian Vault is a future research protocol and cannot accept deposits or activate membership.", "OBSIDIAN_RESEARCH_ONLY");
  if (method !== "COPY_TRADING" || group.copy_trading_enabled !== true) throw policyError(409, "Copy Trading is unavailable for this Investment Group.", "COPY_TRADING_UNAVAILABLE");
  if (input.finalConsent !== true) throw policyError(400, "Explicit final Copy-Trading consent is required.", "FINAL_CONSENT_REQUIRED");
  let acceptedInvite = null;
  if (group.access_mode === "invite_only") {
    acceptedInvite = await maybeSingle(supabase.from("investment_group_invites").select("id,status,expires_at").eq("group_id", groupId).eq("recipient_user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString()));
    if (!acceptedInvite) throw policyError(403, "A valid Investment Group invitation is required.", "GROUP_INVITE_REQUIRED");
  }
  if (group.password_hash && group.password_hash !== input.passwordHash) throw policyError(403, "Investment Group password check failed.", "GROUP_PASSWORD_INVALID");
  const disclosure = await maybeSingle(supabase.from("group_risk_disclosure_documents").select("*").eq("status", "ACTIVE").order("effective_at", { ascending: false }).limit(1));
  const acknowledgement = disclosure && await maybeSingle(supabase.from("group_risk_acknowledgements").select("*").eq("user_id", user.id).eq("group_id", groupId).eq("disclosure_version", disclosure.version).eq("document_hash", disclosure.document_hash));
  if (!acknowledgement) throw policyError(409, "Accept the current versioned risk disclosure before joining.", "RISK_ACKNOWLEDGEMENT_REQUIRED");
  throwResult(await supabase.from("group_risk_acknowledgements").update({ participation_method: method }).eq("id", acknowledgement.id).eq("user_id", user.id));
  const existing = await maybeSingle(supabase.from("investment_group_members").select("*").eq("group_id", groupId).eq("user_id", user.id));
  if (existing?.idempotency_key === input.idempotencyKey) return { membership: mapMembership(existing), idempotent: true };
  if (existing && (ACTIVE_MEMBER_STATES.has(existing.membership_state) || PENDING_MEMBER_STATES.has(existing.membership_state))) {
    throw policyError(409, "An active or pending membership already exists for this Investment Group.", "MEMBERSHIP_ALREADY_EXISTS");
  }
  if (existing?.membership_state === "REMOVED") throw policyError(403, "A removed member cannot rejoin without an explicit manager invitation.", "MEMBERSHIP_REMOVED");
  if (existing) throw policyError(409, "A terminal membership record cannot be overwritten; a new manager-reviewed membership cycle is required.", "MEMBERSHIP_REJOIN_REQUIRES_REVIEW");

  const policy = normalizeRiskPolicy(input.riskPolicy || {}, { groupMaxLeverage: group.group_max_leverage, maximumAllocationPercent: 100 });
  const eligibility = await listEligibleConnections(supabase, user.id, group, existing?.id);
  const selected = eligibility.connections.find((connection) => connection.id === input.connectionId);
  if (!selected?.eligible) throw policyError(409, "The selected broker connection is not eligible for persistent Copy Trading.", "BROKER_CONNECTION_INELIGIBLE", { blockers: selected?.blockers || ["CONNECTION_NOT_FOUND"] });
  if (selected.equity <= 0) throw policyError(409, "Synchronized account equity is required before the mandate can be sized.", "ACCOUNT_EQUITY_UNAVAILABLE");
  const activeCount = await countRows(supabase.from("investment_group_members").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("status", "active"));
  if (group.max_followers && activeCount >= Number(group.max_followers)) throw policyError(409, "This Investment Group has reached member capacity.", "GROUP_CAPACITY_REACHED");

  const autoAccept = (group.access_mode === "open" || (group.access_mode === "invite_only" && Boolean(acceptedInvite))) && group.approval_required === false;
  const membershipState = autoAccept ? "ACTIVATING" : "PENDING_APPROVAL";
  const finalMembershipState = autoAccept ? "ACTIVE" : membershipState;
  const now = new Date().toISOString();
  const membership = await upsertSingle(supabase.from("investment_group_members"), {
    ...(existing?.id ? { id: existing.id } : {}),
    group_id: groupId,
    user_id: user.id,
    role: "member",
    status: coarseMembershipStatus(membershipState),
    participation_method: method,
    membership_state: membershipState,
    risk_acknowledgement_version: acknowledgement.disclosure_version,
    broker_connection_id: selected.id,
    portfolio_visibility: policy.portfolioVisibility,
    idempotency_key: input.idempotencyKey,
    joined_at: null,
    paused_at: null,
    left_at: null,
    removed_at: null,
    updated_at: now
  }, { onConflict: "group_id,user_id" });

  const managerRequested = Math.min(policy.userMaximumLeverage, Number(group.group_max_leverage));
  const effectiveLeverage = Math.min(managerRequested, policy.userMaximumLeverage, Number(group.group_max_leverage), selected.emsRiskCap, selected.exchangeLeverageCap);
  const riskRow = await upsertSingle(supabase.from("group_member_risk_policies"), {
    membership_id: membership.id,
    version: 1,
    allocation_percent: policy.allocationPercent,
    user_maximum_leverage: policy.userMaximumLeverage,
    manager_requested_leverage: managerRequested,
    effective_leverage: effectiveLeverage,
    maximum_position_equity_percent: policy.maximumPositionEquityPercent,
    maximum_total_exposure_percent: policy.maximumTotalExposurePercent,
    maximum_daily_loss_percent: policy.maximumDailyLossPercent,
    maximum_drawdown_percent: policy.maximumDrawdownPercent,
    allowed_symbols: policy.allowedSymbols,
    allowed_market_types: policy.allowedMarketTypes,
    long_enabled: policy.longEnabled,
    short_enabled: policy.shortEnabled,
    allowed_order_types: policy.allowedOrderTypes,
    margin_mode: policy.marginMode,
    maximum_slippage_bps: policy.maximumSlippageBps,
    exit_policy: policy.exitPolicy,
    updated_by_user_id: user.id,
    user_consented_at: now
  }, { onConflict: "membership_id" });
  const riskSnapshot = { ...riskRow };
  await upsertSingle(supabase.from("group_member_risk_policy_versions"), {
    risk_policy_id: riskRow.id,
    membership_id: membership.id,
    version: riskRow.version,
    policy_snapshot: riskSnapshot,
    canonical_hash: hashCanonicalPayload(riskSnapshot),
    actor_user_id: user.id,
    reason: "Initial member-signed Copy-Trading risk policy.",
    correlation_id: input.idempotencyKey
  }, { onConflict: "risk_policy_id,version" });
  await upsertSingle(supabase.from("group_member_portfolio_visibility"), {
    membership_id: membership.id,
    visibility: policy.portfolioVisibility,
    consented_by_user_id: user.id,
    consented_at: now,
    revoked_at: null,
    updated_at: now
  }, { onConflict: "membership_id" });

  const mandatePayload = {
    group_id: groupId,
    follower_user_id: user.id,
    broker_connection_id: selected.id,
    broker_account_id: selected.accountId,
    membership_id: membership.id,
    status: autoAccept ? "ACTIVE" : "PENDING_CONSENT",
    execution_mode: selected.connectionMode,
    allocation_method: "EQUITY_PERCENT",
    allocation_value: policy.allocationPercent,
    max_order_notional: selected.equity * policy.maximumPositionEquityPercent / 100,
    max_total_exposure: selected.equity * policy.maximumTotalExposurePercent / 100,
    max_daily_loss: selected.equity * policy.maximumDailyLossPercent / 100,
    max_drawdown: policy.maximumDrawdownPercent,
    max_leverage: policy.userMaximumLeverage,
    manager_requested_leverage: managerRequested,
    effective_leverage: effectiveLeverage,
    maximum_position_equity_percent: policy.maximumPositionEquityPercent,
    maximum_total_exposure_percent: policy.maximumTotalExposurePercent,
    maximum_daily_loss_percent: policy.maximumDailyLossPercent,
    maximum_drawdown_percent: policy.maximumDrawdownPercent,
    allowed_symbols: policy.allowedSymbols,
    allowed_market_types: policy.allowedMarketTypes,
    allowed_order_types: policy.allowedOrderTypes,
    allowed_directions: [policy.longEnabled ? "LONG" : null, policy.shortEnabled ? "SHORT" : null].filter(Boolean),
    margin_mode: policy.marginMode,
    allow_overnight: true,
    allow_weekend: true,
    allow_reduce_only: true,
    allow_position_reversal: false,
    allow_open_positions: true,
    allow_close_positions: true,
    allow_modify_protection: true,
    allow_withdrawals: false,
    allow_asset_transfers: false,
    protective_orders_required: false,
    slippage_limit_bps: policy.maximumSlippageBps,
    exit_policy: policy.exitPolicy,
    portfolio_visibility: policy.portfolioVisibility,
    accepted_at: now,
    paused_at: null,
    revoked_at: null
  };
  mandatePayload.consent_hash = hashCanonicalPayload({ ...mandatePayload, disclosureVersion: acknowledgement.disclosure_version, idempotencyKey: input.idempotencyKey, withdrawalAuthority: "NEVER" });
  const mandate = await upsertSingle(supabase.from("group_execution_mandates"), mandatePayload, { onConflict: "group_id,follower_user_id,broker_connection_id" });
  const mandateSnapshot = { ...mandate, withdrawalAuthority: "NEVER" };
  await upsertSingle(supabase.from("group_execution_mandate_versions"), {
    mandate_id: mandate.id,
    version: mandate.mandate_version,
    follower_user_id: user.id,
    policy_snapshot: mandateSnapshot,
    canonical_hash: hashCanonicalPayload(mandateSnapshot),
    consent_evidence: { disclosureVersion: acknowledgement.disclosure_version, consentHash: mandate.consent_hash, acceptedAt: now, idempotencyKey: input.idempotencyKey }
  }, { onConflict: "mandate_id,version" });
  const updatedMembership = await updateSingle(supabase.from("investment_group_members").update({
    mandate_id: mandate.id,
    ...(autoAccept ? { membership_state: "ACTIVE", status: "active", joined_at: now } : {}),
    updated_at: now
  }).eq("id", membership.id), "Membership could not be linked to its mandate.");
  const existingRequest = await maybeSingle(supabase.from("investment_group_join_requests").select("*").eq("group_id", groupId).eq("user_id", user.id).eq("status", "pending"));
  if (!existingRequest) {
    await insertSingle(supabase.from("investment_group_join_requests"), {
      group_id: groupId, user_id: user.id, message: String(input.message || "").slice(0, 1000), status: autoAccept ? "approved" : "pending", reviewed_by: autoAccept ? user.id : null, reviewed_at: autoAccept ? now : null
    });
  }
  await insertSingle(supabase.from("group_member_status_history"), {
    membership_id: membership.id, group_id: groupId, user_id: user.id, actor_user_id: user.id,
    previous_state: existing?.membership_state || null, next_state: finalMembershipState,
    reason: autoAccept ? "Member completed an auto-accepted Copy-Trading application." : "Member submitted a manager-approval Copy-Trading application.", correlation_id: input.idempotencyKey
  });
  await writeAudit(supabase, {
    userId: user.id, connectionId: selected.id, groupId,
    eventType: autoAccept ? "GROUP_MEMBERSHIP_ACTIVATED" : "GROUP_JOIN_REQUESTED",
    message: autoAccept ? "Copy-Trading membership activated after eligibility, reconciliation and consent checks." : "Copy-Trading membership is pending manager approval.",
    metadata: { membershipId: membership.id, mandateId: mandate.id, method, withdrawalAuthority: "NEVER", state: finalMembershipState }
  });
  await notify(supabase, autoAccept ? user.id : group.owner_user_id, autoAccept ? "membership_activated" : "investment_group_join_request", autoAccept ? "Investment Group Membership Activated" : "Investment Group Join Request", autoAccept ? "Your Copy-Trading membership is active." : "A versioned Copy-Trading application requires review.", { groupId, membershipId: membership.id });
  if (acceptedInvite) throwResult(await supabase.from("investment_group_invites").update({ status: "accepted", accepted_at: now }).eq("id", acceptedInvite.id).eq("recipient_user_id", user.id).eq("status", "pending"));
  await supabase.from("investment_group_join_drafts").delete().eq("group_id", groupId).eq("user_id", user.id);
  return { membership: mapMembership(updatedMembership), mandate: mapMandate(mandate), pendingApproval: !autoAccept, idempotent: false };
}

export async function getMembershipWorkspace(supabase, user, groupId) {
  const membership = await maybeSingle(supabase.from("investment_group_members").select("*").eq("group_id", groupId).eq("user_id", user.id));
  if (!membership) return { membership: null };
  const [policy, mandate, positions, draft] = await Promise.all([
    maybeSingle(supabase.from("group_member_risk_policies").select("*").eq("membership_id", membership.id)),
    membership.mandate_id ? maybeSingle(supabase.from("group_execution_mandates").select("*").eq("id", membership.mandate_id).eq("follower_user_id", user.id)) : null,
    supabase.from("position_lifecycle_positions").select("id,symbol,direction,lifecycle_state,quantity,average_price,current_price,realized_pnl,unrealized_pnl,margin,leverage,liquidation_price,fees,funding,opened_at,updated_at").eq("membership_id", membership.id).neq("lifecycle_state", "archived"),
    maybeSingle(supabase.from("investment_group_join_drafts").select("*").eq("group_id", groupId).eq("user_id", user.id).gt("expires_at", new Date().toISOString()))
  ]);
  throwResult(positions);
  return { membership: mapMembership(membership), riskPolicy: mapRiskPolicy(policy), mandate: mapMandate(mandate), positions: positions.data || [], draft: draft ? mapJoinDraft(draft) : null };
}

export async function pauseOrResumeMembership(supabase, user, groupId, action, input = {}) {
  const membership = await requiredSingle(supabase.from("investment_group_members").select("*").eq("group_id", groupId).eq("user_id", user.id).eq("role", "member"), "Membership not found.");
  requireIdempotency(input.idempotencyKey);
  const now = new Date().toISOString();
  if (action === "pause") {
    if (membership.membership_state !== "ACTIVE") throw policyError(409, "Only an active membership can be paused by its member.", "MEMBERSHIP_NOT_ACTIVE");
    throwResult(await supabase.from("group_execution_mandates").update({ status: "PAUSED", paused_at: now }).eq("id", membership.mandate_id).eq("follower_user_id", user.id));
    await cancelPendingEntries(supabase, membership, "MEMBER_PAUSED");
    const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "PAUSED_BY_USER", status: "active", paused_at: now, updated_at: now }).eq("id", membership.id), "Membership pause failed.");
    await recordStateChange(supabase, membership, user.id, "PAUSED_BY_USER", "Member paused future Copy-Trading entries.", input.idempotencyKey);
    await writeAudit(supabase, { userId: user.id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBER_PAUSED_BY_USER", message: "Member paused future Copy-Trading entries immediately.", metadata: { membershipId: membership.id } });
    return mapMembership(updated);
  }
  if (membership.membership_state !== "PAUSED_BY_USER") throw policyError(409, "Only the member can resume a user-paused membership.", "MEMBERSHIP_RESUME_FORBIDDEN");
  const group = await requireActiveGroup(supabase, groupId);
  const eligibility = await listEligibleConnections(supabase, user.id, group, membership.id);
  const selected = eligibility.connections.find((connection) => connection.id === membership.broker_connection_id);
  if (!selected?.eligible) throw policyError(409, "Copy Trading cannot resume until the broker and Black Cloud are healthy and reconciled.", "BROKER_CONNECTION_INELIGIBLE", { blockers: selected?.blockers || [] });
  throwResult(await supabase.from("group_execution_mandates").update({ status: "ACTIVE", paused_at: null }).eq("id", membership.mandate_id).eq("follower_user_id", user.id));
  const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "ACTIVE", paused_at: null, updated_at: now }).eq("id", membership.id), "Membership resume failed.");
  await recordStateChange(supabase, membership, user.id, "ACTIVE", "Member resumed a user-paused Copy-Trading membership.", input.idempotencyKey);
  await writeAudit(supabase, { userId: user.id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBER_RESUMED", message: "Member resumed Copy Trading after a fresh eligibility check.", metadata: { membershipId: membership.id } });
  return mapMembership(updated);
}

export async function leaveInvestmentGroup(supabase, user, groupId, input) {
  requireIdempotency(input.idempotencyKey);
  const exitPolicy = String(input.exitPolicy || "DETACH").toUpperCase();
  if (exitPolicy === "CLOSE_NOW" && input.closePositionsConfirmed !== true) throw policyError(400, "Closing group-originated positions requires a second explicit confirmation.", "CLOSE_CONFIRMATION_REQUIRED");
  const { data, error } = await supabase.rpc("leave_investment_group_copy_trading", { p_user_id: user.id, p_group_id: groupId, p_exit_policy: exitPolicy, p_idempotency_key: input.idempotencyKey });
  if (error) throw error;
  if (exitPolicy === "CLOSE_NOW") {
    const positions = await supabase.from("position_lifecycle_positions").select("id").eq("group_id", groupId).eq("user_id", user.id).in("lifecycle_state", ["opening", "open", "protected", "scaling"]);
    throwResult(positions);
    if ((positions.data || []).length) {
      throw policyError(409, "Future-entry authority was revoked. Attributable positions remain detached because an exit-only OMS plan has not yet been created for them.", "EXIT_CLOSE_PLAN_REQUIRED", { futureEntryRevoked: true, positionCount: positions.data.length, membership: data });
    }
  }
  const group = await requireGroup(supabase, groupId);
  await notify(supabase, group.owner_user_id, "member_left", "Investment Group Member Left", "A member revoked future-entry authority and left Copy Trading.", { groupId, membershipId: data.membershipId });
  return data;
}

export async function joinObsidianWaitlist(supabase, user, groupId) {
  const group = await requireActiveGroup(supabase, groupId);
  await assertGroupVisible(supabase, user, group);
  if (group.obsidian_research_enabled !== true) throw policyError(409, "Obsidian research is unavailable for this group.", "OBSIDIAN_RESEARCH_UNAVAILABLE");
  const entry = await upsertSingle(supabase.from("obsidian_waitlist_entries"), { group_id: groupId, user_id: user.id, research_consent: true }, { onConflict: "group_id,user_id" });
  await writeAudit(supabase, { userId: user.id, groupId, eventType: "OBSIDIAN_WAITLIST_JOINED", message: "User joined the research-only Obsidian waitlist.", metadata: { entryId: entry.id, depositsAccepted: false, financialActivation: false } });
  return { joined: true, researchOnly: true, depositsAccepted: false, vaultAddress: null };
}

export async function getManagerCockpit(supabase, user, groupId) {
  const group = await requireManager(supabase, user, groupId);
  const workspace = await buildManagerWorkspace(supabase, group, user.id);
  return { group: mapGroup(group, workspace.ownerProfile, workspace.viewerMembership, user.id, workspace.members.length), ...workspace.payload };
}

export async function reviewMembership(supabase, user, groupId, membershipId, action, input) {
  const group = await requireManager(supabase, user, groupId);
  requireIdempotency(input.idempotencyKey);
  const membership = await requiredSingle(supabase.from("investment_group_members").select("*").eq("id", membershipId).eq("group_id", groupId).eq("role", "member"), "Membership application not found.");
  if (action === "reject") {
    if (!PENDING_MEMBER_STATES.has(membership.membership_state)) throw policyError(409, "Only a pending membership can be rejected.", "MEMBERSHIP_NOT_PENDING");
    const now = new Date().toISOString();
    throwResult(await supabase.from("group_execution_mandates").update({ status: "REVOKED", revoked_at: now }).eq("id", membership.mandate_id));
    const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "REJECTED", status: "removed", updated_at: now }).eq("id", membership.id), "Membership rejection failed.");
    await recordStateChange(supabase, membership, user.id, "REJECTED", String(input.reason || "Manager rejected the application.").slice(0, 500), input.idempotencyKey);
    await writeAudit(supabase, { userId: membership.user_id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_JOIN_REJECTED", message: "Manager rejected a pending membership application.", metadata: { membershipId, actorUserId: user.id } });
    await notify(supabase, membership.user_id, "join_request_rejected", "Investment Group Request Rejected", "Your Copy-Trading application was rejected.", { groupId, membershipId });
    return mapMembership(updated);
  }
  if (membership.membership_state !== "PENDING_APPROVAL") throw policyError(409, "Only a pending approval can be approved.", "MEMBERSHIP_NOT_PENDING");
  const eligibility = await listEligibleConnections(supabase, membership.user_id, group, membership.id);
  const selected = eligibility.connections.find((connection) => connection.id === membership.broker_connection_id);
  if (!selected?.eligible) throw policyError(409, "The membership cannot activate until its broker and Black Cloud are healthy and reconciled.", "BROKER_CONNECTION_INELIGIBLE", { blockers: selected?.blockers || [] });
  const mandate = await requiredSingle(supabase.from("group_execution_mandates").select("*").eq("id", membership.mandate_id), "Signed Copy-Trading mandate not found.");
  if (!mandate.accepted_at || !mandate.consent_hash) throw policyError(409, "A member-signed mandate is required before approval.", "MANDATE_CONSENT_REQUIRED");
  const now = new Date().toISOString();
  throwResult(await supabase.from("group_execution_mandates").update({ status: "ACTIVE", paused_at: null, revoked_at: null }).eq("id", mandate.id));
  const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "ACTIVE", status: "active", joined_at: now, updated_at: now }).eq("id", membership.id), "Membership activation failed.");
  await recordStateChange(supabase, membership, user.id, "ACTIVE", "Manager approved the signed Copy-Trading membership.", input.idempotencyKey);
  await writeAudit(supabase, { userId: membership.user_id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBERSHIP_ACTIVATED", message: "Manager approved and activated the eligible member mandate.", metadata: { membershipId, mandateId: mandate.id, actorUserId: user.id } });
  await notify(supabase, membership.user_id, "membership_activated", "Investment Group Membership Activated", "Your signed Copy-Trading membership is active.", { groupId, membershipId });
  return mapMembership(updated);
}

export async function updateManagerRiskPolicy(supabase, user, groupId, membershipId, input) {
  const group = await requireManager(supabase, user, groupId);
  requireIdempotency(input.idempotencyKey);
  const membership = await requiredSingle(supabase.from("investment_group_members").select("*").eq("id", membershipId).eq("group_id", groupId).eq("role", "member"), "Member not found.");
  const policy = await requiredSingle(supabase.from("group_member_risk_policies").select("*").eq("membership_id", membership.id), "Member risk policy not found.");
  if (Number(input.version) !== Number(policy.version)) throw policyError(409, "The member risk policy changed. Reload before updating leverage.", "RISK_POLICY_VERSION_CONFLICT", { currentVersion: policy.version });
  const connection = await requiredSingle(supabase.from("connectivity_connections").select("account_id").eq("id", membership.broker_connection_id), "Member connection not found.");
  const accountRisk = connection.account_id ? await maybeSingle(supabase.from("account_risk_controls").select("max_leverage").eq("account_id", connection.account_id)) : null;
  const effective = assertManagerLeverageRequest(input.managerRequestedLeverage, policy, {
    groupMaximumLeverage: Number(group.group_max_leverage), emsRiskCap: Number(accountRisk?.max_leverage || group.group_max_leverage), exchangeInstrumentCap: 125
  });
  const correlationId = String(input.correlationId || input.idempotencyKey || `risk-${Date.now()}`);
  const updated = await updateSingle(supabase.from("group_member_risk_policies").update({
    manager_requested_leverage: Number(input.managerRequestedLeverage), effective_leverage: effective,
    version: Number(policy.version) + 1, updated_by_user_id: user.id, updated_at: new Date().toISOString()
  }).eq("id", policy.id).eq("version", policy.version), "Risk policy update conflict.");
  await insertSingle(supabase.from("group_member_risk_policy_versions"), {
    risk_policy_id: policy.id, membership_id: membership.id, version: updated.version,
    policy_snapshot: updated, canonical_hash: hashCanonicalPayload(updated), actor_user_id: user.id,
    reason: String(input.reason || "Manager requested leverage update.").slice(0, 500), correlation_id: correlationId
  });
  throwResult(await supabase.from("group_execution_mandates").update({ manager_requested_leverage: Number(input.managerRequestedLeverage), effective_leverage: effective }).eq("id", membership.mandate_id));
  await writeAudit(supabase, { userId: membership.user_id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBER_LEVERAGE_CHANGED", message: "Manager requested leverage changed within the member-signed cap.", metadata: { membershipId, previousVersion: policy.version, newVersion: updated.version, userMaximum: policy.user_maximum_leverage, managerRequested: input.managerRequestedLeverage, effectiveLeverage: effective, actorUserId: user.id, correlationId } });
  await notify(supabase, membership.user_id, "leverage_changed", "Investment Group Leverage Changed", `Manager requested leverage is now ${Number(input.managerRequestedLeverage)}x; effective leverage is ${effective}x.`, { groupId, membershipId, effectiveLeverage: effective });
  return mapRiskPolicy(updated);
}

export async function managerPauseMembership(supabase, user, groupId, membershipId, input) {
  const group = await requireManager(supabase, user, groupId);
  requireIdempotency(input.idempotencyKey);
  const membership = await requiredSingle(supabase.from("investment_group_members").select("*").eq("id", membershipId).eq("group_id", groupId).eq("role", "member"), "Member not found.");
  if (membership.membership_state === "PAUSED_BY_USER") throw policyError(409, "A manager cannot resume or replace a user pause.", "USER_PAUSE_HAS_PRIORITY");
  if (input.resume === true) {
    if (membership.membership_state !== "PAUSED_BY_MANAGER") throw policyError(409, "Only a manager-paused membership can be resumed by a manager.", "MEMBERSHIP_NOT_MANAGER_PAUSED");
    if (group.status !== "active" || group.emergency_stop) throw policyError(409, "The group cannot resume members while inactive or emergency-stopped.", "GROUP_NOT_ACTIVE");
    const eligibility = await listEligibleConnections(supabase, membership.user_id, group, membership.id);
    const selected = eligibility.connections.find((connection) => connection.id === membership.broker_connection_id);
    if (!selected?.eligible) throw policyError(409, "The member cannot resume until the broker and Black Cloud are healthy and reconciled.", "BROKER_CONNECTION_INELIGIBLE", { blockers: selected?.blockers || [] });
    const now = new Date().toISOString();
    throwResult(await supabase.from("group_execution_mandates").update({ status: "ACTIVE", paused_at: null }).eq("id", membership.mandate_id));
    const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "ACTIVE", paused_at: null, updated_at: now }).eq("id", membership.id), "Manager resume failed.");
    await recordStateChange(supabase, membership, user.id, "ACTIVE", String(input.reason || "Manager resumed future entries after eligibility checks.").slice(0, 500), input.idempotencyKey);
    await writeAudit(supabase, { userId: membership.user_id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBER_RESUMED", message: "Manager resumed a manager-paused membership after fresh eligibility checks.", metadata: { membershipId, actorUserId: user.id } });
    await notify(supabase, membership.user_id, "member_resumed", "Copy Trading Resumed by Manager", "The manager pause was lifted after fresh broker and Black Cloud checks.", { groupId, membershipId });
    return mapMembership(updated);
  }
  if (membership.membership_state !== "ACTIVE") throw policyError(409, "Only an active member can be paused by a manager.", "MEMBERSHIP_NOT_ACTIVE");
  const now = new Date().toISOString();
  throwResult(await supabase.from("group_execution_mandates").update({ status: "PAUSED", paused_at: now }).eq("id", membership.mandate_id));
  await cancelPendingEntries(supabase, membership, "MANAGER_PAUSED");
  const updated = await updateSingle(supabase.from("investment_group_members").update({ membership_state: "PAUSED_BY_MANAGER", paused_at: now, updated_at: now }).eq("id", membership.id), "Manager pause failed.");
  await recordStateChange(supabase, membership, user.id, "PAUSED_BY_MANAGER", String(input.reason || "Manager paused future entries.").slice(0, 500), input.idempotencyKey);
  await writeAudit(supabase, { userId: membership.user_id, connectionId: membership.broker_connection_id, groupId, eventType: "GROUP_MEMBER_PAUSED_BY_MANAGER", message: "Manager paused future entries for a selected member.", metadata: { membershipId, actorUserId: user.id } });
  await notify(supabase, membership.user_id, "member_paused", "Copy Trading Paused by Manager", "The group manager paused future entries. Existing protective orders remain active.", { groupId, membershipId });
  return mapMembership(updated);
}

export async function removeMember(supabase, user, groupId, membershipId, input) {
  await requireManager(supabase, user, groupId);
  requireRecentSession(user);
  requireIdempotency(input.idempotencyKey);
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) throw policyError(400, "A specific removal reason is required.", "REMOVAL_REASON_REQUIRED");
  const membership = await requiredSingle(supabase.from("investment_group_members").select("*").eq("id", membershipId).eq("group_id", groupId).eq("role", "member"), "Member not found.");
  const { data, error } = await supabase.rpc("remove_investment_group_member", { p_actor_user_id: user.id, p_membership_id: membership.id, p_reason: reason.slice(0, 500), p_correlation_id: input.idempotencyKey });
  if (error) throw error;
  await notify(supabase, membership.user_id, "member_removed", "Investment Group Membership Removed", "Future-entry authority was revoked. Group-originated positions were detached and were not force-closed.", { groupId, membershipId });
  return data;
}

export async function emergencyStopGroup(supabase, user, groupId, input) {
  await requireManager(supabase, user, groupId);
  requireRecentSession(user);
  requireIdempotency(input.idempotencyKey);
  const { data, error } = await supabase.rpc("emergency_stop_investment_group", { p_actor_user_id: user.id, p_group_id: groupId, p_reason: String(input.reason || "Group-wide emergency stop.").slice(0, 500), p_correlation_id: input.idempotencyKey });
  if (error) throw error;
  return data;
}

export async function getGroupPositions(supabase, user, groupId) {
  await requireManager(supabase, user, groupId);
  const result = await supabase.from("position_lifecycle_positions")
    .select("id,membership_id,user_id,connection_id,symbol,direction,lifecycle_state,quantity,average_price,current_price,realized_pnl,unrealized_pnl,margin,leverage,liquidation_price,fees,funding,opened_at,updated_at")
    .eq("group_id", groupId).neq("lifecycle_state", "archived").order("updated_at", { ascending: false }).limit(1000);
  throwResult(result);
  return { positions: result.data || [], source: "POSITION_MANAGER_GROUP_ATTRIBUTION", containsUnrelatedAccountPositions: false };
}

export async function getGroupAnalytics(supabase, user, groupId) {
  const group = await requireManager(supabase, user, groupId);
  const workspace = await buildManagerWorkspace(supabase, group, user.id);
  return workspace.payload.analytics;
}

async function buildManagerWorkspace(supabase, group, viewerId) {
  const membersResult = await supabase.from("investment_group_members").select("*").eq("group_id", group.id).order("updated_at", { ascending: false }).limit(1000);
  throwResult(membersResult);
  const members = membersResult.data || [];
  const membershipIds = members.map((row) => row.id);
  const memberUserIds = [...new Set(members.map((row) => row.user_id).filter(Boolean))];
  const memberConnectionIds = [...new Set(members.map((row) => row.broker_connection_id).filter(Boolean))];
  const [policiesResult, profilesResult, connectionsResult, positionsResult, plansResult] = await Promise.all([
    membershipIds.length ? supabase.from("group_member_risk_policies").select("*").in("membership_id", membershipIds) : { data: [], error: null },
    memberUserIds.length ? supabase.from("profiles_extended").select("user_id,handle,display_name,verified_role").in("user_id", memberUserIds).is("deleted_at", null) : { data: [], error: null },
    memberConnectionIds.length ? supabase.from("connectivity_connections").select("id,user_id,account_id,provider,label,account_reference,health_status,worker_state,synchronization_state,execution_readiness,last_heartbeat_at,last_position_sync_at,last_reconciled_at,last_error_code").in("id", memberConnectionIds) : { data: [], error: null },
    supabase.from("position_lifecycle_positions").select("*").eq("group_id", group.id).neq("lifecycle_state", "archived").limit(5000),
    supabase.from("follower_execution_plans").select("id,follower_user_id,mandate_id,risk_result,rejection_reason,execution_status,target_notional,rounded_quantity,estimated_fee,safe_result,created_at,updated_at,group_trade_intents!inner(group_id)").eq("group_trade_intents.group_id", group.id).order("created_at", { ascending: false }).limit(1000)
  ]);
  for (const result of [policiesResult, profilesResult, connectionsResult, positionsResult, plansResult]) throwResult(result);
  const policies = new Map((policiesResult.data || []).map((row) => [row.membership_id, row]));
  const profiles = new Map((profilesResult.data || []).map((row) => [row.user_id, row]));
  const connections = new Map((connectionsResult.data || []).map((row) => [row.id, row]));
  const groupPositions = positionsResult.data || [];
  const accountIds = [...new Set([...connections.values()].map((row) => row.account_id).filter(Boolean))];
  const balancesResult = accountIds.length ? await supabase.from("account_balances").select("account_id,free,total,usd_value,updated_at").in("account_id", accountIds) : { data: [], error: null };
  throwResult(balancesResult);
  const balancesByAccount = groupBy(balancesResult.data || [], "account_id");
  const positionsByMember = groupBy(groupPositions, "membership_id");
  const snapshots = members.filter((member) => member.role === "member").map((member) => buildMemberSnapshot(member, policies.get(member.id), connections.get(member.broker_connection_id), balancesByAccount, positionsByMember));
  const aggregate = aggregateMemberSnapshots(snapshots);
  await persistSnapshots(supabase, group.id, snapshots, aggregate);
  const planRows = plansResult.data || [];
  const executionQuality = {
    totalPlans: planRows.length,
    succeeded: planRows.filter((row) => ["EXECUTED", "FILLED", "PARTIALLY_FILLED", "WORKING"].includes(row.execution_status)).length,
    rejected: planRows.filter((row) => row.risk_result === "REJECTED" || ["RISK_REJECTED", "VENUE_REJECTED", "CONNECTION_UNHEALTHY", "AUTH_EXPIRED"].includes(row.execution_status)).length,
    pending: planRows.filter((row) => ["PENDING", "QUEUED"].includes(row.execution_status)).length,
    divergenceCount: planRows.filter((row) => row.safe_result?.divergence === true).length,
    averageSlippageBps: average(planRows.map((row) => row.safe_result?.slippageBps).filter(Number.isFinite)),
    source: "FOLLOWER_EXECUTION_PLANS"
  };
  const snapshotsByMembership = new Map(snapshots.map((snapshot) => [snapshot.membershipId, snapshot]));
  const memberPayload = members.map((member) => ({
    ...mapMembership(member),
    profile: profiles.get(member.user_id) ? { handle: profiles.get(member.user_id).handle, displayName: profiles.get(member.user_id).display_name, verified: Boolean(profiles.get(member.user_id).verified_role) } : null,
    riskPolicy: mapRiskPolicy(policies.get(member.id)),
    connection: safeConnection(connections.get(member.broker_connection_id)),
    portfolio: shapeManagerPortfolioSnapshot(snapshotsByMembership.get(member.id))
  }));
  return {
    ownerProfile: profiles.get(group.owner_user_id) || null,
    viewerMembership: members.find((member) => member.user_id === viewerId) || null,
    members,
    payload: {
      health: deriveGroupHealth(group, memberPayload),
      aggregate,
      members: memberPayload,
      positions: groupPositions.map(mapPosition),
      analytics: {
        aggregate,
        allocationDistribution: distribution((policiesResult.data || []).map((row) => Number(row.allocation_percent))),
        leverageDistribution: distribution((policiesResult.data || []).map((row) => Number(row.effective_leverage))),
        drawdownDistribution: distribution(snapshots.map((row) => row.currentDrawdownPercent).filter(Number.isFinite)),
        executionQuality,
        formulas: { grossPnl: "realizedPnl + unrealizedPnl", netPnl: "grossPnl - fees - funding", grossExposure: "sum(abs(positionNotional))", netExposure: "longExposure - shortExposure" }
      },
      copyTrading: { members: memberPayload.filter((member) => member.method === "COPY_TRADING"), capitalIncluded: true },
      obsidian: { status: "RESEARCH_PREVIEW", operational: false, depositsAccepted: false, vaultAddressesGenerated: false, capitalIncludedInCopyTrading: false },
      executionQuality
    }
  };
}

async function listEligibleConnections(supabase, userId, group, currentMembershipId) {
  const [connectionsResult, capabilitiesResult, automationResult, mandatesResult, nodesResult] = await Promise.all([
    supabase.from("connectivity_connections").select("id,user_id,account_id,provider,label,account_reference,account_type,connection_mode,execution_capability,execution_environment,health_status,credential_state,worker_state,synchronization_state,execution_readiness,last_heartbeat_at,last_reconciled_at,revoked_at,disabled_at").eq("user_id", userId).eq("category", "centralized-exchange"),
    supabase.from("broker_connection_capabilities").select("*").eq("user_id", userId),
    supabase.from("broker_automation_mandates").select("connection_id,status,allow_read,allow_trade,allow_copy_trading,allow_investment_group_execution,allow_withdrawals,execution_environment,max_leverage").eq("user_id", userId).eq("status", "ACTIVE"),
    supabase.from("group_execution_mandates").select("id,group_id,membership_id,broker_connection_id,broker_account_id,status").eq("follower_user_id", userId).in("status", ["ACTIVE", "PAUSED", "EXIT_ONLY"]),
    supabase.from("black_cloud_nodes").select("node_id,status,last_heartbeat_at,execution_environment").eq("status", "READY")
  ]);
  for (const result of [connectionsResult, capabilitiesResult, automationResult, mandatesResult]) throwResult(result);
  const nodes = nodesResult.error ? [] : nodesResult.data || [];
  const capabilityMap = new Map((capabilitiesResult.data || []).map((row) => [row.connection_id, row]));
  const automationMap = new Map((automationResult.data || []).map((row) => [row.connection_id, row]));
  const conflictingMandates = (mandatesResult.data || []).filter((row) => row.membership_id !== currentMembershipId);
  const conflictsByConnection = new Map(conflictingMandates.map((row) => [row.broker_connection_id, row]));
  const conflictsByAccount = new Map(conflictingMandates.filter((row) => row.broker_account_id).map((row) => [row.broker_account_id, row]));
  const accountIds = (connectionsResult.data || []).map((row) => row.account_id).filter(Boolean);
  const [balancesResult, riskResult] = accountIds.length ? await Promise.all([
    supabase.from("account_balances").select("account_id,usd_value").in("account_id", accountIds),
    supabase.from("account_risk_controls").select("account_id,max_leverage,trading_enabled,read_only_mode,emergency_stop").in("account_id", accountIds)
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  throwResult(balancesResult);
  throwResult(riskResult);
  const balances = groupBy(balancesResult.data || [], "account_id");
  const risks = new Map((riskResult.data || []).map((row) => [row.account_id, row]));
  const supportedProviders = new Set((Array.isArray(group.supported_providers) ? group.supported_providers : ["bybit"]).map((value) => String(value).toLowerCase()));
  const connections = (connectionsResult.data || []).map((connection) => {
    const capability = capabilityMap.get(connection.id);
    const automation = automationMap.get(connection.id);
    const risk = risks.get(connection.account_id);
    const equity = (balances.get(connection.account_id) || []).reduce((sum, row) => sum + Number(row.usd_value || 0), 0);
    const blockers = [];
    if (!supportedProviders.has(String(connection.provider).toLowerCase())) blockers.push("PROVIDER_UNSUPPORTED_BY_GROUP");
    if (!nodes.some((node) => !isStale(node.last_heartbeat_at, 45_000) && (!node.execution_environment || node.execution_environment === connection.execution_environment))) blockers.push("BLACK_CLOUD_NODE_OFFLINE");
    if (!["CLOUD_DELEGATED", "HYBRID"].includes(connection.connection_mode)) blockers.push("PERSISTENT_CONNECTION_REQUIRED");
    if (!["CONNECTED_CLOUD", "CONNECTED_HYBRID"].includes(connection.health_status)) blockers.push("CONNECTION_NOT_HEALTHY");
    if (connection.credential_state !== "AUTHENTICATED") blockers.push("CREDENTIAL_NOT_AUTHENTICATED");
    if (connection.worker_state !== "LIVE") blockers.push("WORKER_NOT_LIVE");
    if (connection.synchronization_state !== "SYNCHRONIZED") blockers.push("ACCOUNT_NOT_RECONCILED");
    if (connection.execution_readiness !== "READY") blockers.push("EXECUTION_NOT_READY");
    if (connection.revoked_at || connection.disabled_at) blockers.push("CONNECTION_REVOKED");
    if (!capability?.can_read_balances || !capability?.can_read_positions || !capability?.can_copy_trade || !capability?.can_receive_group_orders || !capability?.can_execute_while_offline) blockers.push("BROKER_CAPABILITY_MISSING");
    if (capability?.can_withdraw || capability?.can_transfer) blockers.push("WITHDRAWAL_OR_TRANSFER_PERMISSION_FORBIDDEN");
    if (!automation?.allow_read || !automation?.allow_trade || !automation?.allow_copy_trading || !automation?.allow_investment_group_execution || automation?.allow_withdrawals) blockers.push("AUTOMATION_MANDATE_INELIGIBLE");
    if (automation?.execution_environment && connection.execution_environment && automation.execution_environment !== connection.execution_environment) blockers.push("EXECUTION_ENVIRONMENT_MISMATCH");
    if (risk && (!risk.trading_enabled || risk.read_only_mode || risk.emergency_stop)) blockers.push("ACCOUNT_RISK_CONTROL_BLOCKED");
    const conflict = conflictsByAccount.get(connection.account_id) || conflictsByConnection.get(connection.id);
    if (conflict && conflict.group_id !== group.id) blockers.push("ACCOUNT_ALREADY_ASSIGNED_TO_ANOTHER_GROUP");
    return {
      id: connection.id, accountId: connection.account_id, provider: connection.provider, label: connection.label, accountReference: connection.account_reference,
      connectionMode: connection.connection_mode, healthStatus: connection.health_status, workerState: connection.worker_state,
      synchronizationState: connection.synchronization_state, executionReadiness: connection.execution_readiness,
      executionEnvironment: connection.execution_environment, equity, emsRiskCap: Number(risk?.max_leverage || automation?.max_leverage || group.group_max_leverage || 1), exchangeLeverageCap: 125,
      persistent: connection.worker_state === "LIVE", withdrawalAuthority: "NONE", blockers, eligible: blockers.length === 0
    };
  });
  return {
    connections,
    summary: {
      copyTradingOperational: connections.some((connection) => connection.eligible),
      certifiedPersistentWorker: nodes.some((node) => !isStale(node.last_heartbeat_at, 45_000)),
      supportedProviders: [...supportedProviders],
      reason: connections.some((connection) => connection.eligible) ? null : "No eligible, reconciled, withdrawal-prohibited persistent broker connection is available."
    }
  };
}

function buildMemberSnapshot(member, policy, connection, balancesByAccount, positionsByMember) {
  const balances = balancesByAccount.get(connection?.account_id) || [];
  const positions = positionsByMember.get(member.id) || [];
  const equity = balances.reduce((sum, row) => sum + Number(row.usd_value || 0), 0);
  const availableBalance = balances.reduce((sum, row) => {
    const total = Number(row.total || 0);
    const free = Number(row.free || 0);
    const usdValue = Number(row.usd_value || 0);
    return total > 0 && free >= 0 ? sum + usdValue * Math.min(1, free / total) : sum;
  }, 0);
  const allocatedEquity = equity * Number(policy?.allocation_percent || 0) / 100;
  let longExposure = 0;
  let shortExposure = 0;
  for (const position of positions) {
    const notional = Math.abs(Number(position.quantity || 0) * Number(position.current_price || position.average_price || 0));
    if (position.direction === "long") longExposure += notional;
    else shortExposure += notional;
  }
  const realizedPnl = sumRows(positions, "realized_pnl");
  const unrealizedPnl = sumRows(positions, "unrealized_pnl");
  const fees = sumRows(positions, "fees");
  const funding = sumRows(positions, "funding");
  const usedMargin = sumRows(positions, "margin");
  const heartbeatAge = connection?.last_heartbeat_at ? Date.now() - Date.parse(connection.last_heartbeat_at) : Infinity;
  const freshness = connection?.health_status?.includes("DEGRADED") || connection?.worker_state === "DEGRADED" ? "DEGRADED" : heartbeatAge <= 45_000 && connection?.synchronization_state === "SYNCHRONIZED" ? "LIVE" : "STALE";
  return {
    membershipId: member.id, connectionId: connection?.id || null, membershipState: member.membership_state,
    capturedAt: new Date().toISOString(), freshness, equity, availableBalance, allocatedEquity, usedMargin,
    marginUtilizationPercent: allocatedEquity > 0 ? usedMargin / allocatedEquity * 100 : 0,
    grossExposure: longExposure + shortExposure, netExposure: longExposure - shortExposure, longExposure, shortExposure,
    realizedPnl, unrealizedPnl, grossPnl: realizedPnl + unrealizedPnl, fees, funding, netPnl: realizedPnl + unrealizedPnl - fees - funding,
    currentDrawdownPercent: null, maximumDrawdownPercent: null,
    openPositionCount: positions.filter((row) => !["closed", "archived"].includes(row.lifecycle_state)).length,
    openOrderCount: positions.filter((row) => row.lifecycle_state === "opening").length,
    effectiveLeverage: Number(policy?.effective_leverage || 1), walletBalance: member.portfolio_visibility === "FULL_SELECTED_ACCOUNT" ? equity : undefined,
    portfolioVisibility: member.portfolio_visibility, exactAccountDataVisible: member.portfolio_visibility === "FULL_SELECTED_ACCOUNT"
  };
}

function shapeManagerPortfolioSnapshot(snapshot) {
  if (!snapshot) return null;
  if (snapshot.portfolioVisibility === "FULL_SELECTED_ACCOUNT") return snapshot;
  return {
    ...snapshot,
    equity: null,
    availableBalance: null,
    walletBalance: undefined,
    exactAccountDataVisible: false
  };
}

async function persistSnapshots(supabase, groupId, snapshots, aggregate) {
  for (const snapshot of snapshots) {
    if (!snapshot.connectionId) continue;
    const payload = {
      membership_id: snapshot.membershipId, group_id: groupId, connection_id: snapshot.connectionId, captured_at: snapshot.capturedAt,
      freshness: snapshot.freshness, equity: snapshot.equity, available_balance: snapshot.availableBalance,
      allocated_equity: snapshot.allocatedEquity, used_margin: snapshot.usedMargin, margin_utilization_percent: snapshot.marginUtilizationPercent,
      gross_exposure: snapshot.grossExposure, net_exposure: snapshot.netExposure, long_exposure: snapshot.longExposure, short_exposure: snapshot.shortExposure,
      realized_pnl: snapshot.realizedPnl, unrealized_pnl: snapshot.unrealizedPnl, gross_pnl: snapshot.grossPnl, fees: snapshot.fees, funding: snapshot.funding, net_pnl: snapshot.netPnl,
      current_drawdown_percent: snapshot.currentDrawdownPercent, maximum_drawdown_percent: snapshot.maximumDrawdownPercent,
      open_position_count: snapshot.openPositionCount, open_order_count: snapshot.openOrderCount,
      safe_metadata: { effectiveLeverage: snapshot.effectiveLeverage, exactAccountDataVisible: snapshot.exactAccountDataVisible }, updated_at: snapshot.capturedAt
    };
    const result = await supabase.from("group_member_portfolio_snapshots").upsert(payload, { onConflict: "membership_id" });
    if (result.error) throw result.error;
  }
  const latest = await maybeSingle(supabase.from("group_aggregate_snapshots").select("id").eq("group_id", groupId).eq("rollup_interval", "LATEST"));
  const payload = {
    ...(latest?.id ? { id: latest.id } : {}), group_id: groupId, captured_at: aggregate.sampledAt, rollup_interval: "LATEST",
    active_members: aggregate.activeMembers, paused_members: aggregate.pausedMembers, degraded_members: aggregate.degradedMembers,
    connected_equity: aggregate.connectedEquity, allocated_equity: aggregate.allocatedEquity, gross_exposure: aggregate.grossExposure, net_exposure: aggregate.netExposure,
    long_exposure: aggregate.longExposure, short_exposure: aggregate.shortExposure, realized_pnl: aggregate.realizedPnl, unrealized_pnl: aggregate.unrealizedPnl,
    gross_pnl: aggregate.grossPnl, fees: aggregate.fees, funding: aggregate.funding, net_pnl: aggregate.netPnl,
    current_drawdown_percent: aggregate.currentDrawdownPercent, maximum_drawdown_percent: aggregate.maximumDrawdownPercent,
    weighted_leverage: aggregate.weightedLeverage, margin_utilization_percent: aggregate.marginUtilizationPercent
  };
  const result = latest?.id
    ? await supabase.from("group_aggregate_snapshots").upsert(payload, { onConflict: "id" })
    : await supabase.from("group_aggregate_snapshots").insert(payload);
  if (result.error) throw result.error;
}

async function cancelPendingEntries(supabase, membership, reason) {
  const plans = await supabase.from("follower_execution_plans").select("id").eq("mandate_id", membership.mandate_id).in("execution_status", ACTIONABLE_PLAN_STATES);
  throwResult(plans);
  const ids = (plans.data || []).map((row) => row.id);
  if (ids.length) {
    throwResult(await supabase.from("execution_commands").update({ status: "CANCELLED", completed_at: new Date().toISOString(), last_error_code: reason }).in("follower_plan_id", ids).in("status", ACTIONABLE_COMMAND_STATES));
    throwResult(await supabase.from("follower_execution_plans").update({ execution_status: "CANCELLED", rejection_reason: reason }).in("id", ids));
  }
}

async function requireManager(supabase, user, groupId) {
  const group = await requireGroup(supabase, groupId);
  if (group.owner_user_id === user.id || user.app_metadata?.role === "admin") return group;
  const membership = await maybeSingle(supabase.from("investment_group_members").select("role,status,membership_state").eq("group_id", groupId).eq("user_id", user.id));
  if (membership?.status === "active" && ["owner", "manager"].includes(membership.role) && ACTIVE_MEMBER_STATES.has(membership.membership_state)) return group;
  throw policyError(403, "Investment Group manager capability is required.", "GROUP_MANAGER_REQUIRED");
}

async function requireActiveGroup(supabase, groupId) {
  const group = await requireGroup(supabase, groupId);
  if (group.status !== "active" || group.emergency_stop) throw policyError(409, "This Investment Group is not accepting Copy-Trading activation.", "GROUP_NOT_ACTIVE");
  return group;
}

async function assertGroupVisible(supabase, user, group) {
  if (group.visibility === "public" || group.owner_user_id === user.id) return;
  const [membership, invite] = await Promise.all([
    maybeSingle(supabase.from("investment_group_members").select("id").eq("group_id", group.id).eq("user_id", user.id)),
    maybeSingle(supabase.from("investment_group_invites").select("id").eq("group_id", group.id).eq("recipient_user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString()))
  ]);
  if (!membership && !invite) throw policyError(403, "This Investment Group is not visible to your account.", "GROUP_NOT_VISIBLE");
}

async function requireGroup(supabase, groupId) {
  return requiredSingle(supabase.from("investment_groups").select("*,investment_group_stats(*)").eq("id", groupId), "Investment Group not found.");
}

function requireRecentSession(user) {
  const lastSignIn = Date.parse(user.last_sign_in_at || "");
  if (!Number.isFinite(lastSignIn) || Date.now() - lastSignIn > 30 * 60 * 1000) throw policyError(403, "Re-authenticate before this sensitive manager action.", "RECENT_AUTH_REQUIRED");
}

async function recordStateChange(supabase, membership, actorUserId, nextState, reason, correlationId) {
  await insertSingle(supabase.from("group_member_status_history"), {
    membership_id: membership.id, group_id: membership.group_id, user_id: membership.user_id, actor_user_id: actorUserId,
    previous_state: membership.membership_state, next_state: nextState, reason, correlation_id: correlationId
  });
}

async function writeAudit(supabase, input) {
  const result = await supabase.from("execution_audit_events").insert({
    user_id: input.userId || null, connection_id: input.connectionId || null, group_id: input.groupId || null,
    event_type: input.eventType, severity: input.severity || "INFO", operation_purpose: "investment_group_membership",
    user_visible: true, message: input.message, safe_metadata: input.metadata || {}
  });
  if (result.error) throw result.error;
}

async function notify(supabase, userId, eventType, title, body, metadata) {
  const result = await supabase.from("notification_events").insert({ user_id: userId, event_type: eventType, title, body, metadata });
  if (result.error) throw result.error;
}

function mapGroup(row, owner, membership, viewerId, memberCount, validInvite = false) {
  const stats = Array.isArray(row.investment_group_stats) ? row.investment_group_stats[0] : row.investment_group_stats || {};
  return {
    id: row.id, ownerUserId: row.owner_user_id, ownerHandle: owner?.handle || null, ownerDisplayName: owner?.display_name || null, ownerVerified: Boolean(owner?.verified_role),
    firmName: row.firm_name, slug: row.slug, description: row.description, bio: row.bio, logoUrl: row.logo_url, bannerUrl: row.banner_url,
    visibility: row.visibility, accessMode: row.access_mode, approvalRequired: row.approval_required, status: row.status,
    strategySummary: row.strategy_summary, methodologySummary: row.methodology_summary, tradingStyleTags: row.trading_style_tags || [],
    acceptedExchanges: row.accepted_exchanges || [], supportedProviders: row.supported_providers || [], supportedParticipationMethods: row.supported_participation_methods || [],
    copyTradingEnabled: row.copy_trading_enabled === true, obsidianResearchOnly: row.obsidian_research_enabled === true,
    minimumEquity: numberOrNull(row.minimum_equity), maximumMembers: row.max_followers, groupMaximumLeverage: Number(row.group_max_leverage || 1),
    riskClassification: row.risk_classification, performanceSource: row.performance_source, performancePeriodStart: row.performance_period_start, performancePeriodEnd: row.performance_period_end,
    emergencyStop: row.emergency_stop === true, isOwner: row.owner_user_id === viewerId, validInvite,
    memberCount: memberCount ?? Number(stats.follower_count || 0),
    performance: {
      verified: stats.verified === true, monthlyReturn: numberOrNull(stats.monthly_return), yearlyReturn: numberOrNull(stats.yearly_return), totalReturn: numberOrNull(stats.total_return),
      maximumDrawdown: numberOrNull(stats.max_drawdown), currentDrawdown: numberOrNull(stats.current_drawdown), connectedEquity: numberOrNull(stats.connected_equity), riskScore: numberOrNull(stats.risk_score), updatedAt: stats.updated_at || null
    },
    membership: membership ? mapMembership(membership) : null
  };
}

function mapMembership(row) {
  if (!row) return null;
  return {
    id: row.id, groupId: row.group_id, userId: row.user_id, role: row.role, state: row.membership_state || String(row.status || "pending").toUpperCase(), coarseStatus: row.status,
    method: row.participation_method, riskAcknowledgementVersion: row.risk_acknowledgement_version, mandateId: row.mandate_id,
    brokerConnectionId: row.broker_connection_id, portfolioVisibility: row.portfolio_visibility, stateVersion: row.state_version,
    joinedAt: row.joined_at, pausedAt: row.paused_at, leftAt: row.left_at, removedAt: row.removed_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRiskPolicy(row) {
  if (!row) return null;
  return {
    id: row.id, membershipId: row.membership_id, version: row.version, allocationPercent: Number(row.allocation_percent),
    userMaximumLeverage: Number(row.user_maximum_leverage), managerRequestedLeverage: Number(row.manager_requested_leverage), effectiveLeverage: Number(row.effective_leverage),
    maximumPositionEquityPercent: Number(row.maximum_position_equity_percent), maximumTotalExposurePercent: Number(row.maximum_total_exposure_percent),
    maximumDailyLossPercent: Number(row.maximum_daily_loss_percent), maximumDrawdownPercent: Number(row.maximum_drawdown_percent),
    allowedSymbols: row.allowed_symbols || [], allowedMarketTypes: row.allowed_market_types || [], longEnabled: row.long_enabled, shortEnabled: row.short_enabled,
    allowedOrderTypes: row.allowed_order_types || [], marginMode: row.margin_mode, maximumSlippageBps: row.maximum_slippage_bps, exitPolicy: row.exit_policy,
    userConsentedAt: row.user_consented_at, updatedAt: row.updated_at
  };
}

function mapMandate(row) {
  if (!row) return null;
  return {
    id: row.id, groupId: row.group_id, membershipId: row.membership_id, connectionId: row.broker_connection_id, status: row.status,
    executionMode: row.execution_mode, allocationMethod: row.allocation_method, allocationValue: Number(row.allocation_value),
    userMaximumLeverage: Number(row.max_leverage), managerRequestedLeverage: Number(row.manager_requested_leverage || row.max_leverage), effectiveLeverage: Number(row.effective_leverage || row.max_leverage),
    allowedSymbols: row.allowed_symbols || [], allowedMarketTypes: row.allowed_market_types || [], allowedOrderTypes: row.allowed_order_types || [],
    exitPolicy: row.exit_policy, portfolioVisibility: row.portfolio_visibility, acceptedAt: row.accepted_at, expiresAt: row.expires_at,
    withdrawalAuthority: "NONE", transferAuthority: "NONE"
  };
}

function mapJoinDraft(row) {
  return { id: row.id, groupId: row.group_id, currentStep: row.current_step, participationMethod: row.participation_method, configuration: row.safe_configuration || {}, expiresAt: row.expires_at, updatedAt: row.updated_at };
}

function mapPosition(row) {
  return {
    id: row.id, membershipId: row.membership_id, userId: row.user_id, connectionId: row.connection_id, symbol: row.symbol,
    direction: String(row.direction).toUpperCase(), state: String(row.lifecycle_state).toUpperCase(), quantity: Number(row.quantity),
    averagePrice: Number(row.average_price), markPrice: Number(row.current_price), realizedPnl: Number(row.realized_pnl), unrealizedPnl: Number(row.unrealized_pnl),
    grossPnl: Number(row.realized_pnl) + Number(row.unrealized_pnl), fees: Number(row.fees || 0), funding: Number(row.funding || 0),
    netPnl: Number(row.realized_pnl) + Number(row.unrealized_pnl) - Number(row.fees || 0) - Number(row.funding || 0),
    margin: Number(row.margin), leverage: Number(row.leverage), liquidationPrice: numberOrNull(row.liquidation_price), updatedAt: row.updated_at
  };
}

function safeConnection(row) {
  if (!row) return null;
  return { id: row.id, provider: row.provider, label: row.label, accountReference: row.account_reference, healthStatus: row.health_status, workerState: row.worker_state, synchronizationState: row.synchronization_state, executionReadiness: row.execution_readiness, lastHeartbeatAt: row.last_heartbeat_at, lastReconciledAt: row.last_reconciled_at, lastErrorCode: row.last_error_code, credentialsVisible: false };
}

function deriveGroupHealth(group, members) {
  const active = members.filter((member) => member.state === "ACTIVE");
  const degraded = active.filter((member) => member.portfolio?.freshness !== "LIVE" || member.connection?.executionReadiness !== "READY");
  return { status: group.emergency_stop ? "EMERGENCY_STOPPED" : degraded.length ? "DEGRADED" : active.length ? "OPERATIONAL" : "NO_ACTIVE_COPY_TRADERS", activeMembers: active.length, degradedMembers: degraded.length, canExecuteNewTrade: !group.emergency_stop && active.length > 0 && degraded.length === 0 };
}

function sanitizeJoinDraft(input) {
  const allowed = ["connectionId", "allocationPercent", "userMaximumLeverage", "maximumPositionEquityPercent", "maximumTotalExposurePercent", "maximumDailyLossPercent", "maximumDrawdownPercent", "allowedSymbols", "allowedMarketTypes", "longEnabled", "shortEnabled", "allowedOrderTypes", "marginMode", "maximumSlippageBps", "exitPolicy", "portfolioVisibility"];
  return Object.fromEntries(allowed.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

function requireIdempotency(value) {
  if (!value || String(value).length < 12 || String(value).length > 200) throw policyError(400, "A valid idempotency key is required.", "IDEMPOTENCY_KEY_REQUIRED");
}

function isStale(value, maximumAge) {
  const time = Date.parse(value || "");
  return !Number.isFinite(time) || Date.now() - time > maximumAge;
}

function distribution(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return { minimum: null, maximum: null, average: null, median: null, count: 0 };
  const sorted = [...finiteValues].sort((a, b) => a - b);
  return { minimum: sorted[0], maximum: sorted.at(-1), average: average(sorted), median: sorted[Math.floor(sorted.length / 2)], count: sorted.length };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : null;
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) result.set(row[key], [...(result.get(row[key]) || []), row]);
  return result;
}

function sumRows(rows, key) {
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function countRows(query) {
  const result = await query;
  throwResult(result);
  return result.count || 0;
}

async function maybeSingle(query) {
  if (!query) return null;
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function requiredSingle(query, message) {
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw policyError(404, message, "RESOURCE_NOT_FOUND");
  return result.data;
}

async function insertSingle(query, payload) {
  const result = await query.insert(payload).select("*").single();
  if (result.error) throw result.error;
  return result.data;
}

async function upsertSingle(query, payload, options) {
  const result = await query.upsert(payload, options).select("*").single();
  if (result.error) throw result.error;
  return result.data;
}

async function updateSingle(query, message) {
  const result = await query.select("*").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw policyError(409, message, "OPTIMISTIC_UPDATE_CONFLICT");
  return result.data;
}

function throwResult(result) {
  if (result?.error) throw result.error;
  return result;
}
