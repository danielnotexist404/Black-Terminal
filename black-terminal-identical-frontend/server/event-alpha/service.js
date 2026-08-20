import {
  EVENT_ALPHA_REASON_CODE_SET,
  bindExpectationToEvent,
  domainError,
  eventAlphaRuntimeConfig,
  normalizeRawEventEnvelope,
  sanitizeSafeMetadata,
  sha256
} from "./domain.js";
import {
  assessEventSurprise,
  buildEventAlphaThesis,
  deterministicPaperFill,
  evaluateBcrdaTacticalGate,
  evaluatePaperRisk,
  forecastEventResponse
} from "./engine.js";
import { EventAlphaRepository } from "./repository.js";

export async function handleEventAlphaRequest(req, res, security, path) {
  const repository = new EventAlphaRepository(security.supabase);
  const config = eventAlphaRuntimeConfig();
  const [resource, identifier, action] = path;
  if (req.method === "GET" && resource === "config") return res.status(200).json({ config: publicConfig(config) });
  if (req.method === "GET" && resource === "feed") return res.status(200).json({ events: await repository.listFeed(queryFilters(req.query)) });
  if (req.method === "GET" && resource === "events" && identifier) return res.status(200).json(await repository.eventDetail(assertUuid(identifier)));
  if (req.method === "GET" && resource === "theses") return res.status(200).json({ theses: await repository.listTheses({ limit: boundedLimit(req.query?.limit, 100), state: optionalEnum(req.query?.state, ["DRAFT","OBSERVING","ARMED","TRIGGERED","PAPER_ACTIVE","RESOLVED","EXPIRED","INVALIDATED","REJECTED"]) }) });
  if (req.method === "GET" && resource === "health") return res.status(200).json({ config: publicConfig(config), ...(await repository.health()) });
  if (req.method === "GET" && resource === "audit") return res.status(200).json({ records: await repository.audit({ limit: boundedLimit(req.query?.limit, 100), eventId: optionalUuid(req.query?.eventId), thesisId: optionalUuid(req.query?.thesisId) }) });
  if (req.method === "GET" && resource === "paper-state") {
    requireAdmin(security.identity);
    return res.status(200).json(await repository.paperState({ limit: boundedLimit(req.query?.limit, 100) }));
  }

  requireAdmin(security.identity);
  requireEngine(config);
  if (req.method === "POST" && resource === "ingest" && identifier === "token-unlock") {
    if (!config.ingestionEnabled || !config.tokenSupplyEnabled) throw httpError(403, "Token-supply ingestion is disabled by rollout policy.", "EVENT_ALPHA_INGESTION_DISABLED");
    return ingestTokenUnlock(req, res, repository, security);
  }
  if (req.method === "POST" && resource === "events" && identifier && action === "assess") return assessEvent(req, res, repository, security, assertUuid(identifier));
  if (req.method === "POST" && resource === "theses" && identifier && action === "transition") return transitionThesis(req, res, repository, security, assertUuid(identifier));
  if (req.method === "POST" && resource === "paper-intents") return createPaperIntent(req, res, repository, security, config);
  if (req.method === "POST" && resource === "paper-intents" && identifier && action === "approve") return approvePaperIntent(req, res, repository, security, config, assertUuid(identifier));
  throw httpError(404, "Event Alpha route not found.", "EVENT_ALPHA_ROUTE_NOT_FOUND");
}

async function ingestTokenUnlock(req, res, repository, security) {
  const envelope = normalizeRawEventEnvelope(req.body?.envelope);
  if (envelope.eventFamily !== "TOKEN_SUPPLY") throw domainError("EVENT_ALPHA_EVENT_FAMILY_MISMATCH", "The token-unlock route only accepts TOKEN_SUPPLY evidence.");
  const manualSourceKey = `ADMIN_SECONDARY_${sha256(security.user.id).slice(0, 12)}_${envelope.sourceKey}`.slice(0, 80);
  const source = await repository.ensureSource({
    sourceKey: manualSourceKey,
    displayName: String(req.body?.sourceDisplayName || `Admin secondary: ${envelope.sourceKey}`).slice(0, 160),
    eventFamily: "TOKEN_SUPPLY",
    adapterVersion: "ADMIN_MANUAL_INGEST_V1",
    authorityClass: "SECONDARY",
    enabled: true,
    configurationFingerprint: sha256({ sourceKey: manualSourceKey, adapterVersion: "ADMIN_MANUAL_INGEST_V1" })
  });
  const result = await repository.ingestTokenUnlock(envelope, source);
  const sourceHealth = await security.supabase.from("event_alpha_sources").update({ health_status: "HEALTHY", last_success_at: new Date().toISOString(), safe_error_code: null, updated_at: new Date().toISOString() }).eq("id", source.id);
  if (sourceHealth.error) throw persistenceError("EVENT_ALPHA_SOURCE_HEALTH_WRITE_FAILED", sourceHealth.error);
  await repository.writeAudit({
    canonicalEventId: result.canonicalEvent.id,
    decisionType: "SOURCE_INGESTION",
    outcome: result.duplicate ? "IDEMPOTENT_REPLAY" : "ACCEPTED",
    reasonCodes: result.duplicate ? ["DUPLICATE_REVISION"] : ["SOURCE_EVIDENCE_ACCEPTED"],
    modelVersions: { adapter: "ADMIN_MANUAL_INGEST_V1" },
    evidenceHash: envelope.payloadHash,
    safeMetadata: { sourceKey: manualSourceKey, claimedSourceKey: envelope.sourceKey, revision: result.revision },
    actorType: "ADMIN",
    actorId: security.user.id
  });
  return res.status(result.duplicate ? 200 : 202).json({
    event: eventProjection(result.canonicalEvent),
    revision: result.revision,
    duplicate: result.duplicate,
    delivery: "DURABLE_ASSESSMENT_QUEUE"
  });
}

async function assessEvent(req, res, repository, security, eventId) {
  const detail = await repository.eventDetail(eventId);
  const latestRevision = detail.revisions[0];
  if (!latestRevision) throw httpError(409, "Event has no normalized revision.", "EVENT_ALPHA_REVISION_MISSING");
  const canonicalEvent = {
    canonicalKey: detail.event.canonical_key,
    eventFamily: detail.event.event_family,
    assetId: detail.event.asset_id,
    symbol: detail.event.symbol,
    eventTime: detail.event.event_time,
    firstActionableAt: detail.event.first_actionable_at,
    sourceConfidence: Number(detail.event.source_confidence),
    currentRevision: Number(detail.event.current_revision),
    normalizedPayload: latestRevision.normalized_payload
  };
  const expectationInput = req.body?.expectation;
  const assetProfile = normalizeAssetProfile(req.body?.assetProfile, canonicalEvent);
  const expectation = {
    ...expectationInput,
    contributors: expectationInput?.contributors || [],
    featureManifest: expectationInput?.featureManifest || {}
  };
  const boundExpectation = bindExpectationToEvent(expectation, canonicalEvent);
  const observation = normalizeMarketObservation(req.body?.marketObservation, canonicalEvent);
  const expiresAt = requiredIsoAfter(req.body?.expiresAt, observation.cutoffAt, "expiresAt");
  const expectationKey = sha256({ eventId, eventRevision: canonicalEvent.currentRevision, expectation: boundExpectation });
  let { data: profileRow, error: profileError } = await security.supabase.from("event_alpha_asset_profiles").insert({
    asset_id: canonicalEvent.assetId,
    profile_version: Number(req.body?.assetProfileVersion || 1),
    effective_from: assetProfile.effectiveFrom,
    known_at: assetProfile.knownAt,
    circulating_supply: assetProfile.circulatingSupply,
    average_daily_dollar_volume: assetProfile.averageDailyDollarVolume,
    float_adjustment: assetProfile.floatAdjustment,
    liquid_supply_ratio: assetProfile.liquidSupplyRatio,
    value_capture_score: assetProfile.valueCaptureScore,
    benchmark_symbol: assetProfile.benchmarkSymbol,
    source_manifest: assetProfile.sourceManifest
  }).select("*").single();
  if (profileError?.code === "23505") {
    const existing = await security.supabase.from("event_alpha_asset_profiles").select("*").eq("asset_id", canonicalEvent.assetId).eq("profile_version", Number(req.body?.assetProfileVersion || 1)).single();
    profileRow = existing.data;
    profileError = existing.error;
  }
  if (profileError || !profileRow) throw persistenceError("EVENT_ALPHA_PROFILE_WRITE_FAILED", profileError);
  const persistedProfile = profileRow || assetProfile;
  const expectationResult = await security.supabase.rpc("event_alpha_insert_expectation_v1", {
    p_canonical_event_id: eventId,
    p_expectation_key: expectationKey,
    p_as_of: boundExpectation.asOf,
    p_first_actionable_at: boundExpectation.firstActionableAt,
    p_model_key: boundExpectation.modelKey,
    p_model_version: boundExpectation.modelVersion,
    p_expected_value: boundExpectation.expectedValue,
    p_expected_time: boundExpectation.expectedTime,
    p_expected_probability: boundExpectation.expectedProbability,
    p_dispersion: boundExpectation.dispersion,
    p_confidence: boundExpectation.confidence,
    p_contributors: boundExpectation.contributors,
    p_feature_manifest: boundExpectation.featureManifest
  });
  if (expectationResult.error) throw persistenceError("EVENT_ALPHA_EXPECTATION_WRITE_FAILED", expectationResult.error);
  const expectationRow = Array.isArray(expectationResult.data) ? expectationResult.data[0] : expectationResult.data;
  if (!expectationRow?.id) throw persistenceError("EVENT_ALPHA_EXPECTATION_WRITE_EMPTY", null);
  const assessedAt = req.body?.assessedAt ? requiredIso(req.body.assessedAt, "assessedAt") : observation.cutoffAt;
  if (Date.parse(assessedAt) < Date.parse(canonicalEvent.firstActionableAt) || Date.parse(assessedAt) > Date.parse(observation.cutoffAt)) throw httpError(400, "Assessment time violates the evidence window.", "EVENT_ALPHA_ASSESSMENT_CUTOFF_INVALID");
  const surprise = assessEventSurprise({ canonicalEvent, expectation: boundExpectation, assetProfile: toEngineProfile(persistedProfile), assessedAt });
  let { data: surpriseRow, error: surpriseError } = await security.supabase.from("event_alpha_surprise_assessments").insert({
    canonical_event_id: eventId,
    event_revision: detail.event.current_revision,
    expectation_snapshot_id: expectationRow.id,
    assessed_at: surprise.assessedAt,
    quantity_surprise: surprise.quantitySurprise,
    timing_surprise: surprise.timingSurprise,
    probability_surprise: surprise.probabilitySurprise,
    structural_surprise: surprise.structuralSurprise,
    composite_surprise: surprise.compositeSurprise,
    confidence: surprise.confidence,
    economic_impact: surprise.economicImpact,
    reason_codes: surprise.reasonCodes,
    calculation_manifest: surprise.calculationManifest
  }).select("*").single();
  if (surpriseError?.code === "23505") {
    const existing = await security.supabase.from("event_alpha_surprise_assessments").select("*").eq("canonical_event_id", eventId).eq("event_revision", detail.event.current_revision).eq("expectation_snapshot_id", expectationRow.id).single();
    surpriseRow = existing.data;
    surpriseError = existing.error;
  }
  if (surpriseError) throw persistenceError("EVENT_ALPHA_SURPRISE_WRITE_FAILED", surpriseError);
  const forecast = forecastEventResponse({
    surprise,
    realizedAssetReturnBps: observation.assetReturnBps,
    realizedBenchmarkReturnBps: observation.benchmarkReturnBps,
    horizonSeconds: observation.horizonSeconds,
    costs: observation.costs
  });
  let { data: forecastRow, error: forecastError } = await security.supabase.from("event_alpha_response_forecasts").insert({
    surprise_assessment_id: surpriseRow.id,
    horizon_seconds: forecast.horizonSeconds,
    benchmark_symbol: assetProfile.benchmarkSymbol,
    expected_abnormal_return_bps: forecast.expectedAbnormalReturnBps,
    realized_abnormal_return_bps: forecast.realizedAbnormalReturnBps,
    estimated_round_trip_cost_bps: forecast.estimatedRoundTripCostBps,
    uncertainty_penalty_bps: forecast.uncertaintyPenaltyBps,
    remaining_alpha_bps: forecast.remainingAlphaBps,
    outcome: forecast.outcome,
    confidence: forecast.confidence,
    price_cutoff_at: observation.cutoffAt,
    calculation_manifest: forecast.calculationManifest
  }).select("*").single();
  if (forecastError?.code === "23505") {
    const existing = await security.supabase.from("event_alpha_response_forecasts").select("*").eq("surprise_assessment_id", surpriseRow.id).eq("horizon_seconds", forecast.horizonSeconds).eq("price_cutoff_at", observation.cutoffAt).single();
    forecastRow = existing.data;
    forecastError = existing.error;
  }
  if (forecastError) throw persistenceError("EVENT_ALPHA_FORECAST_WRITE_FAILED", forecastError);
  const thesis = buildEventAlphaThesis({ canonicalEvent, forecast, validFrom: observation.cutoffAt, expiresAt });
  let { data: thesisRow, error: thesisError } = await security.supabase.from("event_alpha_theses").insert({
    canonical_event_id: eventId,
    response_forecast_id: forecastRow.id,
    thesis_key: thesis.thesisKey,
    state: thesis.state,
    direction: thesis.direction,
    event_family: thesis.eventFamily,
    confidence: thesis.confidence,
    remaining_alpha_bps: thesis.remainingAlphaBps,
    valid_from: thesis.validFrom,
    expires_at: thesis.expiresAt,
    reason_codes: thesis.reasonCodes,
    invalidation_conditions: thesis.invalidationConditions
  }).select("*").single();
  if (thesisError?.code === "23505") {
    const existing = await security.supabase.from("event_alpha_theses").select("*").eq("thesis_key", thesis.thesisKey).single();
    thesisRow = existing.data;
    thesisError = existing.error;
  }
  if (thesisError) throw persistenceError("EVENT_ALPHA_THESIS_WRITE_FAILED", thesisError);
  await repository.writeAudit({
    canonicalEventId: eventId,
    thesisId: thesisRow.id,
    decisionType: "EVENT_RESPONSE_ASSESSMENT",
    outcome: forecast.outcome,
    reasonCodes: [...surprise.reasonCodes, ...forecast.reasonCodes],
    modelVersions: { surprise: "EVENT_SURPRISE_V1", forecast: "REMAINING_EVENT_ALPHA_V1", expectation: boundExpectation.modelVersion },
    evidenceHash: sha256({ revision: latestRevision.payload_hash, expectation: expectationRow.id, observation }),
    safeMetadata: { horizonSeconds: forecast.horizonSeconds, remainingAlphaBps: forecast.remainingAlphaBps },
    actorType: "ADMIN",
    actorId: security.user.id
  });
  return res.status(201).json({ surprise, forecast, thesis: thesisProjection(thesisRow) });
}

async function transitionThesis(req, res, repository, security, thesisId) {
  const toState = enumValue(req.body?.toState, ["OBSERVING","ARMED","TRIGGERED","PAPER_ACTIVE","RESOLVED","EXPIRED","INVALIDATED","REJECTED"]);
  const reasonCodes = Array.isArray(req.body?.reasonCodes) ? req.body.reasonCodes.map((value) => String(value).slice(0, 80)).filter(Boolean).slice(0, 20) : [];
  if (!reasonCodes.length) throw httpError(400, "At least one reason code is required.", "EVENT_ALPHA_REASON_CODE_REQUIRED");
  if (reasonCodes.some((code) => !EVENT_ALPHA_REASON_CODE_SET.has(code))) throw httpError(400, "Reason code is not part of the Event Alpha contract.", "EVENT_ALPHA_REASON_CODE_INVALID");
  const { data, error } = await security.supabase.rpc("event_alpha_transition_thesis_v1", {
    p_thesis_id: thesisId,
    p_expected_version: positiveInteger(req.body?.expectedVersion, "expectedVersion"),
    p_to_state: toState,
    p_reason_codes: reasonCodes,
    p_actor_type: "ADMIN",
    p_actor_id: security.user.id,
    p_evidence: sanitizeSafeMetadata(req.body?.evidence || {})
  });
  if (error) throw persistenceError("EVENT_ALPHA_TRANSITION_FAILED", error, error.code === "40001" ? 409 : 400);
  const thesis = Array.isArray(data) ? data[0] : data;
  await repository.writeAudit({
    thesisId,
    decisionType: "THESIS_TRANSITION",
    outcome: toState,
    reasonCodes,
    modelVersions: {},
    evidenceHash: sha256({ thesisId, toState, expectedVersion: req.body?.expectedVersion, evidence: req.body?.evidence || {} }),
    safeMetadata: {},
    actorType: "ADMIN",
    actorId: security.user.id
  });
  return res.status(200).json({ thesis: thesisProjection(thesis) });
}

async function createPaperIntent(req, res, repository, security, config) {
  if (!config.paperExecutionEnabled) throw httpError(403, "Event Alpha paper execution is disabled.", "EVENT_ALPHA_PAPER_DISABLED");
  if (config.strategyKillSwitchEngaged || config.globalExecutionKillSwitchEngaged) throw httpError(503, "Event Alpha execution kill switch is engaged.", "EVENT_ALPHA_KILL_SWITCH_ENGAGED");
  if (config.liveExecutionConfigurationRejected) throw httpError(503, "Unsafe live Event Alpha configuration was rejected.", "EVENT_ALPHA_LIVE_FORBIDDEN");
  if (config.manualApprovalConfigurationRejected) throw httpError(503, "Unsafe paper approval configuration was rejected.", "EVENT_ALPHA_MANUAL_APPROVAL_REQUIRED");
  const thesisId = assertUuid(req.body?.thesisId);
  const { data: row, error } = await security.supabase.from("event_alpha_theses").select("*").eq("id", thesisId).single();
  if (error) throw persistenceError("EVENT_ALPHA_THESIS_READ_FAILED", error);
  const thesis = toEngineThesis(row);
  const market = normalizePaperMarket(req.body?.market);
  const gate = evaluateBcrdaTacticalGate({ thesis, tacticalSetup: req.body?.tacticalSetup, now: market.cutoffAt, cooldownSeconds: Number(req.body?.cooldownSeconds || 900) });
  const policy = normalizePaperPolicy(req.body?.policy, market.symbol);
  const risk = evaluatePaperRisk({ thesis, gate, policy, market });
  const decisionKey = sha256({ thesisId, gate: gate.idempotencyKey, policy: policy.version, cutoff: market.cutoffAt });
  if (risk.decision !== "ALLOW_PAPER") {
    let { error: riskError } = await security.supabase.from("event_alpha_risk_decisions").insert({
      thesis_id: thesisId,
      decision_key: decisionKey,
      decision: risk.decision,
      approved_notional: 0,
      max_loss: 0,
      reason_codes: risk.reasonCodes,
      evidence_cutoff_at: market.cutoffAt,
      policy_version: risk.policyVersion
    });
    if (riskError?.code === "23505") riskError = null;
    if (riskError) throw persistenceError("EVENT_ALPHA_RISK_WRITE_FAILED", riskError);
    await repository.writeAudit({ thesisId, decisionType: "PAPER_RISK_DECISION", outcome: "REJECT", reasonCodes: risk.reasonCodes, modelVersions: { risk: policy.version }, evidenceHash: risk.evidenceHash, safeMetadata: { symbol: market.symbol }, actorType: "ADMIN", actorId: security.user.id });
    return res.status(422).json({ decision: risk, intent: null });
  }
  const side = thesis.direction === "LONG" ? "BUY" : "SELL";
  const quantity = risk.approvedNotional / market.price;
  const clientIntentId = `EAE-${decisionKey.slice(0, 32)}`;
  const idempotencyKey = sha256({ thesisId, decisionKey, side, quantity });
  const canonicalPayload = { thesisId, mode: "PAPER", symbol: market.symbol, side, orderType: "MARKET", quantity, marketDataCutoffAt: market.cutoffAt };
  const reasonCodes = [...new Set([...gate.reasonCodes, ...risk.reasonCodes])];
  const creation = await security.supabase.rpc("event_alpha_create_paper_intent_v1", {
    p_thesis_id: thesisId,
    p_expected_thesis_version: Number(row.version),
    p_decision_key: decisionKey,
    p_approved_notional: risk.approvedNotional,
    p_max_loss: risk.maxLoss,
    p_reason_codes: reasonCodes,
    p_evidence_cutoff_at: market.cutoffAt,
    p_policy_version: policy.version,
    p_client_intent_id: clientIntentId,
    p_symbol: market.symbol,
    p_side: side,
    p_quantity: quantity,
    p_expires_at: thesis.expiresAt,
    p_idempotency_key: idempotencyKey,
    p_canonical_payload: canonicalPayload,
    p_tactical_setup_key: gate.tacticalSetupKey,
    p_actor_id: security.user.id
  });
  if (creation.error) throw persistenceError("EVENT_ALPHA_INTENT_WRITE_FAILED", creation.error, creation.error.code === "40001" ? 409 : 503);
  const intent = Array.isArray(creation.data) ? creation.data[0] : creation.data;
  if (!intent?.id) throw persistenceError("EVENT_ALPHA_INTENT_WRITE_EMPTY", null);
  await repository.writeAudit({ thesisId, decisionType: "PAPER_RISK_DECISION", outcome: "ALLOW_PAPER", reasonCodes, modelVersions: { risk: policy.version }, evidenceHash: risk.evidenceHash, safeMetadata: { symbol: market.symbol, paperIntentId: intent.id }, actorType: "ADMIN", actorId: security.user.id });
  return res.status(202).json({ decision: risk, intent: paperIntentProjection(intent), delivery: "MANUAL_APPROVAL_REQUIRED" });
}

async function approvePaperIntent(req, res, repository, security, config, intentId) {
  if (!config.paperExecutionEnabled) throw httpError(403, "Event Alpha paper execution is disabled.", "EVENT_ALPHA_PAPER_DISABLED");
  if (config.strategyKillSwitchEngaged || config.globalExecutionKillSwitchEngaged) throw httpError(503, "Event Alpha execution kill switch is engaged.", "EVENT_ALPHA_KILL_SWITCH_ENGAGED");
  if (config.manualApprovalConfigurationRejected) throw httpError(503, "Unsafe paper approval configuration was rejected.", "EVENT_ALPHA_MANUAL_APPROVAL_REQUIRED");
  const market = normalizePaperMarket(req.body?.market);
  const approval = await security.supabase.rpc("event_alpha_approve_paper_intent_v1", {
    p_intent_id: intentId,
    p_symbol: market.symbol,
    p_market_price: market.price,
    p_market_cutoff_at: market.cutoffAt,
    p_job_idempotency_key: sha256(`paper:${intentId}`)
  });
  if (approval.error) throw persistenceError("EVENT_ALPHA_INTENT_APPROVAL_FAILED", approval.error, approval.error.code === "22023" ? 409 : 503);
  const data = Array.isArray(approval.data) ? approval.data[0] : approval.data;
  if (!data?.id) throw persistenceError("EVENT_ALPHA_INTENT_APPROVAL_EMPTY", null);
  await repository.writeAudit({
    thesisId: data.thesis_id,
    decisionType: "PAPER_INTENT_APPROVAL",
    outcome: "QUEUED",
    reasonCodes: ["MANUAL_APPROVAL_CONFIRMED","PAPER_ONLY"],
    modelVersions: {},
    evidenceHash: sha256({ intentId: data.id, approvedBy: security.user.id }),
    safeMetadata: { symbol: data.symbol }, actorType: "ADMIN", actorId: security.user.id
  });
  return res.status(202).json({ intent: paperIntentProjection(data), delivery: "DURABLE_PAPER_QUEUE" });
}

export async function executePaperJob({ supabase, job, model = { version: "PAPER_FILL_V1", spreadBps: 2, slippageBps: 3, feeBps: 5 } }) {
  const intentId = job.payload?.intentId;
  const { data: intent, error } = await supabase.from("event_alpha_trade_intents").select("*").eq("id", intentId).single();
  if (error) throw persistenceError("EVENT_ALPHA_INTENT_READ_FAILED", error);
  if (intent.mode !== "PAPER") return { skipped: true, reasonCode: "INTENT_NOT_PAPER" };
  if (intent.status === "FILLED") {
    const activation = await supabase.rpc("event_alpha_mark_paper_active_v1", { p_intent_id: intent.id });
    if (activation.error) throw persistenceError("EVENT_ALPHA_PAPER_ACTIVATION_FAILED", activation.error);
    await writePaperFillAudit(supabase, intent, Array.isArray(activation.data) ? activation.data[0] : activation.data);
    return { skipped: true, reasonCode: "INTENT_ALREADY_FILLED" };
  }
  if (intent.status !== "QUEUED") return { skipped: true, reasonCode: "INTENT_NOT_QUEUED" };
  const market = normalizePaperMarket(job.payload?.market);
  if (Date.parse(market.cutoffAt) > Date.now()) throw httpError(409, "Market evidence cutoff is in the future.", "EVENT_ALPHA_MARKET_LOOKAHEAD");
  const orderKey = sha256({ intentId, mode: "PAPER" });
  let { data: order, error: orderError } = await supabase.from("event_alpha_paper_orders").insert({
    trade_intent_id: intent.id,
    paper_order_id: `PAPER-${orderKey.slice(0, 32)}`,
    status: "OPEN",
    submitted_at: market.cutoffAt,
    safe_metadata: { modelVersion: model.version }
  }).select("*").single();
  if (orderError?.code === "23505") {
    const existing = await supabase.from("event_alpha_paper_orders").select("*").eq("trade_intent_id", intent.id).single();
    order = existing.data; orderError = existing.error;
  }
  if (orderError) throw persistenceError("EVENT_ALPHA_PAPER_ORDER_WRITE_FAILED", orderError);
  const fill = deterministicPaperFill({ intent: { clientIntentId: intent.client_intent_id, side: intent.side, quantity: Number(intent.quantity) }, market, model });
  const fillRow = {
    paper_order_id: order.id,
    fill_key: fill.fillKey,
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    slippage_bps: fill.slippageBps,
    filled_at: fill.filledAt,
    market_data_cutoff_at: fill.marketDataCutoffAt,
    model_version: fill.modelVersion
  };
  let { error: fillError } = await supabase.from("event_alpha_paper_fills").insert(fillRow);
  if (fillError?.code === "23505") {
    const existing = await supabase.from("event_alpha_paper_fills").select("*").eq("fill_key", fill.fillKey).single();
    fillError = existing.error;
    if (!fillError && !samePaperFill(existing.data, fillRow)) throw persistenceError("EVENT_ALPHA_PAPER_FILL_IDENTITY_COLLISION", null, 409);
  }
  if (fillError) throw persistenceError("EVENT_ALPHA_PAPER_FILL_WRITE_FAILED", fillError);
  const orderUpdate = await supabase.from("event_alpha_paper_orders").update({ status: "FILLED", filled_quantity: fill.quantity, average_fill_price: fill.price, total_fees: fill.fee, version: Number(order.version) + 1, updated_at: new Date().toISOString() }).eq("id", order.id).eq("version", order.version).select("id,status").maybeSingle();
  if (orderUpdate.error) throw persistenceError("EVENT_ALPHA_PAPER_ORDER_FINALIZE_FAILED", orderUpdate.error);
  if (!orderUpdate.data) {
    const current = await supabase.from("event_alpha_paper_orders").select("status").eq("id", order.id).single();
    if (current.error || current.data?.status !== "FILLED") throw persistenceError("EVENT_ALPHA_PAPER_ORDER_CAS_CONFLICT", current.error, 409);
  }
  let { data: position, error: positionError } = await supabase.from("event_alpha_paper_positions").insert({
    thesis_id: intent.thesis_id,
    trade_intent_id: intent.id,
    paper_order_id: order.id,
    symbol: intent.symbol,
    direction: intent.side === "BUY" ? "LONG" : "SHORT",
    quantity: fill.quantity,
    average_entry_price: fill.price,
    status: "OPEN",
    total_fees: fill.fee,
    total_funding: 0,
    opened_at: fill.filledAt,
    market_data_cutoff_at: fill.marketDataCutoffAt,
    safe_metadata: { fillModelVersion: fill.modelVersion }
  }).select("*").single();
  if (positionError?.code === "23505") {
    const existing = await supabase.from("event_alpha_paper_positions").select("*").eq("trade_intent_id", intent.id).single();
    position = existing.data; positionError = existing.error;
  }
  const expectedDirection = intent.side === "BUY" ? "LONG" : "SHORT";
  if (positionError || !position || position.paper_order_id !== order.id || position.trade_intent_id !== intent.id || position.symbol !== intent.symbol
    || position.direction !== expectedDirection || Number(position.quantity) !== fill.quantity || Number(position.average_entry_price) !== fill.price
    || Number(position.total_fees) !== fill.fee || position.status !== "OPEN") {
    throw persistenceError("EVENT_ALPHA_PAPER_POSITION_RECONCILIATION_FAILED", positionError, 409);
  }
  const intentUpdate = await supabase.from("event_alpha_trade_intents").update({ status: "FILLED", updated_at: new Date().toISOString() }).eq("id", intent.id).eq("status", "QUEUED").select("id,status").maybeSingle();
  if (intentUpdate.error || !intentUpdate.data) throw persistenceError("EVENT_ALPHA_INTENT_FINALIZE_FAILED", intentUpdate.error, 409);
  const activation = await supabase.rpc("event_alpha_mark_paper_active_v1", { p_intent_id: intent.id });
  if (activation.error) throw persistenceError("EVENT_ALPHA_PAPER_ACTIVATION_FAILED", activation.error);
  await writePaperFillAudit(supabase, intent, Array.isArray(activation.data) ? activation.data[0] : activation.data);
  return { skipped: false, orderId: order.id, fill };
}

async function writePaperFillAudit(supabase, intent, thesis) {
  if (!thesis?.canonical_event_id) throw persistenceError("EVENT_ALPHA_PAPER_AUDIT_CORRELATION_MISSING", null);
  const { error } = await supabase.from("event_alpha_decision_audit").insert({
    correlation_id: thesis.canonical_event_id,
    canonical_event_id: thesis.canonical_event_id,
    thesis_id: intent.thesis_id,
    decision_type: "PAPER_FILL_ATTRIBUTION",
    outcome: "FILLED",
    reason_codes: ["PAPER_FILL_CONFIRMED","PAPER_ONLY"],
    model_versions: { paperFill: "PAPER_FILL_V1" },
    evidence_hash: sha256({ intentId: intent.id, status: "FILLED" }),
    safe_metadata: { paperIntentId: intent.id, symbol: intent.symbol },
    actor_type: "PAPER_OMS"
  });
  if (error && error.code !== "23505") throw persistenceError("EVENT_ALPHA_PAPER_AUDIT_WRITE_FAILED", error);
}

function samePaperFill(actual, expected) {
  return Boolean(actual)
    && actual.paper_order_id === expected.paper_order_id
    && Number(actual.quantity) === expected.quantity
    && Number(actual.price) === expected.price
    && Number(actual.fee) === expected.fee
    && Number(actual.slippage_bps) === expected.slippage_bps
    && new Date(actual.filled_at).toISOString() === new Date(expected.filled_at).toISOString()
    && new Date(actual.market_data_cutoff_at).toISOString() === new Date(expected.market_data_cutoff_at).toISOString()
    && actual.model_version === expected.model_version;
}

function normalizeAssetProfile(value, event) {
  if (!value || typeof value !== "object") throw httpError(400, "assetProfile is required.", "EVENT_ALPHA_ASSET_PROFILE_REQUIRED");
  const knownAt = requiredIso(value.knownAt, "assetProfile.knownAt");
  if (Date.parse(knownAt) > Date.parse(event.firstActionableAt)) throw httpError(400, "Asset profile contains post-event knowledge.", "EVENT_ALPHA_PROFILE_LOOKAHEAD");
  const effectiveFrom = requiredIso(value.effectiveFrom || value.knownAt, "assetProfile.effectiveFrom");
  if (Date.parse(effectiveFrom) > Date.parse(knownAt)) throw httpError(400, "Asset profile effective time cannot follow its knowledge time.", "EVENT_ALPHA_PROFILE_TIME_INVALID");
  return {
    effectiveFrom, knownAt,
    circulatingSupply: requiredPositive(value.circulatingSupply, "circulatingSupply"),
    averageDailyDollarVolume: requiredPositive(value.averageDailyDollarVolume, "averageDailyDollarVolume"),
    floatAdjustment: boundedNumber(value.floatAdjustment ?? 1, 0, 1, "floatAdjustment"),
    liquidSupplyRatio: boundedNumber(value.liquidSupplyRatio ?? 0.5, 0, 1, "liquidSupplyRatio"),
    valueCaptureScore: boundedNumber(value.valueCaptureScore ?? 0.5, 0, 1, "valueCaptureScore"),
    benchmarkSymbol: value.benchmarkSymbol ? String(value.benchmarkSymbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null,
    sourceManifest: sanitizeSafeMetadata(value.sourceManifest || {})
  };
}

function normalizeMarketObservation(value, event) {
  if (!value || typeof value !== "object") throw httpError(400, "marketObservation is required.", "EVENT_ALPHA_MARKET_OBSERVATION_REQUIRED");
  const cutoffAt = requiredIso(value.cutoffAt, "marketObservation.cutoffAt");
  if (Date.parse(cutoffAt) < Date.parse(event.firstActionableAt) || Date.parse(cutoffAt) > Date.now()) throw httpError(400, "Market observation violates the point-in-time window.", "EVENT_ALPHA_MARKET_CUTOFF_INVALID");
  return {
    cutoffAt,
    assetReturnBps: requiredFinite(value.assetReturnBps, "assetReturnBps"),
    benchmarkReturnBps: requiredFinite(value.benchmarkReturnBps ?? 0, "benchmarkReturnBps"),
    horizonSeconds: boundedNumber(value.horizonSeconds, 60, 2_592_000, "horizonSeconds"),
    costs: {
      spreadBps: boundedNumber(value.costs?.spreadBps ?? 0, 0, 1_000, "spreadBps"),
      slippageBps: boundedNumber(value.costs?.slippageBps ?? 0, 0, 1_000, "slippageBps"),
      feesBps: boundedNumber(value.costs?.feesBps ?? 0, 0, 1_000, "feesBps"),
      fundingBps: boundedNumber(value.costs?.fundingBps ?? 0, 0, 1_000, "fundingBps")
    }
  };
}

function normalizePaperPolicy(value = {}, symbol) {
  return {
    version: String(value.version || "EVENT_ALPHA_PAPER_RISK_V1").trim().slice(0, 80) || "EVENT_ALPHA_PAPER_RISK_V1",
    minimumConfidence: boundedNumber(value.minimumConfidence ?? 0.65, 0, 1, "minimumConfidence"),
    minimumRemainingAlphaBps: boundedNumber(value.minimumRemainingAlphaBps ?? 15, 0, 5_000, "minimumRemainingAlphaBps"),
    maxNotional: boundedNumber(value.maxNotional ?? 1_000, 1, 1_000_000, "maxNotional"),
    paperEquity: boundedNumber(value.paperEquity ?? 100_000, 1, 1_000_000_000, "paperEquity"),
    riskPerThesisPct: boundedNumber(value.riskPerThesisPct ?? 0.005, 0.0001, 0.05, "riskPerThesisPct"),
    stopDistancePct: boundedNumber(value.stopDistancePct ?? 0.02, 0.001, 0.5, "stopDistancePct"),
    maxLossPerThesis: boundedNumber(value.maxLossPerThesis ?? 500, 1, 1_000_000, "maxLossPerThesis"),
    allowedSymbols: (Array.isArray(value.allowedSymbols) ? value.allowedSymbols : [symbol]).map((item) => String(item).replace(/[^A-Za-z0-9]/g, "").toUpperCase()).filter(Boolean)
  };
}

function normalizePaperMarket(value) {
  if (!value || typeof value !== "object") throw httpError(400, "Paper market evidence is required.", "EVENT_ALPHA_PAPER_MARKET_REQUIRED");
  const cutoffAt = requiredIso(value.cutoffAt, "paperMarket.cutoffAt");
  if (Date.parse(cutoffAt) > Date.now()) throw httpError(400, "Paper market evidence cannot be from the future.", "EVENT_ALPHA_MARKET_LOOKAHEAD");
  if (Date.now() - Date.parse(cutoffAt) > 120_000) throw httpError(409, "Paper market evidence is stale.", "EVENT_ALPHA_MARKET_STALE");
  const symbol = String(value.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (symbol.length < 2 || symbol.length > 40) throw httpError(400, "Paper market symbol is invalid.", "EVENT_ALPHA_SYMBOL_INVALID");
  return { symbol, price: requiredPositive(value.price, "price"), cutoffAt };
}

function toEngineProfile(row) {
  return {
    knownAt: row.known_at || row.knownAt,
    circulatingSupply: Number(row.circulating_supply ?? row.circulatingSupply),
    averageDailyDollarVolume: Number(row.average_daily_dollar_volume ?? row.averageDailyDollarVolume),
    floatAdjustment: Number(row.float_adjustment ?? row.floatAdjustment),
    liquidSupplyRatio: Number(row.liquid_supply_ratio ?? row.liquidSupplyRatio),
    valueCaptureScore: Number(row.value_capture_score ?? row.valueCaptureScore),
    benchmarkSymbol: row.benchmark_symbol ?? row.benchmarkSymbol
  };
}

function toEngineThesis(row) {
  return {
    thesisKey: row.thesis_key,
    state: row.state,
    direction: row.direction,
    confidence: Number(row.confidence),
    remainingAlphaBps: Number(row.remaining_alpha_bps),
    expiresAt: row.expires_at,
    lastTriggeredAt: row.last_triggered_at
  };
}

function queryFilters(query) {
  return { limit: boundedLimit(query?.limit, 50), before: query?.before ? requiredIso(String(query.before), "before") : null, family: optionalEnum(query?.family, ["TOKEN_SUPPLY","GOVERNANCE","PROTOCOL_ECONOMICS"]), symbol: query?.symbol ? String(query.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null };
}

function publicConfig(config) {
  return { ...config, architecture: "SERVER_AUTHORITY", executionMode: config.paperExecutionEnabled ? "PAPER" : "DISABLED", directBrokerFanout: false, llmOrderAuthority: false };
}

function eventProjection(row) { return { id: row.id, canonicalKey: row.canonical_key, eventFamily: row.event_family, assetId: row.asset_id, symbol: row.symbol, eventTime: row.event_time, firstActionableAt: row.first_actionable_at, status: row.status, revision: row.current_revision, sourceConfidence: Number(row.source_confidence), summary: row.safe_summary }; }
function thesisProjection(row) { return { id: row.id, eventId: row.canonical_event_id, thesisKey: row.thesis_key, state: row.state, direction: row.direction, confidence: Number(row.confidence), remainingAlphaBps: Number(row.remaining_alpha_bps), validFrom: row.valid_from, expiresAt: row.expires_at, reasonCodes: row.reason_codes || [], version: row.version }; }
function paperIntentProjection(row) { return { id: row.id, thesisId: row.thesis_id, clientIntentId: row.client_intent_id, mode: row.mode, symbol: row.symbol, side: row.side, orderType: row.order_type, quantity: Number(row.quantity), expiresAt: row.expires_at, status: row.status }; }

function requireAdmin(identity) { if (identity.role !== "admin") throw httpError(403, "Event Alpha mutation requires administrative authority.", "EVENT_ALPHA_ADMIN_REQUIRED"); }
function requireEngine(config) { if (!config.engineEnabled) throw httpError(403, "Event Alpha engine is disabled by rollout policy.", "EVENT_ALPHA_ENGINE_DISABLED"); if (config.liveExecutionConfigurationRejected) throw httpError(503, "Unsafe live Event Alpha configuration was rejected.", "EVENT_ALPHA_LIVE_FORBIDDEN"); }
function assertUuid(value) { const text = String(value || ""); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw httpError(400, "Identifier is invalid.", "EVENT_ALPHA_ID_INVALID"); return text; }
function optionalUuid(value) { return value ? assertUuid(value) : null; }
function enumValue(value, allowed) { const normalized = String(value || "").toUpperCase(); if (!allowed.includes(normalized)) throw httpError(400, "Enum value is invalid.", "EVENT_ALPHA_ENUM_INVALID"); return normalized; }
function optionalEnum(value, allowed) { return value ? enumValue(value, allowed) : null; }
function boundedLimit(value, fallback) { const parsed = Number(value ?? fallback); return Math.min(200, Math.max(1, Number.isFinite(parsed) ? Math.round(parsed) : fallback)); }
function boundedNumber(value, minimum, maximum, field) { const parsed = requiredFinite(value, field); if (parsed < minimum || parsed > maximum) throw httpError(400, `${field} is outside its allowed range.`, "EVENT_ALPHA_NUMBER_RANGE"); return parsed; }
function requiredFinite(value, field) { if (typeof value !== "number" || !Number.isFinite(value)) throw httpError(400, `${field} must be a finite number.`, "EVENT_ALPHA_NUMBER_INVALID"); return value; }
function requiredPositive(value, field) { const parsed = requiredFinite(value, field); if (parsed <= 0) throw httpError(400, `${field} must be positive.`, "EVENT_ALPHA_NUMBER_INVALID"); return parsed; }
function requiredIso(value, field) { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw httpError(400, `${field} must be a valid timestamp.`, "EVENT_ALPHA_TIMESTAMP_INVALID"); return parsed.toISOString(); }
function requiredIsoAfter(value, after, field) { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.parse(after)) throw httpError(400, `${field} must be a valid timestamp after the evidence cutoff.`, "EVENT_ALPHA_TIMESTAMP_INVALID"); return parsed.toISOString(); }
function positiveInteger(value, field) { const parsed = requiredFinite(value, field); if (!Number.isInteger(parsed) || parsed < 1) throw httpError(400, `${field} must be a positive integer.`, "EVENT_ALPHA_INTEGER_INVALID"); return parsed; }
function httpError(statusCode, message, code) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function persistenceError(code, cause, statusCode = 503) { const error = new Error("Event Alpha persistence is temporarily unavailable."); error.code = code; error.statusCode = statusCode; error.cause = cause; return error; }
