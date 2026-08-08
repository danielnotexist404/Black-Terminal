import type { Candle } from "../../../chart-engine/types.ts";
import { supabase } from "../../../lib/supabase.ts";
import { liquidationHorizonMs } from "../core/settings.ts";
import { BCLIF_MODEL_VERSION, type BclifPersistentCoverage, type LiquidationFieldSettings, type LiquidationFieldSnapshot } from "../core/types.ts";
import {
  assemblePersistentLiquidationField,
  preflightPersistentLiquidationManifestMemory,
  type PersistentLiquidationFieldCoverageInput
} from "./LiquidationFieldTileAssembler.ts";
import {
  decodeLiquidationFieldTile,
  LiquidationFieldTileCodecUnavailableError,
  LiquidationFieldTileContractError,
  type DecodedLiquidationFieldTile,
  type PersistentTileManifestMetadata
} from "./LiquidationFieldTileCodec.ts";
import { defaultLiquidationFieldTileCacheBytes, LiquidationFieldTileCache } from "./LiquidationFieldTileCache.ts";

const API_ROOT = "/api/liquidation-intelligence";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_TILES = 512;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PersistentLiquidationFieldAccessError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PersistentLiquidationFieldAccessError";
    this.statusCode = statusCode;
  }
}

export class PersistentLiquidationFieldUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PersistentLiquidationFieldUnavailableError";
    this.reason = reason;
  }
}

export type PersistentLiquidationFieldLoadResult =
  | {
      kind: "SNAPSHOT";
      snapshot: LiquidationFieldSnapshot;
      collectorNodeId: string;
      freshness: "LIVE" | "STALE";
      message: string;
    }
  | {
      kind: "WAITING";
      collectorNodeId: string;
      message: string;
    }
  | {
      kind: "FALLBACK";
      reason: string;
      message: string;
    };

export interface PersistentStatusPayload {
  deploymentState: string;
  modelAuthority: string;
  persistence: boolean;
  collector: { nodeId: string; modelVersion?: string; lastHeartbeatAt?: string } | null;
}

interface PersistentManifestPayload {
  deploymentState: string;
  modelAuthority: string;
  persistence: boolean;
  sourceMode: BclifPersistentCoverage["sourceMode"];
  scope: {
    venue: string;
    marketKind: string;
    symbol: string;
    horizon: string;
    requestedStart: number | null;
    requestedEnd: number | null;
    mode: "LIVE" | "REPLAY";
  };
  modelStart: number | null;
  modelEnd: number | null;
  sourceCutoffTimestamp: number | null;
  quality: BclifPersistentCoverage["quality"];
  coverage: {
    trades: number | null;
    openInterest: number | null;
    liquidations: number | null;
    orderbook: number | null;
    funding: number | null;
    continuity: number | null;
  };
  gaps: Array<{ start: number; end: number; missingSources?: string[] }>;
  updatedAt: number;
  tiles: PersistentTileManifestMetadata[];
  liveEdge: PersistentTileManifestMetadata | null;
}

export interface PersistentLiveEdgeCursor {
  tileId: string;
  checksum: string;
  sourceCutoffTimestamp: number;
  tileVersion: number;
  columns: number;
}

export interface PersistentLiquidationFieldClientOptions {
  symbol: string;
  settings: LiquidationFieldSettings;
  getCandles: () => readonly Candle[];
  getReplayActive?: () => boolean;
  getAuthenticationToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export class PersistentLiquidationFieldClient {
  private settings: LiquidationFieldSettings;
  private readonly tileCache = new LiquidationFieldTileCache<DecodedLiquidationFieldTile>(
    defaultLiquidationFieldTileCacheBytes()
  );
  private liveEdgeCursor: PersistentLiveEdgeCursor | null = null;
  private lastReplayActive: boolean | null = null;

  constructor(private readonly options: PersistentLiquidationFieldClientOptions) {
    this.settings = options.settings;
  }

  updateSettings(settings: LiquidationFieldSettings) {
    const scopeChanged = settings.horizon !== this.settings.horizon || settings.customHours !== this.settings.customHours;
    this.settings = settings;
    if (scopeChanged) {
      this.tileCache.clear();
      this.liveEdgeCursor = null;
    }
    return scopeChanged;
  }

  async load(signal: AbortSignal, retryLiveRevision = true): Promise<PersistentLiquidationFieldLoadResult> {
    // Authenticated cursor-style polling: each manifest may contain immutable
    // finalized roots plus one cumulative PERSISTENT_NODE STAGING microtile. The same
    // checksum cache is reused until the collector publishes a new cursor;
    // no browser model or unauthenticated WebSocket is mixed into this path.
    const token = await (this.options.getAuthenticationToken?.() ?? authenticationToken());
    const statusResponse = await this.requestJson("status", token, new URLSearchParams(), signal, true);
    if (statusResponse.kind === "FALLBACK" && (!statusResponse.payload || !statusResponse.statusCode)) return statusResponse;
    const status = parseStatus(statusResponse.payload);
    const statusCode = statusResponse.statusCode ?? 0;
    if (status.deploymentState === "LIVE" && status.modelAuthority === "PERSISTENT_NODE" && status.persistence && !status.collector?.nodeId) {
      throw contract("BCLIF_STATUS_NODE", "Persistent BCLIF status omitted its collector node identity.");
    }
    const freshness = persistentStatusDisposition(status, statusCode);
    if (!freshness) {
      return {
        kind: "FALLBACK",
        reason: status.deploymentState || "NOT_DEPLOYED",
        message: "Persistent BCLIF control plane has no verified persistent authority for this session."
      };
    }
    const collectorNodeId = status.collector?.nodeId;
    if (!collectorNodeId) throw contract("BCLIF_STATUS_NODE", "Persistent BCLIF status omitted its collector node identity.");

    const query = this.scopeQuery();
    const manifestResponse = await this.requestJson("manifest", token, query, signal, true);
    if (manifestResponse.kind === "FALLBACK") {
      return {
        kind: "FALLBACK",
        reason: manifestResponse.reason,
        message: manifestResponse.message
      };
    }
    const manifest = parseManifest(manifestResponse.payload, this.options.symbol, this.settings.horizon, query);
    const requestedEnd = manifest.scope.requestedEnd!;
    const resolvedManifest = resolvePersistentManifestTiles(
      manifest.tiles,
      manifest.liveEdge,
      this.liveEdgeCursor,
      requestedEnd,
      manifest.scope.mode
    );
    const manifestTiles = resolvedManifest.tiles;
    if (freshness === "STALE" && !manifestTiles.length) {
      return {
        kind: "FALLBACK",
        reason: "NO_VERIFIED_PERSISTENT_TILES",
        message: "The persistent collector is stale and no verified durable tiles cover this chart window."
      };
    }
    if (!manifestTiles.length && (manifest.modelAuthority !== "PERSISTENT_NODE" || !manifest.persistence)) {
      return {
        kind: "WAITING",
        collectorNodeId,
        message: "Persistent collector is live; durable coverage for this horizon has not been published yet."
      };
    }
    if (manifest.modelAuthority !== "PERSISTENT_NODE" || !manifest.persistence) {
      throw contract("BCLIF_MANIFEST_AUTHORITY", "A live persistent collector returned a non-persistent manifest authority.");
    }
    if (!manifestTiles.length) {
      return {
        kind: "WAITING",
        collectorNodeId,
        message: "Persistent collector is live; waiting for the first finalized tile in this horizon."
      };
    }
    preflightPersistentLiquidationManifestMemory(manifestTiles, this.tileCache.metrics().maximumBytes, {
      start: manifest.scope.requestedStart ?? manifestTiles[0]!.startTime,
      end: manifest.scope.requestedEnd ?? manifestTiles.at(-1)!.endTime
    });

    const first = manifestTiles[0]!;
    this.tileCache.invalidateVersions({
      venue: first.venue,
      symbol: first.symbol,
      horizon: first.horizon,
      modelVersion: first.modelVersion,
      schemaVersion: first.schemaVersion
    });
    const decoded: DecodedLiquidationFieldTile[] = [];
    for (const tile of manifestTiles) {
      throwIfAborted(signal);
      const cached = this.tileCache.get(tile);
      if (cached) {
        decoded.push(cached);
        continue;
      }
      const tileQuery = persistentTileQuery(query, tile.tileId, tile.checksum);
      let tileBytes: ArrayBuffer;
      try {
        tileBytes = await this.requestBytes("tile", token, tileQuery, signal);
      } catch (error) {
        if (error instanceof PersistentLiquidationFieldUnavailableError && error.reason === "LIVE_EDGE_ADVANCED") {
          if (retryLiveRevision) return this.load(signal, false);
          return {
            kind: "WAITING",
            collectorNodeId,
            message: "Persistent live edge advanced twice during verification; retaining the last verified field until the next bounded manifest poll."
          };
        }
        throw error;
      }
      const decodedTile = await decodeLiquidationFieldTile(tileBytes, tile);
      this.tileCache.set(tile, decodedTile, decodedTile.decodedBytes);
      decoded.push(decodedTile);
    }

    const snapshot = assemblePersistentLiquidationField(decoded, {
      collectorNodeId,
      coverage: manifestCoverage(manifest)
    });
    this.liveEdgeCursor = resolvedManifest.nextCursor;
    return {
      kind: "SNAPSHOT",
      snapshot,
      collectorNodeId,
      freshness,
      message: `${manifest.tiles.length} finalized root${manifest.tiles.length === 1 ? "" : "s"}${manifest.liveEdge ? " + verified hot microtile" : ""}; ${manifest.coverage.continuity?.toFixed(1) ?? "MISSING"}% continuity${freshness === "STALE" ? " · collector stale" : ""}.`
    };
  }

  async probe(signal: AbortSignal) {
    const token = await (this.options.getAuthenticationToken?.() ?? authenticationToken());
    const response = await this.requestJson("status", token, new URLSearchParams(), signal, true);
    if (response.kind === "FALLBACK" && (!response.payload || !response.statusCode)) return false;
    const status = parseStatus(response.payload);
    return persistentStatusDisposition(status, response.statusCode ?? 0) !== null;
  }

  clear() {
    this.tileCache.clear();
    this.liveEdgeCursor = null;
    this.lastReplayActive = null;
  }

  metrics() {
    return this.tileCache.metrics();
  }

  private scopeQuery() {
    const replayActive = this.options.getReplayActive?.() ?? false;
    if (this.lastReplayActive !== null && replayActive !== this.lastReplayActive) this.liveEdgeCursor = null;
    this.lastReplayActive = replayActive;
    const { requestedStart, requestedEnd, mode } = persistentLiquidationFieldRequestRange(
      this.options.getCandles(),
      liquidationHorizonMs(this.settings),
      replayActive
    );
    return new URLSearchParams({
      venue: "BYBIT",
      marketKind: "linear_perpetual",
      symbol: normalizedSymbol(this.options.symbol),
      horizon: this.settings.horizon,
      from: String(Math.round(requestedStart)),
      to: String(Math.round(requestedEnd)),
      mode
    });
  }

  private async requestJson(
    action: string,
    token: string,
    query: URLSearchParams,
    signal: AbortSignal,
    fallbackSafe: boolean
  ): Promise<
    | { kind: "JSON"; payload: unknown; statusCode: number }
    | (Extract<PersistentLiquidationFieldLoadResult, { kind: "FALLBACK" }> & { payload?: unknown; statusCode?: number })
  > {
    let response: Response;
    try {
      response = await boundedFetch(`${API_ROOT}/${action}${query.size ? `?${query}` : ""}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal
      }, this.options.fetchImpl);
    } catch (error) {
      if (isAbort(error)) throw error;
      if (fallbackSafe && isNetworkFailure(error)) {
        return { kind: "FALLBACK", reason: "NETWORK", message: "Persistent BCLIF endpoint is unreachable." };
      }
      throw new PersistentLiquidationFieldUnavailableError("NETWORK", "Persistent BCLIF endpoint is unreachable.");
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      throw new PersistentLiquidationFieldAccessError(response.status, publicError(payload, "BCLIF access is not authorized."));
    }
    if (fallbackSafe && (response.status === 404 || response.status === 502 || response.status === 503 || response.status === 504)) {
      return {
        kind: "FALLBACK",
        reason: response.status === 404 ? "NOT_DEPLOYED" : "TEMPORARILY_UNAVAILABLE",
        message: publicError(payload, "Persistent BCLIF infrastructure is not available."),
        payload: payload ?? undefined,
        statusCode: response.status
      };
    }
    if (!response.ok) throw contract("BCLIF_API_RESPONSE", publicError(payload, `Persistent BCLIF request failed (${response.status}).`));
    if (!payload || typeof payload !== "object") throw contract("BCLIF_API_JSON", "Persistent BCLIF returned an invalid JSON payload.");
    return { kind: "JSON", payload, statusCode: response.status };
  }

  private async requestBytes(action: string, token: string, query: URLSearchParams, signal: AbortSignal) {
    let response: Response;
    try {
      response = await boundedFetch(`${API_ROOT}/${action}?${query}`, {
        headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token}` },
        signal
      }, this.options.fetchImpl);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new PersistentLiquidationFieldUnavailableError("NETWORK", "A persistent BCLIF tile could not be downloaded.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new PersistentLiquidationFieldAccessError(response.status, "BCLIF tile access is not authorized.");
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const code = payload && typeof payload === "object" ? String((payload as Record<string, unknown>).code || "") : "";
      if (response.status === 410 && (code === "LIVE_EDGE_ADVANCED" || code === "TILE_REVISION_MISMATCH")) {
        throw new PersistentLiquidationFieldUnavailableError("LIVE_EDGE_ADVANCED", "The persistent live-edge revision advanced during verification.");
      }
      if ([404, 410, 429, 502, 503, 504].includes(response.status)) {
        throw new PersistentLiquidationFieldUnavailableError(`HTTP_${response.status}`, publicError(payload, "A persistent BCLIF tile is temporarily unavailable."));
      }
      throw contract("BCLIF_TILE_RESPONSE", publicError(payload, `Persistent BCLIF tile request failed (${response.status}).`));
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > 50 * 1024 * 1024) throw contract("BCLIF_TILE_BOUND", "Persistent BCLIF tile exceeds the download safety bound.");
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) throw contract("BCLIF_TILE_BOUND", "Persistent BCLIF tile has an invalid byte length.");
    return bytes;
  }
}

async function authenticationToken() {
  if (!supabase) throw new PersistentLiquidationFieldAccessError(401, "Sign in to access persistent BCLIF market memory.");
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) throw new PersistentLiquidationFieldAccessError(401, "Your BCLIF session is unavailable. Sign in again.");
  return token;
}

async function boundedFetch(resource: string, init: RequestInit & { signal: AbortSignal }, fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init.signal.reason);
  init.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException("BCLIF request timed out.", "TimeoutError")), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(resource, { ...init, credentials: "same-origin", cache: "no-store", signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    init.signal.removeEventListener("abort", forwardAbort);
  }
}

function parseStatus(value: unknown): PersistentStatusPayload {
  const payload = object(value, "status");
  const collectorValue = payload.collector;
  const collector = collectorValue === null || collectorValue === undefined
    ? null
    : {
        nodeId: strictText(object(collectorValue, "collector").nodeId, "collector.nodeId"),
        modelVersion: optionalText(object(collectorValue, "collector").modelVersion),
        lastHeartbeatAt: optionalText(object(collectorValue, "collector").lastHeartbeatAt)
      };
  return {
    deploymentState: strictText(payload.deploymentState, "deploymentState"),
    modelAuthority: strictText(payload.modelAuthority, "modelAuthority"),
    persistence: payload.persistence === true,
    collector
  };
}

export function persistentStatusDisposition(
  status: PersistentStatusPayload,
  httpStatus: number
): "LIVE" | "STALE" | null {
  const hasCollector = Boolean(status.collector?.nodeId);
  if (
    httpStatus >= 200 && httpStatus < 300
    && status.deploymentState === "LIVE"
    && status.modelAuthority === "PERSISTENT_NODE"
    && status.persistence
    && hasCollector
  ) return "LIVE";
  if (
    hasCollector
    && status.modelAuthority === "PERSISTENT_NODE"
    && status.persistence
    && (status.deploymentState === "TEMPORARILY_UNAVAILABLE" || status.deploymentState === "DEGRADED")
    && (httpStatus === 200 || httpStatus === 503)
  ) return "STALE";
  return null;
}

export function persistentTileQuery(manifestQuery: URLSearchParams, tileId: string, checksum: string) {
  const requestedStart = manifestQuery.get("from");
  const requestedEnd = manifestQuery.get("to");
  const mode = manifestQuery.get("mode")?.toUpperCase();
  if (
    !requestedStart
    || !requestedEnd
    || !Number.isFinite(Number(requestedStart))
    || !Number.isFinite(Number(requestedEnd))
    || Number(requestedEnd) <= Number(requestedStart)
    || (mode !== "LIVE" && mode !== "REPLAY")
  ) {
    throw contract("BCLIF_TILE_REQUEST_SCOPE", "Persistent BCLIF tile download omitted its verified replay range.");
  }
  if (!CHECKSUM_PATTERN.test(checksum.toLowerCase())) {
    throw contract("BCLIF_TILE_REQUEST_CHECKSUM", "Persistent BCLIF tile download omitted its exact manifest revision checksum.");
  }
  const tileQuery = new URLSearchParams(manifestQuery);
  tileQuery.set("tileId", tileId);
  tileQuery.set("checksum", checksum.toLowerCase());
  return tileQuery;
}

function parseManifest(value: unknown, requestedSymbol: string, requestedHorizon: string, query: URLSearchParams): PersistentManifestPayload {
  const payload = object(value, "manifest");
  const scope = object(payload.scope, "scope");
  const requestRange = persistentManifestRequestRange(scope, query);
  const coverage = object(payload.coverage, "coverage");
  const expectedSymbol = normalizedSymbol(requestedSymbol);
  const venue = strictText(scope.venue, "scope.venue").toUpperCase();
  const symbol = strictText(scope.symbol, "scope.symbol").toUpperCase();
  const horizon = strictText(scope.horizon, "scope.horizon").toUpperCase();
  if (venue !== "BYBIT" || symbol !== expectedSymbol || horizon !== requestedHorizon.toUpperCase()) {
    throw contract("BCLIF_SCOPE_MISMATCH", "Persistent BCLIF manifest scope does not match the chart request.");
  }
  const rawTiles = payload.tiles;
  if (!Array.isArray(rawTiles) || rawTiles.length > MAX_MANIFEST_TILES) {
    throw contract("BCLIF_MANIFEST_TILES", "Persistent BCLIF manifest tile count is invalid.");
  }
  const ids = new Set<string>();
  const tiles = rawTiles.map((raw, index) => {
    const tile = parseManifestTile(raw, { venue, symbol, horizon }, "FINALIZED");
    if (ids.has(tile.tileId)) throw contract("BCLIF_DUPLICATE_TILE", `Persistent BCLIF manifest contains duplicate tile ${index}.`);
    ids.add(tile.tileId);
    return tile;
  });
  const liveEdge = payload.liveEdge === null || payload.liveEdge === undefined
    ? null
    : parseManifestTile(payload.liveEdge, { venue, symbol, horizon }, "STAGING");
  const modelStart = optionalFinite(payload.modelStart);
  const modelEnd = optionalFinite(payload.modelEnd);
  if ((modelStart === null) !== (modelEnd === null)) {
    throw contract("BCLIF_MODEL_RANGE", "Persistent BCLIF model bounds must be a complete pair.");
  }
  if (modelStart !== null && (
    modelEnd! <= modelStart
    || modelStart < requestRange.requestedStart
    || modelEnd! > requestRange.requestedEnd
  )) {
    throw contract("BCLIF_MODEL_RANGE", "Persistent BCLIF model bounds exceed the authorized request range.");
  }
  const sourceCutoffTimestamp = optionalFinite(payload.sourceCutoffTimestamp);
  if (sourceCutoffTimestamp !== null && sourceCutoffTimestamp > requestRange.requestedEnd) {
    throw contract("BCLIF_SOURCE_CUTOFF", "Persistent BCLIF source cutoff exceeds the authorized request range.");
  }
  if (sourceCutoffTimestamp !== null && modelEnd !== null && sourceCutoffTimestamp < modelEnd) {
    throw contract("BCLIF_SOURCE_CUTOFF", "Persistent BCLIF source cutoff precedes the modeled interval.");
  }
  return {
    deploymentState: strictText(payload.deploymentState, "deploymentState"),
    modelAuthority: strictText(payload.modelAuthority, "modelAuthority"),
    persistence: payload.persistence === true,
    sourceMode: persistentSourceMode(payload.sourceMode),
    scope: {
      venue,
      marketKind: strictText(scope.marketKind, "scope.marketKind"),
      symbol,
      horizon,
      requestedStart: requestRange.requestedStart,
      requestedEnd: requestRange.requestedEnd,
      mode: requestRange.mode
    },
    modelStart,
    modelEnd,
    sourceCutoffTimestamp,
    quality: coverageQuality(payload.quality),
    coverage: {
      trades: optionalPercent(coverage.trades),
      openInterest: optionalPercent(coverage.openInterest),
      liquidations: optionalPercent(coverage.liquidations),
      orderbook: optionalPercent(coverage.orderbook),
      funding: optionalPercent(coverage.funding),
      continuity: optionalPercent(coverage.continuity)
    },
    gaps: parsePersistentCoverageGaps(payload.gaps, requestRange),
    updatedAt: timestamp(payload.updatedAt, "updatedAt", Date.now()),
    tiles,
    liveEdge
  };
}

export function persistentManifestRequestRange(scope: Record<string, unknown>, query: URLSearchParams) {
  const queryStart = Number(query.get("from"));
  const queryEnd = Number(query.get("to"));
  const scopeStart = requiredFinite(scope.requestedStart, "scope.requestedStart");
  const scopeEnd = requiredFinite(scope.requestedEnd, "scope.requestedEnd");
  const queryMode = query.get("mode")?.toUpperCase();
  const scopeMode = strictText(scope.mode, "scope.mode").toUpperCase();
  if (
    !Number.isFinite(queryStart)
    || !Number.isFinite(queryEnd)
    || queryEnd <= queryStart
    || scopeStart !== queryStart
    || scopeEnd !== queryEnd
    || (queryMode !== "LIVE" && queryMode !== "REPLAY")
    || scopeMode !== queryMode
  ) {
    throw contract("BCLIF_MANIFEST_REQUEST_SCOPE", "Persistent BCLIF manifest range does not exactly match the requested replay boundary.");
  }
  return { requestedStart: scopeStart, requestedEnd: scopeEnd, mode: scopeMode as "LIVE" | "REPLAY" };
}

function parseManifestTile(
  value: unknown,
  scope: { venue: string; symbol: string; horizon: string },
  expectedPublicationState: "FINALIZED" | "STAGING"
): PersistentTileManifestMetadata {
  const tile = object(value, "tile");
  const tileId = strictText(tile.tileId, "tileId").toLowerCase();
  const checksum = strictText(tile.checksum, "checksum").toLowerCase();
  if (!UUID_PATTERN.test(tileId)) throw contract("BCLIF_TILE_ID", "Persistent BCLIF manifest contains an invalid opaque tile id.");
  if (!CHECKSUM_PATTERN.test(checksum)) throw contract("BCLIF_TILE_CHECKSUM", "Persistent BCLIF manifest contains an invalid checksum.");
  const columns = boundedInteger(tile.columns, "columns", 1, 4_096);
  const rows = boundedInteger(tile.rows, "rows", 1, 1_024);
  if (columns * rows > 8_388_608) throw contract("BCLIF_TILE_GRID", "Persistent BCLIF tile grid exceeds the client safety bound.");
  const declaredPublicationState = optionalText(tile.publicationState)?.toUpperCase();
  if (
    (expectedPublicationState === "STAGING" && declaredPublicationState !== "STAGING")
    || (expectedPublicationState === "FINALIZED" && declaredPublicationState !== undefined && declaredPublicationState !== "FINALIZED")
  ) {
    throw contract("BCLIF_TILE_PUBLICATION_STATE", `Persistent BCLIF ${expectedPublicationState.toLowerCase()} tile has an invalid publication state.`);
  }
  const tileVersion = boundedInteger(tile.tileVersion, "tileVersion", 1, Number.MAX_SAFE_INTEGER);
  if (tileVersion !== 1) throw contract("BCLIF_TILE_VERSION", "Persistent BCLIF manifest uses an unsupported codec tile version.");
  const metadata: PersistentTileManifestMetadata = {
    tileId,
    venue: scope.venue,
    symbol: scope.symbol,
    horizon: strictText(tile.horizon, "horizon").toUpperCase(),
    startTime: requiredFinite(tile.startTime, "startTime"),
    endTime: requiredFinite(tile.endTime, "endTime"),
    minPrice: requiredFinite(tile.minPrice, "minPrice"),
    maxPrice: requiredFinite(tile.maxPrice, "maxPrice"),
    timeStepMs: requiredFinite(tile.timeStepMs, "timeStepMs"),
    priceStep: requiredFinite(tile.priceStep, "priceStep"),
    columns,
    rows,
    modelVersion: strictText(tile.modelVersion, "modelVersion"),
    schemaVersion: boundedInteger(tile.schemaVersion, "schemaVersion", 2, 2),
    tileVersion,
    checksum,
    compressedBytes: boundedInteger(tile.compressedBytes, "compressedBytes", 1, 50 * 1024 * 1024),
    sourceCutoffTimestamp: requiredFinite(tile.sourceCutoffTimestamp, "sourceCutoffTimestamp"),
    coverageQuality: strictText(tile.coverageQuality, "coverageQuality"),
    modelAuthority: strictText(tile.modelAuthority, "modelAuthority") as PersistentTileManifestMetadata["modelAuthority"],
    publicationState: expectedPublicationState,
    channelManifest: optionalObject(tile.channelManifest),
    scaleMetadata: optionalObject(tile.scaleMetadata),
    publishedAt: optionalText(tile.publishedAt)
  };
  if (metadata.horizon !== scope.horizon || metadata.modelAuthority !== "PERSISTENT_NODE") {
    throw contract("BCLIF_TILE_SCOPE", "Persistent BCLIF tile metadata escaped its manifest authority.");
  }
  if (metadata.modelVersion !== BCLIF_MODEL_VERSION) {
    throw contract("BCLIF_MODEL_VERSION", "Persistent BCLIF tile model version is not supported by this client.");
  }
  return metadata;
}

export function resolvePersistentManifestTiles(
  finalizedTiles: readonly PersistentTileManifestMetadata[],
  liveEdge: PersistentTileManifestMetadata | null,
  previousCursor: PersistentLiveEdgeCursor | null,
  requestedEnd: number,
  requestMode: "LIVE" | "REPLAY" = "LIVE"
): {
  tiles: PersistentTileManifestMetadata[];
  nextCursor: PersistentLiveEdgeCursor | null;
} {
  if (!Number.isFinite(requestedEnd)) {
    throw contract("BCLIF_LIVE_EDGE_BOUND", "Persistent BCLIF live-edge validation requires a finite request cutoff.");
  }
  if (requestMode === "REPLAY" && liveEdge) {
    throw contract("BCLIF_REPLAY_LIVE_EDGE", "Historical BCLIF replay may contain FINALIZED roots only.");
  }
  for (const tile of finalizedTiles) {
    if (tile.publicationState && tile.publicationState !== "FINALIZED") {
      throw contract("BCLIF_LIVE_EDGE_STATE", "Persistent BCLIF finalized roots contain a non-final publication.");
    }
  }

  const previousClosure = previousCursor
    ? finalizedTiles.find((tile) => sameLiveEdgeIdentity(tile, previousCursor)) ?? null
    : null;

  if (!liveEdge) {
    if (previousCursor && !previousClosure) {
      throw contract("BCLIF_LIVE_EDGE_ROLLOVER", "Persistent BCLIF removed a hot microtile before publishing its identical finalized root.");
    }
    return { tiles: [...finalizedTiles], nextCursor: null };
  }
  if (liveEdge.publicationState !== "STAGING") {
    throw contract("BCLIF_LIVE_EDGE_STATE", "Persistent BCLIF live-edge metadata must be explicitly STAGING.");
  }
  if (
    liveEdge.columns < 2
    || liveEdge.endTime <= liveEdge.startTime
    || liveEdge.sourceCutoffTimestamp < liveEdge.endTime
    || liveEdge.sourceCutoffTimestamp > requestedEnd
  ) {
    throw contract("BCLIF_LIVE_EDGE_BOUND", "Persistent BCLIF live edge is incomplete or exceeds the exact request cutoff.");
  }
  if (
    liveEdge.modelAuthority !== "PERSISTENT_NODE"
    || liveEdge.modelVersion !== BCLIF_MODEL_VERSION
    || liveEdge.schemaVersion !== 2
    || liveEdge.tileVersion !== 1
    || liveEdge.timeStepMs <= 0
    || liveEdge.priceStep <= 0
    || Math.abs(liveEdge.endTime - (liveEdge.startTime + (liveEdge.columns - 1) * liveEdge.timeStepMs)) > 1
    || Math.abs(liveEdge.maxPrice - (liveEdge.minPrice + (liveEdge.rows - 1) * liveEdge.priceStep)) > Math.max(1e-8, Math.abs(liveEdge.priceStep) * 1e-7)
  ) {
    throw contract("BCLIF_LIVE_EDGE_GENERATION", "Persistent BCLIF live edge has an invalid authority, model, schema, or lattice.");
  }
  const rootReference = finalizedTiles[0];
  if (rootReference && (
    liveEdge.venue !== rootReference.venue
    || liveEdge.symbol !== rootReference.symbol
    || liveEdge.horizon !== rootReference.horizon
    || liveEdge.modelVersion !== rootReference.modelVersion
    || liveEdge.schemaVersion !== rootReference.schemaVersion
    || liveEdge.timeStepMs !== rootReference.timeStepMs
    || Math.abs(liveEdge.priceStep - rootReference.priceStep) > Math.max(1e-8, Math.abs(rootReference.priceStep) * 1e-7)
    || !latticeAligned(liveEdge.startTime, rootReference.startTime, rootReference.timeStepMs)
    || !latticeAligned(liveEdge.minPrice, rootReference.minPrice, rootReference.priceStep)
  )) {
    throw contract("BCLIF_LIVE_EDGE_GENERATION", "Persistent BCLIF live edge does not match the finalized root generation and grid.");
  }

  const finalizedDuplicate = finalizedTiles.find((tile) => tile.tileId === liveEdge.tileId) ?? null;
  if (finalizedDuplicate) {
    if (!sameLiveEdgeIdentity(finalizedDuplicate, cursorFor(liveEdge))) {
      throw contract("BCLIF_LIVE_EDGE_ROLLOVER", "Persistent BCLIF reused a finalized tile id for conflicting STAGING content.");
    }
    if (previousCursor && liveEdge.tileId !== previousCursor.tileId && !previousClosure) {
      throw contract("BCLIF_LIVE_EDGE_ROLLOVER", "Persistent BCLIF advanced past an unfinalized live-edge cursor.");
    }
    return { tiles: [...finalizedTiles], nextCursor: null };
  }

  const latestFinalizedEnd = finalizedTiles.reduce((latest, tile) => Math.max(latest, tile.endTime), -Infinity);
  if (Number.isFinite(latestFinalizedEnd) && liveEdge.startTime <= latestFinalizedEnd) {
    throw contract("BCLIF_LIVE_EDGE_OVERLAP", "Persistent BCLIF live edge overlaps an immutable finalized root.");
  }

  if (previousCursor) {
    if (liveEdge.tileId === previousCursor.tileId) {
      if (liveEdge.sourceCutoffTimestamp < previousCursor.sourceCutoffTimestamp) {
        throw contract("BCLIF_LIVE_EDGE_NON_MONOTONIC", "Persistent BCLIF live-edge source cutoff moved backwards.");
      }
      if (liveEdge.sourceCutoffTimestamp === previousCursor.sourceCutoffTimestamp) {
        if (!sameLiveEdgeIdentity(liveEdge, previousCursor)) {
          throw contract("BCLIF_LIVE_EDGE_NON_MONOTONIC", "Persistent BCLIF mutated a published live-edge cursor in place.");
        }
      } else if (
        liveEdge.tileVersion !== previousCursor.tileVersion
        || liveEdge.checksum === previousCursor.checksum
        || liveEdge.columns <= previousCursor.columns
      ) {
        throw contract("BCLIF_LIVE_EDGE_NON_MONOTONIC", "Persistent BCLIF advanced a hot cutoff without a new immutable tile revision.");
      }
    } else {
      if (!previousClosure || liveEdge.sourceCutoffTimestamp <= previousCursor.sourceCutoffTimestamp) {
        throw contract("BCLIF_LIVE_EDGE_ROLLOVER", "Persistent BCLIF advanced to a new hot bucket before finalizing the previous cursor.");
      }
    }
  }

  return {
    tiles: [...finalizedTiles, liveEdge],
    nextCursor: cursorFor(liveEdge)
  };
}

export function persistentLiquidationFieldRequestRange(
  candles: readonly Candle[],
  horizonMs: number,
  replayActive: boolean,
  now = Date.now()
) {
  if (!Number.isFinite(horizonMs) || horizonMs <= 0 || !Number.isFinite(now)) {
    throw contract("BCLIF_REQUEST_WINDOW", "Persistent BCLIF request range inputs are invalid.");
  }
  const last = candles.at(-1);
  if (!last) return { requestedStart: now - horizonMs, requestedEnd: now, mode: "LIVE" } as const;
  const chartEnd = last.time * 1_000;
  if (!Number.isFinite(chartEnd)) throw contract("BCLIF_REQUEST_WINDOW", "Persistent BCLIF chart cutoff is invalid.");

  // Replay remains locked to the selected candle timestamp. A live candle is
  // allowed to accumulate through wall-clock time, but never beyond its own
  // close. This admits minute collector updates on 1H/4H/1D charts without
  // granting the server a future boundary.
  const requestedEnd = replayActive
    ? chartEnd
    : Math.min(chartEnd + inferredCandleIntervalMs(candles), now);
  const mode = replayActive || requestedEnd < now - 5 * 60_000 ? "REPLAY" : "LIVE";
  return { requestedStart: requestedEnd - horizonMs, requestedEnd, mode } as const;
}

function inferredCandleIntervalMs(candles: readonly Candle[]) {
  for (let index = candles.length - 1; index > 0; index--) {
    const interval = (candles[index]!.time - candles[index - 1]!.time) * 1_000;
    if (Number.isFinite(interval) && interval > 0) return interval;
  }
  return 60_000;
}

function cursorFor(tile: PersistentTileManifestMetadata): PersistentLiveEdgeCursor {
  return {
    tileId: tile.tileId,
    checksum: tile.checksum,
    sourceCutoffTimestamp: tile.sourceCutoffTimestamp,
    tileVersion: tile.tileVersion,
    columns: tile.columns
  };
}

function sameLiveEdgeIdentity(
  tile: PersistentTileManifestMetadata,
  cursor: PersistentLiveEdgeCursor
) {
  return tile.tileId === cursor.tileId
    && tile.checksum === cursor.checksum
    && tile.sourceCutoffTimestamp === cursor.sourceCutoffTimestamp
    && tile.tileVersion === cursor.tileVersion
    && tile.columns === cursor.columns;
}

function latticeAligned(value: number, origin: number, step: number) {
  const offset = (value - origin) / step;
  return Number.isFinite(offset) && Math.abs(offset - Math.round(offset)) <= 1e-5;
}

function manifestCoverage(manifest: PersistentManifestPayload): PersistentLiquidationFieldCoverageInput {
  const allTiles = manifest.liveEdge ? [...manifest.tiles, manifest.liveEdge] : manifest.tiles;
  return {
    venue: manifest.scope.venue,
    symbol: manifest.scope.symbol,
    horizon: manifest.scope.horizon,
    requestedStart: manifest.scope.requestedStart ?? allTiles[0]!.startTime,
    requestedEnd: manifest.scope.requestedEnd ?? allTiles.at(-1)!.endTime,
    modelStart: manifest.modelStart,
    modelEnd: manifest.modelEnd,
    coverage: manifest.coverage,
    gaps: manifest.gaps,
    quality: manifest.quality,
    sourceMode: manifest.sourceMode,
    updatedAt: manifest.updatedAt
  };
}

export function parsePersistentCoverageGaps(
  value: unknown,
  requestRange: { requestedStart: number; requestedEnd: number }
) {
  if (!Array.isArray(value)) throw contract("BCLIF_COVERAGE_GAPS", "Persistent BCLIF coverage gaps are invalid.");
  if (value.length > 1_024) {
    throw contract("BCLIF_COVERAGE_GAPS_BOUND", "Persistent BCLIF coverage gap count exceeds the fail-closed client bound.");
  }
  return value.map((item) => {
    const gap = object(item, "coverage gap");
    const start = timestamp(gap.start, "gap.start");
    const end = timestamp(gap.end, "gap.end");
    if (end <= start) throw contract("BCLIF_COVERAGE_GAP", "Persistent BCLIF coverage gap has invalid bounds.");
    if (start < requestRange.requestedStart || end > requestRange.requestedEnd) {
      throw contract("BCLIF_COVERAGE_GAP_SCOPE", "Persistent BCLIF coverage gap exceeds the authorized request range.");
    }
    return {
      start,
      end,
      missingSources: Array.isArray(gap.missingSources)
        ? gap.missingSources.filter((source): source is string => typeof source === "string").slice(0, 16)
        : []
    };
  });
}

function persistentSourceMode(value: unknown): BclifPersistentCoverage["sourceMode"] {
  if (value === "PERSISTENT_COLLECTOR" || value === "BROWSER_SESSION" || value === "MIXED" || value === "UNAVAILABLE") return value;
  throw contract("BCLIF_SOURCE_MODE", "Persistent BCLIF source mode is invalid.");
}

function coverageQuality(value: unknown): BclifPersistentCoverage["quality"] {
  if (value === "EXCELLENT" || value === "HIGH" || value === "MIXED" || value === "LOW" || value === "INSUFFICIENT") return value;
  throw contract("BCLIF_COVERAGE_QUALITY", "Persistent BCLIF coverage quality is invalid.");
}

function normalizedSymbol(value: string) {
  const symbol = value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw contract("BCLIF_SYMBOL", "The chart symbol is invalid for persistent BCLIF.");
  return symbol;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contract("BCLIF_API_CONTRACT", `Persistent BCLIF ${name} is invalid.`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strictText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw contract("BCLIF_API_CONTRACT", `Persistent BCLIF ${name} is invalid.`);
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : undefined;
}

function requiredFinite(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contract("BCLIF_API_CONTRACT", `Persistent BCLIF ${name} is invalid.`);
  }
  return value;
}

function optionalFinite(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contract("BCLIF_API_CONTRACT", "Persistent BCLIF optional numeric field is invalid.");
  }
  return value;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number) {
  const numeric = requiredFinite(value, name);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw contract("BCLIF_API_CONTRACT", `Persistent BCLIF ${name} is outside the supported range.`);
  }
  return numeric;
}

function optionalPercent(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw contract("BCLIF_COVERAGE", "Persistent BCLIF coverage percentage is invalid.");
  }
  return value;
}

function timestamp(value: unknown, name: string, fallback?: number) {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw contract("BCLIF_TIMESTAMP", `Persistent BCLIF ${name} is missing.`);
  }
  const numeric = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(numeric)) throw contract("BCLIF_TIMESTAMP", `Persistent BCLIF ${name} is invalid.`);
  return numeric;
}

function publicError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const text = record.error ?? record.message;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 240) : fallback;
}

function isNetworkFailure(error: unknown) {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === "TimeoutError")
    || (error instanceof Error && /network|fetch|timeout/i.test(error.message));
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("BCLIF request aborted.", "AbortError");
}

function contract(code: string, message: string) {
  return new LiquidationFieldTileContractError(code, message);
}

export function persistentErrorAllowsInitialBrowserFallback(error: unknown) {
  return error instanceof PersistentLiquidationFieldUnavailableError
    || error instanceof LiquidationFieldTileCodecUnavailableError
    || isNetworkFailure(error);
}
