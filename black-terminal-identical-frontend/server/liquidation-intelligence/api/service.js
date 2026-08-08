import {
  BCLIF_BUCKET_ID,
  BCLIF_LIVE_HEARTBEAT_MS,
  BCLIF_MAX_TILE_BYTES,
  BCLIF_SUPPORTED_COMPRESSION,
  BCLIF_SUPPORTED_MODEL_VERSION,
  BCLIF_SUPPORTED_MODEL_AUTHORITY,
  BCLIF_SUPPORTED_SCHEMA_VERSION,
  BCLIF_SUPPORTED_SOURCE_VERSION,
  BCLIF_SUPPORTED_TILE_VERSION,
  bclifDeferredPayload,
  bclifHttpError,
  isDeferredBclifInfrastructureError,
  publicScope,
  sanitizeTileMetadata,
  validateTileObjectPath,
  verifyTileChecksum
} from "./contracts.js";

const SOURCE_COLUMNS = "id,venue,symbol,market_kind,source_version,collector_node,active_instance_id,writer_instance_id,fencing_epoch,state,last_heartbeat_at,model_version,source_cutoff_at,continuity_state,source_freshness";
const TILE_PUBLIC_COLUMNS = "id,source_id,model_version,horizon,chunk_start,chunk_end,columns,rows,price_min,price_max,compression,checksum,compressed_bytes,schema_version,tile_version,time_step_ms,price_step,source_cutoff_at,coverage_quality,model_authority,channel_manifest,scale_metadata,publication_state,published_at,writer_instance_id,fencing_epoch";
const TILE_PRIVATE_COLUMNS = `${TILE_PUBLIC_COLUMNS},bucket_id,object_path`;
const COVERAGE_SOURCES = ["TRADE", "LIQUIDATION", "OPEN_INTEREST", "BOOK_FRAME", "FUNDING"];

export async function readBclifStatus(supabase) {
  const { data, error } = await supabase
    .from("bclif_collector_nodes")
    .select("node_id,current_instance_id,fencing_epoch,lease_expires_at,environment,region,deployment_commit,model_version,status,lifecycle_state,started_at,last_heartbeat_at,source_freshness")
    .order("last_heartbeat_at", { ascending: false })
    .limit(2);
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) return { httpStatus: 200, payload: bclifDeferredPayload() };
    throw infrastructureError(error);
  }
  const nodes = data || [];
  const freshAuthorities = nodes.filter((candidate) => {
    const age = heartbeatAge(candidate.last_heartbeat_at);
    const leaseExpiry = timestampOrNull(candidate.lease_expires_at);
    return age !== null
      && age <= BCLIF_LIVE_HEARTBEAT_MS
      && leaseExpiry !== null
      && leaseExpiry > Date.now()
      && Number(candidate.fencing_epoch) > 0
      && ["LIVE", "DEGRADED"].includes(candidate.status)
      && candidate.current_instance_id;
  });
  if (freshAuthorities.length > 1) {
    throw bclifHttpError(503, "Multiple BCLIF collector authorities are active.", "BCLIF_NODE_AUTHORITY_AMBIGUOUS", { retryable: true });
  }
  const node = freshAuthorities[0] || nodes[0] || null;
  if (!node) return { httpStatus: 200, payload: { ...bclifDeferredPayload(), deploymentState: "PACKAGED_NOT_DEPLOYED" } };
  const bucket = await probeBclifBucket(supabase);
  if (!bucket.available) {
    return { httpStatus: 200, payload: { ...bclifDeferredPayload(), deploymentState: "STORAGE_NOT_DEPLOYED" } };
  }
  const heartbeatAgeMs = heartbeatAge(node.last_heartbeat_at);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= BCLIF_LIVE_HEARTBEAT_MS;
  const leaseExpiry = timestampOrNull(node.lease_expires_at);
  const leaseFresh = leaseExpiry !== null && leaseExpiry > Date.now() && Number(node.fencing_epoch) > 0;
  const live = node.status === "LIVE" && heartbeatFresh && leaseFresh;
  const degraded = !live && heartbeatFresh && leaseFresh;
  const payload = {
    status: live ? "ok" : degraded ? "degraded" : "unavailable",
    deploymentState: live ? "LIVE" : degraded ? "DEGRADED" : "TEMPORARILY_UNAVAILABLE",
    collectorState: node.status,
    // A degraded or temporarily offline collector does not erase its verified
    // immutable history. Keep that history under one persistent authority and
    // let source gaps/freshness lower confidence; never start a second model.
    modelAuthority: "PERSISTENT_NODE",
    persistence: true,
    history: live ? "CONTINUOUS" : "PERSISTENT HISTORY AVAILABLE; LIVE EDGE DEGRADED",
    collector: {
      nodeId: node.node_id,
      instanceId: node.current_instance_id,
      environment: node.environment,
      region: node.region,
      deploymentCommit: node.deployment_commit,
      modelVersion: node.model_version,
      lifecycleState: node.lifecycle_state,
      startedAt: node.started_at,
      lastHeartbeatAt: node.last_heartbeat_at,
      heartbeatAgeMs,
      sourceFreshness: safeObject(node.source_freshness)
    },
    generatedAt: new Date().toISOString()
  };
  return { httpStatus: live || degraded ? 200 : 503, payload };
}

export async function readBclifCoverage(supabase, scope) {
  requireBoundedScope(scope);
  const bucket = await probeBclifBucket(supabase);
  if (!bucket.available) return { httpStatus: 200, payload: coverageUnavailable(scope) };
  const sourceResult = await findSource(supabase, scope);
  if (sourceResult.deferred) return { httpStatus: 200, payload: coverageUnavailable(scope) };
  if (!sourceResult.source) return { httpStatus: 200, payload: coverageUnavailable(scope) };
  const { data, error } = await supabase
    .from("bclif_coverage")
    .select("horizon,requested_start,requested_end,model_start,model_end,trade_coverage_percent,open_interest_coverage_percent,liquidation_coverage_percent,orderbook_coverage_percent,funding_coverage_percent,model_continuity_percent,missing_intervals,source_intervals,quality,source_mode,model_authority,source_cutoff_at,coverage_version,updated_at")
    .eq("source_id", sourceResult.source.id)
    .eq("horizon", scope.horizon)
    .maybeSingle();
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) return { httpStatus: 200, payload: coverageUnavailable(scope) };
    throw infrastructureError(error);
  }
  if (!data) return { httpStatus: 200, payload: coverageUnavailable(scope) };
  return { httpStatus: 200, payload: serializeCoverage(scope, data) };
}

export async function readBclifManifest(supabase, scope) {
  requireBoundedScope(scope);
  const coverage = await readBclifCoverage(supabase, scope);
  if (coverage.payload.sourceMode === "UNAVAILABLE") {
    return { httpStatus: 200, payload: { ...coverage.payload, tiles: [], liveEdge: null } };
  }
  const sourceResult = await findSource(supabase, scope);
  if (!sourceResult.source) return { httpStatus: 200, payload: { ...coverage.payload, tiles: [], liveEdge: null } };
  let query = supabase
    .from("bclif_field_chunks")
    .select(TILE_PUBLIC_COLUMNS)
    .eq("source_id", sourceResult.source.id)
    .eq("horizon", scope.horizon)
    .eq("model_version", BCLIF_SUPPORTED_MODEL_VERSION)
    .eq("schema_version", BCLIF_SUPPORTED_SCHEMA_VERSION)
    .eq("tile_version", BCLIF_SUPPORTED_TILE_VERSION)
    .eq("compression", BCLIF_SUPPORTED_COMPRESSION)
    .eq("model_authority", BCLIF_SUPPORTED_MODEL_AUTHORITY)
    .eq("publication_state", "FINALIZED")
    .order("chunk_start", { ascending: false })
    .limit(512);
  if (scope.from !== null) query = query.gte("chunk_end", new Date(scope.from).toISOString());
  if (scope.to !== null) {
    const replayCutoff = new Date(scope.to).toISOString();
    // A manifest is a causal publication boundary, not merely an overlap
    // query. Never hand a historical request a tile containing later columns.
    query = query.lte("chunk_end", replayCutoff).lte("source_cutoff_at", replayCutoff);
  }
  const { data, error } = await query;
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) return { httpStatus: 200, payload: { ...coverageUnavailable(scope), tiles: [], liveEdge: null } };
    throw infrastructureError(error);
  }
  const tiles = data || [];
  const superseded = await supersededTileIds(supabase, tiles.map((row) => row.id));
  const liveEdge = scope.mode === "LIVE" ? await findLiveEdge(supabase, sourceResult.source, scope) : null;
  return {
    httpStatus: 200,
    payload: {
      ...coverage.payload,
      collectorState: "AVAILABLE",
      liveEdge: liveEdge ? sanitizeTileMetadata(liveEdge) : null,
      tiles: tiles
        .filter((row) => row.publication_state === "FINALIZED")
        .filter(isSupportedPersistentTile)
        .filter((row) => !superseded.has(row.id))
        .sort((left, right) => Date.parse(left.chunk_start) - Date.parse(right.chunk_start))
        .map(sanitizeTileMetadata)
    }
  };
}

export async function readBclifDiagnostics(supabase) {
  const status = await readBclifStatus(supabase);
  if (status.payload.deploymentState === "NOT_DEPLOYED") return status;
  const counters = {};
  for (const [table, primaryKey] of [["bclif_sources", "id"], ["bclif_cohort_checkpoints", "checkpoint_id"], ["bclif_field_chunks", "id"], ["bclif_confirmed_liquidation_events", "id"]]) {
    const { count, error } = await supabase.from(table).select(primaryKey, { count: "exact", head: true });
    if (error) {
      if (isDeferredBclifInfrastructureError(error)) counters[table] = null;
      else throw infrastructureError(error);
    } else counters[table] = count ?? 0;
  }
  return { httpStatus: status.httpStatus, payload: { ...status.payload, recordCounts: counters } };
}

export async function loadVerifiedBclifTile(supabase, scope, tileId, expectedChecksum) {
  requireBoundedScope(scope);
  const sourceResult = await findSource(supabase, scope);
  if (!sourceResult.source) throw bclifHttpError(404, "BCLIF tile was not found.", "TILE_NOT_FOUND");
  const { data: tile, error } = await supabase
    .from("bclif_field_chunks")
    .select(TILE_PRIVATE_COLUMNS)
    .eq("id", tileId)
    .eq("source_id", sourceResult.source.id)
    .eq("model_version", BCLIF_SUPPORTED_MODEL_VERSION)
    .eq("schema_version", BCLIF_SUPPORTED_SCHEMA_VERSION)
    .eq("tile_version", BCLIF_SUPPORTED_TILE_VERSION)
    .eq("compression", BCLIF_SUPPORTED_COMPRESSION)
    .eq("model_authority", BCLIF_SUPPORTED_MODEL_AUTHORITY)
    .in("publication_state", scope.mode === "LIVE" ? ["FINALIZED", "STAGING"] : ["FINALIZED"])
    .maybeSingle();
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) throw bclifHttpError(503, "Persistent BCLIF tiles are not deployed.", "BCLIF_NOT_DEPLOYED");
    throw infrastructureError(error);
  }
  if (!tile || !isSupportedPersistentTile(tile)) throw bclifHttpError(404, "BCLIF tile was not found.", "TILE_NOT_FOUND");
  const isLiveEdge = tile.publication_state === "STAGING";
  if (tile.checksum !== expectedChecksum) {
    throw bclifHttpError(isLiveEdge ? 410 : 404, "BCLIF tile revision is no longer current.", "TILE_REVISION_MISMATCH", { retryable: isLiveEdge });
  }
  if (isLiveEdge && scope.mode !== "LIVE") throw bclifHttpError(404, "BCLIF tile was not found.", "TILE_NOT_FOUND");
  if (tile.horizon !== scope.horizon) {
    throw bclifHttpError(404, "BCLIF tile was not found.", "TILE_NOT_FOUND");
  }
  if (isLiveEdge) {
    const currentLiveEdge = await findLiveEdge(supabase, sourceResult.source, scope);
    if (!currentLiveEdge || currentLiveEdge.id !== tile.id || currentLiveEdge.checksum !== tile.checksum) {
      throw bclifHttpError(410, "BCLIF live edge has advanced.", "LIVE_EDGE_ADVANCED", { retryable: true });
    }
  }
  const superseded = await supersededTileIds(supabase, [tile.id]);
  if (superseded.has(tile.id)) throw bclifHttpError(410, "BCLIF tile has been superseded.", "TILE_SUPERSEDED");
  const tileStart = timestampOrNull(tile.chunk_start);
  const tileEnd = timestampOrNull(tile.chunk_end);
  const tileCutoff = timestampOrNull(tile.source_cutoff_at);
  if (
    tileStart === null
    || tileEnd === null
    || tileCutoff === null
    || tileEnd < scope.from
    || tileStart > scope.to
    || tileEnd > scope.to
    || tileCutoff > scope.to
  ) {
    // Use one opaque not-found response so a valid tile ID cannot be used to
    // enumerate data outside the manifest window that authorized this read.
    throw bclifHttpError(404, "BCLIF tile is not part of this manifest scope.", "TILE_NOT_IN_MANIFEST_SCOPE");
  }
  if (tile.bucket_id !== BCLIF_BUCKET_ID) throw bclifHttpError(422, "BCLIF tile bucket metadata is invalid.", "INVALID_TILE_BUCKET");
  const startMs = Date.parse(tile.chunk_start);
  validateTileObjectPath(tile.object_path, {
    schemaVersion: tile.schema_version,
    symbol: scope.symbol,
    horizon: tile.horizon,
    startMs,
    tileId: tile.id,
    checksum: tile.checksum
  });
  const expectedBytes = Number(tile.compressed_bytes);
  if (tile.compression !== BCLIF_SUPPORTED_COMPRESSION) throw bclifHttpError(422, "BCLIF tile compression metadata is unsupported.", "UNSUPPORTED_TILE_COMPRESSION");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > BCLIF_MAX_TILE_BYTES) {
    throw bclifHttpError(422, "BCLIF tile size metadata is invalid.", "INVALID_TILE_SIZE");
  }
  const { data: object, error: downloadError } = await supabase.storage.from(BCLIF_BUCKET_ID).download(tile.object_path);
  if (downloadError || !object) throw bclifHttpError(503, "BCLIF tile storage is temporarily unavailable.", "TILE_STORAGE_UNAVAILABLE");
  const bytes = Buffer.from(await object.arrayBuffer());
  if (bytes.byteLength !== expectedBytes || bytes.byteLength > BCLIF_MAX_TILE_BYTES) {
    throw bclifHttpError(422, "BCLIF tile length verification failed.", "TILE_LENGTH_MISMATCH");
  }
  verifyTileChecksum(bytes, tile.checksum);
  return { bytes, metadata: sanitizeTileMetadata(tile) };
}

async function findSource(supabase, scope) {
  const { data, error } = await supabase
    .from("bclif_sources")
    .select(SOURCE_COLUMNS)
    .eq("venue", scope.venue)
    .eq("market_kind", scope.marketKind)
    .eq("symbol", scope.symbol)
    .eq("model_version", BCLIF_SUPPORTED_MODEL_VERSION)
    .eq("source_version", BCLIF_SUPPORTED_SOURCE_VERSION)
    .order("last_heartbeat_at", { ascending: false, nullsFirst: false })
    .limit(2);
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) return { source: null, deferred: true };
    throw infrastructureError(error);
  }
  const rows = data || [];
  if (rows.length > 1) {
    throw bclifHttpError(503, "BCLIF source generation is ambiguous.", "BCLIF_SOURCE_AUTHORITY_AMBIGUOUS", { retryable: true });
  }
  return { source: rows[0] || null, deferred: false };
}

async function findLiveEdge(supabase, source, scope) {
  let query = supabase
    .from("bclif_field_chunks")
    .select(TILE_PRIVATE_COLUMNS)
    .eq("source_id", source.id)
    .eq("horizon", scope.horizon)
    .eq("model_version", BCLIF_SUPPORTED_MODEL_VERSION)
    .eq("schema_version", BCLIF_SUPPORTED_SCHEMA_VERSION)
    .eq("tile_version", BCLIF_SUPPORTED_TILE_VERSION)
    .eq("compression", BCLIF_SUPPORTED_COMPRESSION)
    .eq("model_authority", BCLIF_SUPPORTED_MODEL_AUTHORITY)
    .eq("publication_state", "STAGING")
    .gte("chunk_end", new Date(scope.from).toISOString())
    .lte("chunk_end", new Date(scope.to).toISOString())
    .lte("source_cutoff_at", new Date(scope.to).toISOString())
    .order("source_cutoff_at", { ascending: false })
    .order("chunk_start", { ascending: false })
    .limit(2);
  const { data, error } = await query;
  if (error) {
    if (isDeferredBclifInfrastructureError(error)) return null;
    throw infrastructureError(error);
  }
  const candidates = Array.isArray(data) ? data : data ? [data] : [];
  const rows = candidates.filter((row) => row.publication_state === "STAGING"
    && isSupportedPersistentTile(row)
    && row.writer_instance_id === source.writer_instance_id
    && Number(row.fencing_epoch) === Number(source.fencing_epoch)
    && source.active_instance_id === source.writer_instance_id);
  if (!rows.length) return null;
  // Only the newest UTC bucket is the live authority. An older STAGING row
  // left by a crash is ignored and recovered or retired by the collector.
  return rows[0];
}

async function supersededTileIds(supabase, tileIds) {
  if (!tileIds.length) return new Set();
  const { data, error } = await supabase
    .from("bclif_tile_supersessions")
    .select("superseded_tile_id")
    .in("superseded_tile_id", tileIds);
  if (error) {
    throw infrastructureError(error);
  }
  return new Set((data || []).map((row) => row.superseded_tile_id));
}

function serializeCoverage(scope, row) {
  const persistentMode = row.source_mode === "PERSISTENT_COLLECTOR" || row.source_mode === "MIXED";
  const coverageVersion = Number(row.coverage_version);
  if (!persistentMode || row.model_authority !== "PERSISTENT_NODE" || (coverageVersion !== 1 && coverageVersion !== 2)) {
    return coverageUnavailable(scope);
  }
  const requestedStart = timestampOrNull(row.requested_start);
  const requestedEnd = timestampOrNull(row.requested_end);
  if (requestedStart === null || requestedEnd === null || requestedEnd <= requestedStart) return coverageUnavailable(scope);
  const sourceCutoffTimestamp = timestampOrNull(row.source_cutoff_at);
  const collectorState = row.source_mode === "PERSISTENT_COLLECTOR" ? "AVAILABLE" : "PARTIAL";

  if (coverageVersion === 2) {
    if (sourceCutoffTimestamp === null || sourceCutoffTimestamp < requestedStart || sourceCutoffTimestamp > requestedEnd) {
      return coverageUnavailable(scope);
    }
    const ledger = deriveRequestedCoverage(
      scope,
      row.source_intervals,
      requestedStart,
      requestedEnd,
      sourceCutoffTimestamp
    );
    if (!ledger) return coverageUnavailable(scope);
    return {
      status: "ok",
      deploymentState: "DEPLOYED",
      collectorState,
      persistence: true,
      sourceMode: row.source_mode,
      modelAuthority: row.model_authority,
      scope: publicScope(scope),
      modelStart: ledger.modelStart,
      modelEnd: ledger.modelEnd,
      sourceCutoffTimestamp: ledger.sourceCutoffTimestamp,
      coverageVersion,
      quality: ledger.quality,
      coverage: ledger.coverage,
      gaps: conservativelyBoundCoverageGaps(ledger.gaps, 1_024),
      updatedAt: row.updated_at
    };
  }

  const exactWindow = requestedStart === scope.from && requestedEnd === scope.to;
  if (!exactWindow) {
    return {
      status: "ok",
      deploymentState: "DEPLOYED",
      collectorState,
      persistence: true,
      sourceMode: row.source_mode,
      modelAuthority: row.model_authority,
      scope: publicScope(scope),
      modelStart: null,
      modelEnd: null,
      sourceCutoffTimestamp: null,
      coverageVersion,
      quality: "INSUFFICIENT",
      coverage: nullCoverageMeasurements(),
      gaps: [coverageUnknownGap(scope.from, scope.to)],
      updatedAt: row.updated_at
    };
  }

  const storedModelStart = timestampOrNull(row.model_start);
  const storedModelEnd = timestampOrNull(row.model_end);
  if ((storedModelStart === null) !== (storedModelEnd === null)) return coverageUnavailable(scope);
  if (storedModelStart !== null && (storedModelEnd <= storedModelStart || storedModelStart < scope.from || storedModelEnd > scope.to)) {
    return coverageUnavailable(scope);
  }
  const legacyModelStart = storedModelStart;
  const legacyModelEnd = storedModelEnd;
  const legacyGaps = clippedCoverageGaps(row.missing_intervals, scope.from, scope.to);
  appendUnavailableModelEdges(legacyGaps, legacyModelStart, legacyModelEnd, scope.from, scope.to);
  const measurements = {
    trades: nullableNumber(row.trade_coverage_percent),
    openInterest: nullableNumber(row.open_interest_coverage_percent),
    liquidations: nullableNumber(row.liquidation_coverage_percent),
    orderbook: nullableNumber(row.orderbook_coverage_percent),
    funding: nullableNumber(row.funding_coverage_percent),
    continuity: nullableNumber(row.model_continuity_percent)
  };
  return {
    status: "ok",
    deploymentState: "DEPLOYED",
    collectorState,
    persistence: true,
    sourceMode: row.source_mode,
    modelAuthority: row.model_authority,
    scope: publicScope(scope),
    modelStart: legacyModelStart,
    modelEnd: legacyModelEnd,
    sourceCutoffTimestamp: sourceCutoffTimestamp === null ? null : Math.min(sourceCutoffTimestamp, scope.to),
    coverageVersion,
    quality: row.quality,
    coverage: measurements,
    gaps: conservativelyBoundCoverageGaps(legacyGaps, 1_024),
    updatedAt: row.updated_at
  };
}

function deriveRequestedCoverage(scope, value, ledgerStart, ledgerEnd, sourceCutoffTimestamp) {
  const sourceIntervals = normalizeCoverageLedger(value);
  if (!sourceIntervals) return null;
  const evidenceEnd = Math.min(ledgerEnd, sourceCutoffTimestamp);
  if (evidenceEnd <= ledgerStart) return null;
  for (const source of COVERAGE_SOURCES) for (const interval of sourceIntervals[source]) {
    if (interval.start < ledgerStart || interval.end > evidenceEnd) return null;
  }
  const knownStart = Math.max(scope.from, ledgerStart);
  const knownEnd = Math.min(scope.to, evidenceEnd);
  const hasKnownIntersection = knownEnd > knownStart;
  const fullEvidence = scope.from >= ledgerStart && scope.to <= evidenceEnd;
  const clipped = Object.fromEntries(COVERAGE_SOURCES.map((source) => [
    source,
    hasKnownIntersection ? clipAndMergeIntervals(sourceIntervals[source], knownStart, knownEnd) : []
  ]));
  const windowDuration = scope.to - scope.from;
  const coverage = fullEvidence ? {
    trades: coveragePercent(clipped.TRADE, windowDuration),
    openInterest: coveragePercent(clipped.OPEN_INTEREST, windowDuration),
    liquidations: coveragePercent(clipped.LIQUIDATION, windowDuration),
    orderbook: coveragePercent(clipped.BOOK_FRAME, windowDuration),
    funding: coveragePercent(clipped.FUNDING, windowDuration),
    continuity: coveragePercent(clipped.OPEN_INTEREST, windowDuration)
  } : nullCoverageMeasurements();
  const gaps = [];
  if (!hasKnownIntersection) {
    gaps.push(coverageUnknownGap(scope.from, scope.to));
  } else {
    if (scope.from < knownStart) gaps.push(coverageUnknownGap(scope.from, knownStart));
    const boundaries = new Set([knownStart, knownEnd]);
    for (const source of COVERAGE_SOURCES) for (const interval of clipped[source]) {
      boundaries.add(interval.start);
      boundaries.add(interval.end);
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const start = ordered[index - 1];
      const end = ordered[index];
      if (!(end > start)) continue;
      const midpoint = start + (end - start) / 2;
      const missingSources = COVERAGE_SOURCES.filter((source) => !clipped[source].some((interval) => midpoint >= interval.start && midpoint < interval.end));
      if (missingSources.length) appendCoverageGap(gaps, { start, end, missingSources });
    }
    if (knownEnd < scope.to) gaps.push(coverageUnknownGap(knownEnd, scope.to));
  }
  const oi = clipped.OPEN_INTEREST;
  return {
    modelStart: oi[0]?.start ?? null,
    modelEnd: oi.at(-1)?.end ?? null,
    coverage,
    quality: fullEvidence ? requestedCoverageQuality(coverage) : "INSUFFICIENT",
    gaps,
    sourceCutoffTimestamp: Math.min(sourceCutoffTimestamp, scope.to)
  };
}

function normalizeCoverageLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = [];
  for (const source of COVERAGE_SOURCES) {
    const raw = value[source];
    if (!Array.isArray(raw) || raw.length > 8_192) return null;
    const intervals = [];
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      const start = timestampOrNull(candidate.start);
      const end = timestampOrNull(candidate.end);
      if (start === null || end === null || end <= start) return null;
      intervals.push({ start, end });
    }
    entries.push([source, mergeCoverageIntervals(intervals)]);
  }
  return Object.fromEntries(entries);
}

function clipAndMergeIntervals(intervals, start, end) {
  return mergeCoverageIntervals(intervals.map((interval) => ({
    start: Math.max(start, interval.start),
    end: Math.min(end, interval.end)
  })).filter((interval) => interval.end > interval.start));
}

function mergeCoverageIntervals(intervals) {
  const ordered = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  const output = [];
  for (const interval of ordered) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else output.push({ start: interval.start, end: interval.end });
  }
  return output;
}

function coveragePercent(intervals, requestedDuration) {
  if (!(requestedDuration > 0)) return null;
  const observed = intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  return Math.round(Math.max(0, Math.min(100, observed / requestedDuration * 100)) * 1_000) / 1_000;
}

function nullCoverageMeasurements() {
  return { trades: null, openInterest: null, liquidations: null, orderbook: null, funding: null, continuity: null };
}

function coverageUnknownGap(start, end) {
  return { start, end, missingSources: COVERAGE_SOURCES.map((source) => `${source}_COVERAGE_UNKNOWN`) };
}

function requestedCoverageQuality(coverage) {
  const continuity = coverage.continuity;
  const openInterest = coverage.openInterest;
  if (continuity === null || openInterest === null || continuity <= 0) return "INSUFFICIENT";
  const secondary = [
    [coverage.trades, 0.35],
    [coverage.orderbook, 0.25],
    [coverage.liquidations, 0.25],
    [coverage.funding, 0.15]
  ];
  const secondaryScore = secondary.reduce((sum, [measurement, weight]) => sum + (measurement ?? 0) * weight, 0);
  const minimumSecondary = Math.min(...secondary.map(([measurement]) => measurement ?? 0));
  if (continuity >= 99.5 && openInterest >= 99.5 && minimumSecondary >= 95) return "EXCELLENT";
  if (continuity >= 95 && openInterest >= 95 && secondaryScore >= 80 && minimumSecondary >= 50) return "HIGH";
  if (continuity >= 75 && openInterest >= 75 && secondaryScore >= 35) return "MIXED";
  return "LOW";
}

function coverageUnavailable(scope) {
  return {
    ...bclifDeferredPayload(scope),
    coverage: { trades: null, openInterest: null, liquidations: null, orderbook: null, funding: null, continuity: null },
    gaps: [],
    quality: "INSUFFICIENT"
  };
}

function infrastructureError(error) {
  return bclifHttpError(503, "Persistent BCLIF infrastructure is temporarily unavailable.", "BCLIF_INFRASTRUCTURE_UNAVAILABLE", {
    retryable: true,
    sourceCode: String(error?.code || "UNAVAILABLE").slice(0, 32)
  });
}

async function probeBclifBucket(supabase) {
  const { data, error } = await supabase.storage.getBucket(BCLIF_BUCKET_ID);
  if (error) {
    const code = String(error.statusCode || error.status || error.code || "");
    const message = String(error.message || "").toLowerCase();
    if (code === "404" || /bucket.*not found|not found.*bucket|no such bucket/.test(message)) return { available: false };
    throw infrastructureError(error);
  }
  if (!data) return { available: false };
  if (data.public === true) throw bclifHttpError(503, "BCLIF private storage policy is invalid.", "BCLIF_STORAGE_POLICY_INVALID");
  return { available: true };
}

function timestampOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isSupportedPersistentTile(tile) {
  return tile?.model_version === BCLIF_SUPPORTED_MODEL_VERSION
    && Number(tile?.schema_version) === BCLIF_SUPPORTED_SCHEMA_VERSION
    && Number(tile?.tile_version) === BCLIF_SUPPORTED_TILE_VERSION
    && tile?.compression === BCLIF_SUPPORTED_COMPRESSION
    && tile?.model_authority === BCLIF_SUPPORTED_MODEL_AUTHORITY;
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireBoundedScope(scope) {
  if (!scope || !Number.isFinite(scope.from) || !Number.isFinite(scope.to) || scope.to <= scope.from) {
    throw bclifHttpError(400, "A bounded BCLIF manifest range is required.", "INVALID_TIME_RANGE");
  }
}

function intersectRange(start, end, requestedStart, requestedEnd) {
  if (start === null || end === null) return [null, null];
  const clippedStart = Math.max(start, requestedStart);
  const clippedEnd = Math.min(end, requestedEnd);
  return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : [null, null];
}

function clippedCoverageGaps(value, requestedStart, requestedEnd) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const candidate of value.slice(0, 4096)) {
    const start = timestampOrNull(candidate?.start);
    const end = timestampOrNull(candidate?.end);
    if (start === null || end === null || end <= start) continue;
    const clippedStart = Math.max(start, requestedStart);
    const clippedEnd = Math.min(end, requestedEnd);
    if (clippedEnd <= clippedStart) continue;
    const missingSources = Array.isArray(candidate.missingSources)
      ? [...new Set(candidate.missingSources.filter((item) => typeof item === "string").map((item) => item.slice(0, 64)))].sort().slice(0, 16)
      : [];
    appendCoverageGap(output, { start: clippedStart, end: clippedEnd, missingSources });
  }
  return output;
}

function appendUnavailableModelEdges(gaps, modelStart, modelEnd, requestedStart, requestedEnd) {
  if (modelStart === null || modelEnd === null) return;
  const missingSources = ["MODEL_FRAME", "OPEN_INTEREST"];
  if (requestedStart < modelStart) appendCoverageGap(gaps, { start: requestedStart, end: modelStart, missingSources });
  if (modelEnd < requestedEnd) appendCoverageGap(gaps, { start: modelEnd, end: requestedEnd, missingSources });
  gaps.sort((left, right) => left.start - right.start || left.end - right.end);
}

function appendCoverageGap(gaps, gap) {
  const previous = gaps.at(-1);
  if (previous && previous.end === gap.start && previous.missingSources.join("|") === gap.missingSources.join("|")) {
    previous.end = gap.end;
  } else gaps.push(gap);
}

function conservativelyBoundCoverageGaps(gaps, maximum) {
  const ordered = [...gaps].sort((left, right) => left.start - right.start || left.end - right.end);
  if (ordered.length <= maximum) return ordered;
  const groupSize = Math.ceil(ordered.length / maximum);
  const bounded = [];
  for (let index = 0; index < ordered.length; index += groupSize) {
    const group = ordered.slice(index, index + groupSize);
    bounded.push({
      start: group[0].start,
      end: group.at(-1).end,
      // This union can deliberately overstate the missing region between
      // grouped gaps, but can never mislabel an omitted outage as valid.
      missingSources: [...new Set(group.flatMap((gap) => gap.missingSources))].sort()
    });
  }
  return bounded;
}

function heartbeatAge(value) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  const age = Date.now() - parsed;
  // Runtime clock checks should prevent this, but the API independently
  // rejects a heartbeat implausibly far in the future.
  return age < -30_000 ? null : Math.max(0, age);
}
