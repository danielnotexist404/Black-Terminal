import type { Server } from "node:http";
import type { ConfirmedLiquidationEvent, LiquidationInstrumentRules } from "../../../src/modules/liquidation-field/core/types.ts";
import type {
  BclifActiveTileCheckpoint,
  BclifBookFrame,
  BclifCanonicalEvent,
  BclifCollectorNode,
  BclifDecodedTile,
  BclifFrameEnvelope,
  BclifOpenInterestPoint,
  BclifSourceFreshness,
  BclifSourceHealth,
  BclifSourceOffset,
  BclifTileHorizon,
  BclifTileInput,
  PersistentLiquidationEvent,
  PersistentPublicTrade
} from "../contracts.ts";
import { updateBclifNodeIdentity } from "./nodeIdentity.ts";
import type { BclifRuntimeConfig } from "./runtimeConfig.ts";
import { BclifHealthState, createBclifHealthServer } from "./health.ts";
import { BclifLocalEventSpool, BclifSpoolQuota } from "./localSpool.ts";
import { BclifEventBatcher } from "./eventBatcher.ts";
import { BclifMetricRegistry } from "../metrics/registry.ts";
import { BclifStructuredLogger } from "../logging/structuredLogger.ts";
import { BclifSourceRepository } from "../state/sourceRepository.ts";
import { BclifObjectStore } from "../state/objectStore.ts";
import { BclifSourceOffsetRepository } from "../state/sourceOffsets.ts";
import { BclifEventDeduplicator } from "../state/eventDeduplication.ts";
import { BclifEventChunkRepository, bclifArchivedEventIdentity } from "../state/eventChunkRepository.ts";
import { BclifCheckpointRepository } from "../state/checkpointRepository.ts";
import { BclifConfirmedLiquidationRepository } from "../state/cohortRepository.ts";
import { BclifCalibrationRepository } from "../state/calibrationRepository.ts";
import { BclifCoverageRepository, BclifCoverageTracker, type BclifCoverageSource } from "../state/coverageRepository.ts";
import { BclifTileRepository } from "../tiles/tileRepository.ts";
import { BclifRetentionWorker } from "../tiles/retention.ts";
import type { BclifModelColumn } from "../tiles/tileBuilder.ts";
import { decodeBclifTile, encodeBclifTile } from "../tiles/tileCodec.ts";
import { buildCumulativeLiveEdges, horizonDurationMs } from "../tiles/liveEdgeRollup.ts";
import { BclifCohortRuntime } from "../model/cohortRuntime.ts";
import { BclifExposureRuntime } from "../model/exposureRuntime.ts";
import { BclifCalibrationRuntime } from "../model/calibrationRuntime.ts";
import { prepareHistoricalOpenInterestSeed } from "../model/historicalSeed.ts";
import { canonicalEvent } from "../normalization/canonicalEnvelope.ts";
import { canonicalOpenInterestEvent } from "../normalization/canonicalOpenInterest.ts";
import { canonicalBookFrameEvent } from "../normalization/canonicalBook.ts";
import { buildCanonicalFrame, confirmedEvent, consumeOpenInterestObservation, type BclifRatioContext, type BclifTickerContext } from "../normalization/canonicalFrame.ts";
import { parseBybitPublicTrades } from "../normalization/canonicalTrade.ts";
import { parseBybitLiquidations } from "../normalization/canonicalLiquidation.ts";
import { fetchBybitInstrumentInfo } from "../sources/bybitInstrumentInfo.ts";
import { fetchBybitRiskRules } from "../sources/bybitRiskTiers.ts";
import { fetchBybitTicker } from "../sources/bybitMarkPrice.ts";
import { fetchBybitOpenInterestHistory } from "../sources/bybitOpenInterest.ts";
import { fetchBybitFundingHistory, type BclifFundingPoint } from "../sources/bybitFunding.ts";
import { fetchBybitAccountRatios } from "../sources/bybitRatios.ts";
import { BybitOrderBookReconstructor } from "../sources/bybitOrderBook.ts";
import { BybitPublicSocket, verifyBybitServerClock } from "../sources/bybitTransport.ts";
import {
  assertSingleBoundedBucket,
  planActiveColumnTransition,
  recoverLatestActiveBucket
} from "./activeTileContinuity.ts";

const BASE_TILE_HORIZON_MS = 6 * 60 * 60 * 1_000;
const MEMORY_WINDOW_MS = 2 * 60 * 60 * 1_000;

interface SymbolDependencies {
  supabase: any;
  config: BclifRuntimeConfig;
  node: BclifCollectorNode;
  sourceRepository: BclifSourceRepository;
  objectStore: BclifObjectStore;
  quota: BclifSpoolQuota;
  health: BclifHealthState;
  metrics: BclifMetricRegistry;
  logger: BclifStructuredLogger;
  symbolAllocationBytes: number;
}

export class BclifCollectorWorker {
  readonly health = new BclifHealthState();
  readonly metrics = new BclifMetricRegistry();
  private readonly supabase: any;
  private readonly config: BclifRuntimeConfig;
  private readonly node: BclifCollectorNode;
  private readonly sourceRepository: BclifSourceRepository;
  private readonly objectStore: BclifObjectStore;
  private readonly logger: BclifStructuredLogger;
  private symbols: BclifSymbolCollector[] = [];
  private healthServer: Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  private stopping = false;
  private authorityLost = false;

  constructor(supabase: any, config: BclifRuntimeConfig, node: BclifCollectorNode) {
    this.supabase = supabase;
    this.config = config;
    this.node = node;
    this.sourceRepository = new BclifSourceRepository(supabase);
    this.objectStore = new BclifObjectStore(supabase, config.objectBucket);
    this.logger = new BclifStructuredLogger({ nodeId: node.nodeId, instanceId: node.instanceId, modelVersion: node.modelVersion }, config.logLevel);
  }

  async start() {
    this.health.setPhase("CONFIG_VALIDATING");
    this.health.prerequisite("configuration", true);
    this.health.prerequisite("identity", true);
    let leaseAcquired = false;
    try {
      this.healthServer = createBclifHealthServer(this.health, this.metrics);
      await new Promise<void>((resolve, reject) => {
        this.healthServer!.once("error", reject);
        this.healthServer!.listen(this.config.healthPort, this.config.healthBindAddress, () => resolve());
      });
      this.health.setPhase("DATABASE_CONNECTING");
      await this.sourceRepository.registerNode(this.node, "DATABASE_CONNECTING", Math.max(15_000, this.config.heartbeatIntervalMs * 4));
      leaseAcquired = true;
      // Lease renewal starts immediately after acquisition. Initialization can
      // include backfill, object verification and replay and must never silently
      // outlive the writer lease before public streams are connected.
      this.heartbeatTimer = setInterval(() => void this.renewHeartbeat().catch((error) => this.failStopAuthority(error)), this.config.heartbeatIntervalMs);
      await this.renewHeartbeat();
      this.health.prerequisite("database", true);
      this.health.setPhase("SCHEMA_VALIDATING");
      await this.sourceRepository.verifySchema();
      this.health.prerequisite("schema", true);
      this.health.setPhase("STORAGE_CONNECTING");
      await this.objectStore.verifyAvailable();
      this.health.prerequisite("storage", true);
      this.health.prerequisite("checkpoint", true);
      const clock = await verifyBybitServerClock(this.config.maxClockDriftMs);
      this.health.prerequisite("clock", true, `drift=${Math.round(clock.driftMs)}ms uncertainty=${Math.round(clock.uncertaintyMs)}ms`);
      const quota = await BclifSpoolQuota.create(this.config.spoolDirectory, this.config.spoolMaxBytes);
      const symbolAllocationBytes = Math.floor(this.config.spoolMaxBytes / this.config.symbols.length);
      this.health.setPhase("CHECKPOINT_LOADING");
      this.symbols = this.config.symbols.map((symbol) => new BclifSymbolCollector(symbol, {
        supabase: this.supabase,
        config: this.config,
        node: this.node,
        sourceRepository: this.sourceRepository,
        objectStore: this.objectStore,
        quota,
        health: this.health,
        metrics: this.metrics,
        logger: this.logger,
        symbolAllocationBytes
      }));
      for (const collector of this.symbols) await collector.initialize();
      this.health.prerequisite("adapters", true);
      this.health.setPhase("SOURCE_CONNECTING");
      for (const collector of this.symbols) await collector.startLive();
      this.health.setPhase("SOURCE_SYNCHRONIZING");
      updateBclifNodeIdentity(this.node, "SYNCING");
      await this.renewHeartbeat();
      this.metrics.gauge("bclif_collector_started", "Whether the persistent collector completed initialization.", 1);
      this.metrics.gauge("bclif_live_client_subscriptions", "HTTP tile access is stateless; fixed zero means client subscriptions are not applicable to this collector process.", 0);
      this.logger.info("collector.live", { symbols: this.config.symbols, authority: "PERSISTENT_NODE", persistence: "continuous" });
    } catch (error) {
      await this.cleanupFailedStart(error, leaseAcquired);
      throw error;
    }
  }

  async shutdown(reason: string) {
    if (this.stopping) return;
    this.stopping = true;
    this.health.setPhase("DRAINING");
    updateBclifNodeIdentity(this.node, "DRAINING");
    // Continue renewing authority throughout what may be a long event/tile/
    // checkpoint drain. The lease is released only after all fenced writes.
    await this.renewHeartbeatOrFailStop();
    for (const collector of this.symbols) collector.stopAccepting();
    const results = await Promise.allSettled(this.symbols.map((collector) => collector.shutdown()));
    const failures = results.filter((result) => result.status === "rejected");
    await this.renewHeartbeatOrFailStop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.heartbeatInFlight?.catch(() => null);
    await this.sourceRepository.stop(this.node, reason);
    this.health.setPhase("STOPPED");
    await new Promise<void>((resolve) => this.healthServer?.close(() => resolve()) ?? resolve());
    this.healthServer = null;
    if (failures.length) throw new Error(`BCLIF shutdown completed with ${failures.length} symbol failure(s)`);
  }

  private async heartbeat() {
    if (this.authorityLost) throw new Error("BCLIF collector writer authority is fenced");
    if (this.health.phase() === "SOURCE_SYNCHRONIZING" && this.symbols.length > 0 && this.symbols.every((symbol) => symbol.liveReady())) {
      this.health.setPhase("LIVE");
      updateBclifNodeIdentity(this.node, "LIVE");
      this.logger.info("collector.sources_synchronized", { symbols: this.config.symbols });
    }
    const freshness = aggregateFreshness(this.symbols.map((symbol) => symbol.freshness()));
    const degraded = (this.health.snapshot().degraded as string[]).length > 0;
    const phase = this.health.phase();
    updateBclifNodeIdentity(this.node,
      phase === "LIVE" ? (degraded ? "DEGRADED" : "LIVE")
        : phase === "DRAINING" ? "DRAINING"
          : phase === "SOURCE_BACKFILLING" ? "BACKFILLING"
            : phase === "SOURCE_SYNCHRONIZING" || phase === "SOURCE_CONNECTING" || phase === "STATE_REPLAYING" ? "SYNCING"
              : "STARTING"
    );
    await this.sourceRepository.heartbeat(this.node, this.health.phase(), freshness, {
      symbols: this.config.symbols,
      authority: "PERSISTENT_NODE",
      spool: this.symbols.map((symbol) => ({ symbol: symbol.symbol, ...symbol.spoolUsage() }))
    });
    this.metrics.gauge("bclif_collector_uptime_seconds", "Collector process uptime in seconds.", Math.max(0, (Date.now() - this.node.startedAt) / 1_000));
    this.metrics.gauge("bclif_node_heartbeat_age_seconds", "Age of the most recently committed heartbeat.", 0);
  }

  private renewHeartbeat() {
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const pending = this.heartbeat().finally(() => {
      if (this.heartbeatInFlight === pending) this.heartbeatInFlight = null;
    });
    this.heartbeatInFlight = pending;
    return pending;
  }

  private async renewHeartbeatOrFailStop() {
    try { await this.renewHeartbeat(); }
    catch (error) {
      this.failStopAuthority(error);
      throw error;
    }
  }

  private async cleanupFailedStart(error: unknown, leaseAcquired: boolean) {
    const failedPhase = this.health.phase();
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const symbol of this.symbols) symbol.fenceOff();
    await this.heartbeatInFlight?.catch(() => null);
    if (leaseAcquired && !this.authorityLost) {
      try { await this.sourceRepository.stop(this.node, "STARTUP_FAILURE"); }
      catch (releaseError) { this.logger.error("collector.startup_lease_release_failed", { error: message(releaseError) }); }
    }
    this.health.setPhase("FATAL");
    this.logger.error("collector.startup_failed", { failedPhase, error: message(error) });
    await new Promise<void>((resolve) => this.healthServer?.close(() => resolve()) ?? resolve());
    this.healthServer = null;
  }

  private failStopAuthority(error: unknown) {
    if (this.authorityLost) return;
    this.authorityLost = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const symbol of this.symbols) symbol.fenceOff();
    this.health.setPhase("FATAL");
    this.health.degrade("STORAGE_DEGRADED", true);
    this.metrics.counter("bclif_storage_failures_total", "Persistent storage operation failures.");
    this.logger.error("collector.writer_authority_lost", { error: message(error), action: "FAIL_STOP" });
    process.exitCode = 1;
    // Closing the health listener lets a container supervisor restart the
    // process. We deliberately do not run normal shutdown writes with an
    // uncertain or stale fencing token.
    this.healthServer?.close();
    this.healthServer = null;
  }
}

class BclifSymbolCollector {
  readonly symbol: string;
  private readonly deps: SymbolDependencies;
  private sourceId = "";
  private rules: LiquidationInstrumentRules | null = null;
  private cohort: BclifCohortRuntime | null = null;
  private exposure: BclifExposureRuntime | null = null;
  private book: BybitOrderBookReconstructor;
  private socket: BybitPublicSocket | null = null;
  private spool: BclifLocalEventSpool;
  private deduplicator: BclifEventDeduplicator | null = null;
  private eventRepository: BclifEventChunkRepository | null = null;
  private batcher: BclifEventBatcher | null = null;
  private checkpointRepository: BclifCheckpointRepository | null = null;
  private offsetRepository: BclifSourceOffsetRepository | null = null;
  private confirmedRepository: BclifConfirmedLiquidationRepository | null = null;
  private coverageRepository: BclifCoverageRepository | null = null;
  private tileRepository: BclifTileRepository | null = null;
  private calibration: BclifCalibrationRuntime | null = null;
  private retention: BclifRetentionWorker | null = null;
  private coverage = new BclifCoverageTracker();
  private offsets = new Map<string, BclifSourceOffset>();
  private trades: BclifCanonicalEvent<PersistentPublicTrade>[] = [];
  private liquidations: BclifCanonicalEvent<PersistentLiquidationEvent>[] = [];
  private confirmed: ConfirmedLiquidationEvent[] = [];
  private tickers: BclifTickerContext[] = [];
  private openInterest: BclifOpenInterestPoint[] = [];
  private lastConsumedOpenInterest: BclifOpenInterestPoint | null = null;
  private ratios: BclifRatioContext[] = [];
  private bookFrames: BclifBookFrame[] = [];
  private activeColumns: BclifModelColumn[] = [];
  private finalizedBaseTiles: BclifDecodedTile[] = [];
  private liveEdgeTiles = new Map<BclifTileHorizon, BclifTileInput | BclifDecodedTile>();
  private lastCalibratedCutoff = 0;
  private lastEnvelope: BclifFrameEnvelope | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private contextTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private operation = Promise.resolve();
  private accepting = false;
  private streamConnected = false;
  private subscriptionsAcknowledged = false;
  private observedTrade = false;
  private observedBookSnapshot = false;
  private producedLiveFrame = false;
  private lastTransportActivityAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastLiquidationAt: number | null = null;
  private lastOiAt: number | null = null;
  private lastBookAt: number | null = null;
  private lastFundingAt: number | null = null;
  private reconnects = 0;
  private gaps = 0;
  private contextPolls = 0;

  constructor(symbol: string, deps: SymbolDependencies) {
    this.symbol = symbol;
    this.deps = deps;
    this.book = new BybitOrderBookReconstructor(symbol, deps.config.sourceVersion, 200);
    this.spool = new BclifLocalEventSpool(deps.config.spoolDirectory, symbol, deps.quota);
  }

  async initialize() {
    const started = performance.now();
    this.sourceId = await this.deps.sourceRepository.ensureSource(this.deps.node, this.symbol, this.deps.config.sourceVersion);
    const fence = this.deps.sourceRepository.fence();
    this.offsetRepository = new BclifSourceOffsetRepository(this.deps.supabase, this.sourceId, this.deps.config.sourceVersion, this.symbol, fence);
    this.eventRepository = new BclifEventChunkRepository(this.deps.supabase, this.deps.objectStore, this.sourceId, this.deps.node.nodeId, this.deps.config.sourceVersion, fence);
    this.deduplicator = new BclifEventDeduplicator(this.deps.supabase, this.sourceId, this.deps.config.dedupWindowMs, fence);
    this.checkpointRepository = new BclifCheckpointRepository(this.deps.supabase, this.deps.objectStore, this.sourceId, this.deps.node.nodeId, fence);
    this.confirmedRepository = new BclifConfirmedLiquidationRepository(this.deps.supabase, this.sourceId, fence);
    this.coverageRepository = new BclifCoverageRepository(this.deps.supabase, this.sourceId, fence);
    this.tileRepository = new BclifTileRepository(this.deps.supabase, this.deps.objectStore, this.sourceId, this.deps.node.nodeId, fence);
    this.calibration = new BclifCalibrationRuntime(new BclifCalibrationRepository(this.deps.supabase, this.sourceId, fence), this.deps.metrics);
    this.retention = new BclifRetentionWorker(this.deps.supabase, this.deps.objectStore, this.sourceId, this.deps.node.nodeId, fence);
    // Only the two boundary base tiles are needed by incremental horizon
    // extension. Long-horizon history lives in compact cumulative STAGING
    // prefixes instead of a 120-tile decoded heap per symbol.
    this.finalizedBaseTiles = await this.tileRepository.loadRecentFinalized(this.symbol, this.deps.config.modelVersion, "6H", 2);
    this.liveEdgeTiles = await this.tileRepository.loadCurrentStaging(this.symbol, this.deps.config.modelVersion);
    await this.spool.initialize();
    await this.deduplicator.hydrate();
    this.batcher = new BclifEventBatcher(
      this.eventRepository,
      this.deps.config.eventChunkMaxBytes,
      this.deps.config.eventChunkMaxAgeMs,
      this.deduplicator,
      {
        maximumPendingBytes: this.deps.symbolAllocationBytes,
        onPersisted: async (events) => {
          await this.spool.acknowledge(events);
          const oldestReceivedAt = events.reduce((oldest, event) => Math.min(oldest, event.receivedTimestamp), Number.POSITIVE_INFINITY);
          this.deps.metrics.observe("bclif_event_queue_delay_ms", "Delay from public-source receipt to verified canonical archive persistence.", Math.max(0, Date.now() - oldestReceivedAt));
        }
      }
    );
    await this.recoverSpool();
    this.offsets = new Map((await this.offsetRepository.load()).map((offset: BclifSourceOffset) => [offset.source, offset]));
    const instrument = await fetchBybitInstrumentInfo(this.symbol);
    const liveRules = await fetchBybitRiskRules(this.symbol, instrument, this.deps.config.sourceVersion);
    const ticker = await fetchBybitTicker(this.symbol);
    this.tickers.push(ticker);
    const checkpoint = await this.checkpointRepository.loadLatest(this.deps.config.modelVersion, this.deps.config.sourceVersion);
    const recentGrid = this.finalizedBaseTiles.at(-1);
    const grid = checkpoint.state?.activeTile
      ? { rows: checkpoint.state.activeTile.rows, minPrice: checkpoint.state.activeTile.minPrice, priceStep: checkpoint.state.activeTile.priceStep }
      : recentGrid
        ? { rows: recentGrid.rows, minPrice: recentGrid.minPrice, priceStep: recentGrid.priceStep }
      : gridFor(ticker.markPrice, instrument.tickSize);
    this.rules = checkpoint.state?.instrumentRules ?? liveRules;
    this.cohort = new BclifCohortRuntime(this.rules);
    this.exposure = new BclifExposureRuntime(grid.rows, grid.minPrice, grid.priceStep);
    if (checkpoint.state?.activeTile && checkpoint.state.activeTile.timeStepMs !== this.deps.config.tileColumnCadenceMs) throw new Error("BCLIF active tile cadence differs from runtime configuration");
    if (checkpoint.state) this.restoreCheckpoint(checkpoint.state);
    await this.deps.sourceRepository.updateSource(this.sourceId, { state: "BACKFILLING", continuityState: "MISSING", metadata: { authority: "PERSISTENT_NODE", checkpointFailures: checkpoint.failures.length } });
    await this.initialBackfill(instrument.fundingIntervalMinutes);
    if (checkpoint.state) {
      const replay = await this.eventRepository.readAfter(checkpoint.state.sourceCutoffTimestamp);
      await this.replayRecoveredEvents(replay);
    }
    this.rules = liveRules;
    this.cohort.updateRules(liveRules);
    await this.persistContextSnapshots(instrument, liveRules);
    await this.batcher.drain();
    await this.saveCheckpoint("BACKFILL_COMPLETE");
    this.deps.metrics.observe("bclif_recovery_duration_ms", "Collector symbol initialization and recovery duration.", performance.now() - started);
    this.deps.logger.info("collector.symbol_initialized", {
      symbol: this.symbol,
      sourceId: this.sourceId,
      historicalOiMode: "OFFICIAL_HISTORICAL_BACKFILL_BASELINE_ONLY",
      historicalExposureBackdated: false
    });
  }

  async startLive() {
    await this.deps.sourceRepository.updateSource(this.sourceId, {
      state: "SYNCING",
      continuityState: "MISSING",
      sourceCutoffTimestamp: null,
      freshness: this.freshness()
    });
    this.accepting = true;
    this.socket = new BybitPublicSocket([
      `publicTrade.${this.symbol}`,
      `allLiquidation.${this.symbol}`,
      `orderbook.200.${this.symbol}`
    ], {
      onOpen: () => {
        this.streamConnected = true;
        this.subscriptionsAcknowledged = false;
        this.lastTransportActivityAt = Date.now();
        this.book.connected();
        this.updateHealth("WEBSOCKET", true, null);
      },
      onSubscribed: () => {
        this.subscriptionsAcknowledged = true;
        this.updateHealth("TRADE", true, null);
        this.updateHealth("LIQUIDATION", true, null);
        this.updateHealth("BOOK_FRAME", true, null);
      },
      onActivity: (receivedTimestamp) => { this.lastTransportActivityAt = receivedTimestamp; },
      onMessage: (payload, receivedTimestamp) => this.enqueue(() => this.ingestSocket(payload, receivedTimestamp)),
      onError: (error) => this.updateHealth("WEBSOCKET", false, error.message),
      onClose: (reason) => {
        this.streamConnected = false;
        this.subscriptionsAcknowledged = false;
        if (this.book.state() !== "DISCONNECTED") this.book.transportGap(reason);
        this.gaps += 1;
        this.bumpContinuity(["TRADE", "LIQUIDATION", "BOOK_FRAME"], 1, 0);
        this.deps.metrics.counter("bclif_source_gaps_total", "Detected source continuity gaps.");
      },
      onReconnect: (_attempt, _delay) => {
        this.reconnects += 1;
        this.bumpContinuity(["TRADE", "LIQUIDATION", "BOOK_FRAME"], 0, 1);
        this.deps.metrics.counter("bclif_source_reconnects_total", "Public-source websocket reconnect attempts.");
      }
    }, this.deps.config.reconnectBaseMs, this.deps.config.reconnectMaxMs);
    this.socket.start();
    this.scheduleFrame();
    this.contextTimer = setInterval(() => this.enqueue(() => this.pollContext()), this.deps.config.contextPollIntervalMs);
    this.flushTimer = setInterval(() => this.enqueue(() => this.flushAndRecover()), Math.min(this.deps.config.eventChunkMaxAgeMs, 10_000));
    this.checkpointTimer = setInterval(() => this.enqueue(() => this.saveCheckpoint("INTERVAL")), this.deps.config.checkpointIntervalMs);
    this.maintenanceTimer = setInterval(() => this.enqueue(() => this.runMaintenance()), 15 * 60_000);
  }

  stopAccepting() {
    this.accepting = false;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.contextTimer) clearInterval(this.contextTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  fenceOff() {
    this.stopAccepting();
    this.socket?.stop();
  }

  async shutdown() {
    this.stopAccepting();
    await this.deps.sourceRepository.updateSource(this.sourceId, { state: "DRAINING", continuityState: "DERIVED", sourceCutoffTimestamp: this.lastEnvelope?.sourceCutoffTimestamp ?? null, freshness: this.freshness() });
    this.socket?.stop();
    await this.operation;
    await this.batcher?.drain();
    await this.persistOffsets();
    await this.saveCheckpoint("GRACEFUL_SHUTDOWN");
    await this.deps.sourceRepository.updateSource(this.sourceId, { state: "OFFLINE", continuityState: "DERIVED", sourceCutoffTimestamp: this.lastEnvelope?.sourceCutoffTimestamp ?? null, freshness: this.freshness() });
  }

  freshness(): BclifSourceFreshness {
    const now = Date.now();
    return {
      tradesAgeMs: age(now, this.lastTradeAt),
      liquidationsAgeMs: age(now, this.lastLiquidationAt),
      orderbookAgeMs: age(now, this.lastBookAt),
      openInterestAgeMs: age(now, this.lastOiAt),
      fundingAgeMs: age(now, this.lastFundingAt),
      markPriceAgeMs: age(now, this.tickers.at(-1)?.exchangeTimestamp ?? null),
      riskTierAgeMs: age(now, this.rules?.fetchedAt ?? null)
    };
  }
  spoolUsage() { return this.spool.usage(); }
  liveReady() {
    const now = Date.now();
    const frameFresh = this.lastEnvelope !== null && now - this.lastEnvelope.sourceCutoffTimestamp <= Math.max(30_000, this.deps.config.frameCadenceMs * 3);
    const transportFresh = this.lastTransportActivityAt !== null && now - this.lastTransportActivityAt <= 45_000;
    const bookFresh = this.lastBookAt !== null && now - this.lastBookAt <= Math.max(15_000, this.deps.config.bookFrameCadenceMs * 3);
    const oiFresh = this.lastConsumedOpenInterest?.availabilityMode === "LIVE_OBSERVATION"
      && now - this.lastConsumedOpenInterest.availableAt <= Math.max(30_000, this.deps.config.contextPollIntervalMs * 2);
    return this.streamConnected
      && this.subscriptionsAcknowledged
      && this.observedBookSnapshot
      && this.producedLiveFrame
      && frameFresh
      && transportFresh
      && bookFresh
      && oiFresh
      && this.book.state() === "LIVE";
  }

  private enqueue(task: () => Promise<void>) {
    this.operation = this.operation.then(task).catch((error) => this.handleOperationalFailure(error));
  }

  private async ingestSocket(payload: unknown, receivedTimestamp: number) {
    if (!this.accepting) return;
    const topic = String((payload as { topic?: unknown })?.topic || "");
    if (topic.startsWith("publicTrade.")) {
      const accepted = await this.durableAccept(parseBybitPublicTrades(payload, receivedTimestamp, this.deps.config.sourceVersion));
      this.trades.push(...accepted as BclifCanonicalEvent<PersistentPublicTrade>[]);
      if (accepted.length) {
        this.lastTradeAt = receivedTimestamp;
        this.observedTrade = true;
        this.deps.metrics.counter("bclif_trade_events_total", "Observed canonical public trades.", accepted.length);
      }
      return;
    }
    if (topic.startsWith("allLiquidation.")) {
      const accepted = await this.durableAccept(parseBybitLiquidations(payload, receivedTimestamp, this.deps.config.sourceVersion));
      const typed = accepted as BclifCanonicalEvent<PersistentLiquidationEvent>[];
      this.liquidations.push(...typed);
      this.confirmed.push(...typed.map(confirmedEvent));
      await this.confirmedRepository!.persist(typed);
      if (accepted.length) {
        this.lastLiquidationAt = receivedTimestamp;
        this.deps.metrics.counter("bclif_liquidation_events_total", "Observed canonical liquidation events.", accepted.length);
      }
      return;
    }
    if (topic.startsWith("orderbook.")) {
      const result = this.book.apply(payload, receivedTimestamp);
      if (result.resyncRequired) {
        this.gaps += 1;
        this.bumpContinuity(["BOOK_FRAME"], 1, 0);
        this.deps.metrics.counter("bclif_source_gaps_total", "Detected source continuity gaps.");
        this.socket?.forceReconnect("orderbook sequence gap");
        return;
      }
      if (result.frame && (this.lastBookAt === null || result.frame.receivedTimestamp - this.lastBookAt >= this.deps.config.bookFrameCadenceMs)) {
        const accepted = await this.durableAccept([canonicalBookFrameEvent(result.frame)]);
        if (accepted.length) {
          this.bookFrames.push(result.frame);
          this.lastBookAt = result.frame.receivedTimestamp;
          this.observedBookSnapshot = true;
        }
      }
    }
  }

  private async durableAccept(events: readonly BclifCanonicalEvent[]) {
    if (!events.length) return [];
    const accepted = await this.deduplicator!.filterNew(events, Date.now(), false);
    if (!accepted.length) {
      this.deps.metrics.counter("bclif_deduplicated_events_total", "Canonical events rejected as duplicates.", events.length);
      return [];
    }
    await this.spool.put(accepted);
    this.batcher!.add(accepted);
    // Only poison the in-process duplicate cache after the fsynced record has
    // an owning pending batch. A backpressure exception must leave the spool
    // record immediately recoverable in this same process.
    this.deduplicator!.seed(accepted);
    for (const event of accepted) this.observeOffset(event);
    if (events.length > accepted.length) this.deps.metrics.counter("bclif_deduplicated_events_total", "Canonical events rejected as duplicates.", events.length - accepted.length);
    return accepted;
  }

  private async initialBackfill(fundingIntervalMinutes: number) {
    const end = Date.now();
    const start = end - 30 * 24 * 60 * 60 * 1_000;
    const oi = await fetchBybitOpenInterestHistory({ symbol: this.symbol, interval: "1h", startTime: start, endTime: end, sourceVersion: this.deps.config.sourceVersion }).catch((error) => {
      this.deps.health.degrade("OI_STALE", true, this.symbol);
      this.deps.logger.warn("collector.oi_backfill_unavailable", { symbol: this.symbol, error: message(error) });
      return [];
    });
    const funding = await fetchBybitFundingHistory({ symbol: this.symbol, startTime: start, endTime: end, fundingIntervalMinutes, sourceVersion: this.deps.config.sourceVersion }).catch(() => []);
    const ratios = await fetchBybitAccountRatios({ symbol: this.symbol, period: "1h", startTime: start, endTime: end, sourceVersion: this.deps.config.sourceVersion }).catch(() => []);
    const seed = prepareHistoricalOpenInterestSeed(oi, Date.now());
    if (seed) this.openInterest.push(seed.baseline);
    const oiEvents = oi.map((point) => canonicalOpenInterestEvent(this.symbol, point, point.receivedTimestamp));
    const fundingEvents = funding.map((point) => this.contextEvent("FUNDING", `FUNDING:${point.timestamp}`, point.timestamp, point.receivedTimestamp, point));
    const ratioEvents = ratios.map((point) => this.contextEvent("POSITION_RATIO", `RATIO:${point.timestamp}`, point.timestamp, point.receivedTimestamp, point));
    await this.durableHistoricalAccept([...oiEvents, ...fundingEvents, ...ratioEvents]);
    this.ratios.push(...ratios);
    // A historical baseline is not a live freshness observation and must not
    // make readiness/coverage appear current.
    this.lastOiAt = this.lastConsumedOpenInterest?.availableAt ?? null;
    this.lastFundingAt = funding.at(-1)?.receivedTimestamp ?? null;
    await this.deps.sourceRepository.updateSource(this.sourceId, {
      state: "SYNCING",
      continuityState: seed ? "ESTIMATED_HIGH" : "MISSING",
      sourceCutoffTimestamp: seed?.establishedAt ?? null,
      freshness: this.freshness(),
      metadata: { authority: "PERSISTENT_NODE", historicalSeed: seed ? { authority: seed.authority, historicalCohortsCreated: 0, limitation: seed.limitation } : null }
    });
  }

  private async persistContextSnapshots(instrument: Awaited<ReturnType<typeof fetchBybitInstrumentInfo>>, rules: LiquidationInstrumentRules) {
    const events = [
      this.contextEvent("INSTRUMENT_INFO", `INSTRUMENT:${instrument.observedAt}`, instrument.observedAt, instrument.observedAt, instrument),
      this.contextEvent("RISK_TIER", `RISK:${rules.fetchedAt}`, rules.fetchedAt, rules.fetchedAt, { ...rules, availabilityMode: "LIVE_SNAPSHOT", availableAt: rules.fetchedAt })
    ];
    await this.durableAccept(events);
  }

  private async durableHistoricalAccept(events: readonly BclifCanonicalEvent[]) {
    if (!events.length) return [];
    // Durable dedup rows intentionally expire. Repeated bounded REST backfills
    // also reconcile against immutable archives so a restart weeks later
    // cannot append the same historical identity a second time.
    const archived = await this.eventRepository!.archivedDedupKeys(events);
    const alreadyArchived = events.filter((event) => archived.has(bclifArchivedEventIdentity(event)));
    if (alreadyArchived.length) this.deduplicator!.seed(alreadyArchived);
    return this.durableAccept(events.filter((event) => !archived.has(bclifArchivedEventIdentity(event))));
  }

  private async pollContext() {
    if (!this.accepting) return;
    this.contextPolls += 1;
    const ticker = await fetchBybitTicker(this.symbol);
    this.tickers.push(ticker);
    this.tickers = this.tickers.slice(-64);
    const point: BclifOpenInterestPoint = {
      timestamp: ticker.exchangeTimestamp,
      receivedTimestamp: ticker.receivedTimestamp,
      availableAt: ticker.receivedTimestamp,
      availabilityMode: "LIVE_OBSERVATION",
      interval: "ticker",
      singleSideOpenInterest: ticker.singleSideOpenInterest,
      bothSidesOpenInterest: ticker.bothSidesOpenInterest,
      unit: "BASE",
      sourceVersion: this.deps.config.sourceVersion
    };
    this.openInterest.push(point);
    this.openInterest = this.openInterest.slice(-10_000);
    this.lastOiAt = point.receivedTimestamp;
    if (ticker.fundingRate !== null) this.lastFundingAt = ticker.receivedTimestamp;
    const contextEvents: BclifCanonicalEvent[] = [
      canonicalOpenInterestEvent(this.symbol, point, point.receivedTimestamp),
      this.contextEvent("MARK_INDEX", `MARK:${ticker.exchangeTimestamp}`, ticker.exchangeTimestamp, ticker.receivedTimestamp, ticker),
      ...(ticker.fundingRate === null ? [] : [this.contextEvent("FUNDING", `LIVE_FUNDING:${ticker.exchangeTimestamp}`, ticker.exchangeTimestamp, ticker.receivedTimestamp, { fundingRate: ticker.fundingRate, availabilityMode: "LIVE_OBSERVATION", availableAt: ticker.receivedTimestamp })])
    ];
    const recentRatios = await fetchBybitAccountRatios({
      symbol: this.symbol,
      period: "1h",
      startTime: ticker.receivedTimestamp - 3 * 60 * 60_000,
      endTime: ticker.receivedTimestamp,
      sourceVersion: this.deps.config.sourceVersion
    }).catch(() => []);
    const latestRatio = recentRatios.at(-1);
    if (latestRatio) {
      const observedRatio = { ...latestRatio, receivedTimestamp: ticker.receivedTimestamp, availableAt: ticker.receivedTimestamp, availabilityMode: "LIVE_OBSERVATION" as const };
      this.ratios.push(observedRatio);
      contextEvents.push(this.contextEvent("POSITION_RATIO", `LIVE_RATIO:${latestRatio.timestamp}:${ticker.receivedTimestamp}`, latestRatio.timestamp, ticker.receivedTimestamp, observedRatio));
    }
    const rulesEvery = Math.max(1, Math.round(60 * 60_000 / this.deps.config.contextPollIntervalMs));
    if (this.contextPolls % rulesEvery === 0) {
      const instrument = await fetchBybitInstrumentInfo(this.symbol);
      const rules = await fetchBybitRiskRules(this.symbol, instrument, this.deps.config.sourceVersion);
      this.rules = rules;
      this.cohort?.updateRules(rules);
      contextEvents.push(
        this.contextEvent("INSTRUMENT_INFO", `INSTRUMENT:${instrument.observedAt}`, instrument.observedAt, instrument.observedAt, instrument),
        this.contextEvent("RISK_TIER", `RISK:${rules.fetchedAt}`, rules.fetchedAt, rules.fetchedAt, { ...rules, availabilityMode: "LIVE_SNAPSHOT", availableAt: rules.fetchedAt })
      );
    }
    await this.durableAccept(contextEvents);
  }

  private scheduleFrame() {
    if (!this.accepting) return;
    const cadence = this.deps.config.frameCadenceMs;
    const delay = Math.max(25, cadence - (Date.now() % cadence) + 25);
    this.frameTimer = setTimeout(() => {
      this.enqueue(() => this.processFrame());
      this.scheduleFrame();
    }, delay);
  }

  private async processFrame() {
    if (!this.accepting || !this.cohort || !this.exposure) return;
    const cadence = this.deps.config.frameCadenceMs;
    const frameEnd = Math.floor(Date.now() / cadence) * cadence;
    await this.processFrameAt(frameEnd, false);
  }

  private async processFrameAt(frameEnd: number, replaying: boolean) {
    if (!this.cohort || !this.exposure) return false;
    if (this.activeColumns.length >= BASE_TILE_HORIZON_MS / this.deps.config.tileColumnCadenceMs) {
      await this.publishActiveEdgesAndClosures();
      if (this.activeColumns.length) return false;
    }
    const cadence = this.deps.config.frameCadenceMs;
    if (this.lastEnvelope && frameEnd <= this.lastEnvelope.frameEnd) return;
    const resumedAcrossGap = Boolean(this.lastEnvelope && frameEnd - this.lastEnvelope.frameEnd > cadence * 2);
    const frameStart = this.lastEnvelope && !resumedAcrossGap ? this.lastEnvelope.frameEnd : frameEnd - cadence;
    const ticker = latestKnown(this.tickers, frameEnd, (item) => item.exchangeTimestamp, (item) => item.receivedTimestamp);
    const tickerFresh = ticker !== null && frameEnd - ticker.receivedTimestamp <= Math.max(30_000, this.deps.config.contextPollIntervalMs * 2);
    if (!ticker || !tickerFresh) {
      if (!replaying) await this.updateSourceState();
      return false;
    }
    const oi = latestKnown(this.openInterest, frameEnd, (item) => item.timestamp, (item) => item.availableAt);
    // Official historical OI fetched after the fact is a truthful baseline,
    // never an as-if-live delta. Only an observation actually available in the
    // live stream may create/reduce cohorts.
    const oiFresh = oi !== null
      && oi.availabilityMode === "LIVE_OBSERVATION"
      && frameEnd - oi.availableAt <= Math.max(30_000, this.deps.config.contextPollIntervalMs * 2);
    const reliableOi = oiFresh ? oi : null;
    const oiDecision = consumeOpenInterestObservation(reliableOi, this.lastConsumedOpenInterest);
    const previousOi = resumedAcrossGap ? reliableOi : oiDecision.previous;
    const ratio = latestKnown(this.ratios, frameEnd, (item) => item.timestamp, (item) => item.receivedTimestamp);
    const book = latestKnown(this.bookFrames, frameEnd, (item) => item.exchangeTimestamp, (item) => item.receivedTimestamp);
    const bookFresh = book !== null && frameEnd - book.receivedTimestamp <= Math.max(15_000, this.deps.config.bookFrameCadenceMs * 3);
    const tradeInFrame = this.trades.some((event) => knownAt(event) > frameStart && knownAt(event) <= frameEnd);
    const liveTradeContinuity = this.lastTransportActivityAt !== null && frameEnd - this.lastTransportActivityAt <= 45_000;
    const liquidationObserved = this.liquidations.some((event) => knownAt(event) > frameStart && knownAt(event) <= frameEnd);
    const liveAcknowledged = this.streamConnected && this.subscriptionsAcknowledged;
    const bookStateBeforeStaleCheck = this.book.state();
    if (!replaying && this.book.stale(frameEnd, Math.max(15_000, this.deps.config.bookFrameCadenceMs * 3))) {
      this.deps.health.degrade("ORDERBOOK_STALE", true, this.symbol);
      if (bookStateBeforeStaleCheck === "LIVE") {
        this.book.transportGap("orderbook freshness deadline exceeded");
        this.bumpContinuity(["BOOK_FRAME"], 1, 0);
        this.socket?.forceReconnect("stale orderbook requires a fresh snapshot");
      }
    }
    const sourceAvailability = {
      // An empty five-second frame on a connected, fresh trade stream is an
      // observed zero-flow interval, not a coverage gap. Replay lacks that
      // connection evidence and therefore requires an archived event.
      trades: replaying ? tradeInFrame : liveAcknowledged && liveTradeContinuity,
      liquidations: replaying ? liquidationObserved : liveAcknowledged,
      orderbook: bookFresh && (replaying || (liveAcknowledged && this.book.state() === "LIVE")),
      openInterest: Boolean(reliableOi),
      funding: ticker.fundingRate !== null && tickerFresh,
      positioning: Boolean(ratio && (ratio as BclifRatioContext & { availabilityMode?: string }).availabilityMode === "LIVE_OBSERVATION")
    };
    const started = performance.now();
    const envelope = buildCanonicalFrame({
      symbol: this.symbol,
      frameStart,
      frameEnd,
      sourceCutoffTimestamp: frameEnd,
      sourceVersion: this.deps.config.sourceVersion,
      trades: this.trades,
      liquidations: this.liquidations,
      currentOpenInterest: reliableOi,
      previousOpenInterest: previousOi,
      ticker,
      ratio,
      book: bookFresh ? book : null,
      sourceAvailability
    });
    const snapshot = this.cohort.process(envelope, this.confirmed);
    if (oiDecision.advanced) this.lastConsumedOpenInterest = oiDecision.nextConsumed;
    this.lastEnvelope = envelope;
    if (!replaying) this.producedLiveFrame = true;
    this.recordCoverage(frameStart, frameEnd, sourceAvailability);
    this.deps.metrics.observe("bclif_model_update_duration_ms", "Cohort-engine frame update duration.", performance.now() - started);
    this.deps.metrics.gauge("bclif_active_cohorts", "Currently active modeled position cohorts.", snapshot.cohorts.length);
    this.deps.metrics.gauge("bclif_active_particles", "Currently active liquidation exposure particles.", snapshot.particles.length);
    if (frameEnd % this.deps.config.tileColumnCadenceMs === 0) {
      const rasterStarted = performance.now();
      const column = this.exposure.rasterize(envelope.frame, snapshot.particles, this.confirmed, frameEnd);
      this.deps.metrics.observe("bclif_raster_duration_ms", "Exposure rasterization duration.", performance.now() - rasterStarted);
      await this.acceptColumn(column);
    }
    this.pruneMemory(frameEnd);
    if (!replaying) await this.updateSourceState();
    return true;
  }

  private async acceptColumn(column: BclifModelColumn) {
    const cadence = this.deps.config.tileColumnCadenceMs;
    const transition = planActiveColumnTransition(
      this.activeColumns.map((active) => active.timestamp),
      column.timestamp,
      cadence,
      BASE_TILE_HORIZON_MS
    );
    if (transition.disposition === "STALE") return;
    for (const timestamp of transition.closeBucketWith) this.activeColumns.push(missingColumn(timestamp, this.exposure!));
    if (transition.closeBucketWith.length) {
      await this.publishActiveEdgesAndClosures();
      if (this.activeColumns.length) throw new Error("BCLIF completed UTC bucket was not finalized before rollover");
    }
    for (const timestamp of transition.initializeCurrentWith) this.activeColumns.push(missingColumn(timestamp, this.exposure!));
    this.activeColumns.push(column);
    assertSingleBoundedBucket(this.activeColumns.map((active) => active.timestamp), cadence, BASE_TILE_HORIZON_MS);
    await this.publishActiveEdgesAndClosures();
  }

  private async publishActiveEdgesAndClosures() {
    if (!this.activeColumns.length || !this.exposure || !this.tileRepository || !this.coverageRepository) return;
    const started = performance.now();
    const now = Date.now();
    const first = this.activeColumns[0]!.timestamp;
    const last = this.activeColumns.at(-1)!.timestamp;
    await this.calibratePendingColumns(now);
    const baseCoverage = this.coverage.calculate({ venue: "BYBIT", symbol: this.symbol, horizon: "6H", requestedStart: first, requestedEnd: last, sourceCutoffTimestamp: last });
    const liveEdges = buildCumulativeLiveEdges(this.finalizedBaseTiles, this.activeColumns, {
      symbol: this.symbol,
      modelVersion: this.deps.config.modelVersion,
      sourceVersion: this.deps.config.sourceVersion,
      minPrice: this.exposure.minPrice,
      priceStep: this.exposure.priceStep,
      rows: this.exposure.rows,
      baseTimeStepMs: this.deps.config.tileColumnCadenceMs,
      coverageQuality: baseCoverage.quality,
      createdAt: now,
      priorLiveEdges: this.liveEdgeTiles
    });
    if (!liveEdges.size) return;
    try {
      for (const [horizon, tile] of liveEdges) {
        const uploadStarted = performance.now();
        const metadata = await this.tileRepository.publishStaging(tile);
        this.deps.metrics.observe("bclif_tile_upload_duration_ms", "Verified immutable tile upload and metadata publication duration.", performance.now() - uploadStarted);
        if (metadata.sourceCutoffTimestamp === tile.sourceCutoffTimestamp) this.liveEdgeTiles.set(horizon, tile);
        const coverageStart = Math.min(tile.startTime, this.coverage.earliestObservedAt() ?? tile.startTime);
        const cumulativeCoverage = this.coverage.calculate({ venue: "BYBIT", symbol: this.symbol, horizon, requestedStart: coverageStart, requestedEnd: tile.endTime, sourceCutoffTimestamp: tile.sourceCutoffTimestamp });
        await this.coverageRepository.upsert(cumulativeCoverage);
        this.observeCoverageMetrics(cumulativeCoverage);
      }
      const closures = [...liveEdges.entries()].filter(([horizon, tile]) => tile.endTime === Math.floor((tile.endTime - 1) / horizonDurationMs(horizon)) * horizonDurationMs(horizon) + horizonDurationMs(horizon));
      // Finalize the 6H root last. Until every closing horizon is durable the
      // complete active base tile remains checkpointed and retryable.
      closures.sort(([left], [right]) => (left === "6H" ? 1 : 0) - (right === "6H" ? 1 : 0));
      for (const [horizon, tile] of closures) {
        const uploadStarted = performance.now();
        await this.tileRepository.finalizeStaging(tile);
        this.deps.metrics.observe("bclif_tile_upload_duration_ms", "Verified immutable tile upload and metadata publication duration.", performance.now() - uploadStarted);
        this.liveEdgeTiles.delete(horizon);
      }
      const base = closures.find(([horizon]) => horizon === "6H")?.[1];
      if (base) {
        const encodedAt = performance.now();
        const decoded = decodeBclifTile(encodeBclifTile(base).bytes);
        this.deps.metrics.observe("bclif_tile_compression_duration_ms", "BCLIF tile codec compression and verification duration.", performance.now() - encodedAt);
        decoded.coverageQuality = base.coverageQuality;
        decoded.createdAt = base.createdAt;
        const unique = new Map(this.finalizedBaseTiles.map((tile) => [`${tile.startTime}:${tile.endTime}:${tile.tileId}`, tile]));
        unique.set(`${decoded.startTime}:${decoded.endTime}:${decoded.tileId}`, decoded);
        this.finalizedBaseTiles = [...unique.values()].sort((left, right) => left.startTime - right.startTime || left.tileId.localeCompare(right.tileId)).slice(-2);
        this.activeColumns = [];
      }
      this.deps.health.degrade("STORAGE_DEGRADED", false, this.symbol);
      this.deps.metrics.observe("bclif_tile_build_duration_ms", "Cumulative live-edge build and publication duration.", performance.now() - started);
    } catch (error) {
      this.deps.health.degrade("STORAGE_DEGRADED", true, this.symbol);
      this.deps.metrics.counter("bclif_storage_failures_total", "Persistent storage operation failures.");
      throw error;
    }
  }

  private async calibratePendingColumns(now: number) {
    if (!this.calibration || !this.exposure) return;
    let evaluated = false;
    for (const column of this.activeColumns) {
      if (column.timestamp <= this.lastCalibratedCutoff) continue;
      await this.calibration.observeColumn({
        column,
        minPrice: this.exposure.minPrice,
        priceStep: this.exposure.priceStep,
        modelVersion: this.deps.config.modelVersion,
        createdAt: column.timestamp
      });
      this.lastCalibratedCutoff = column.timestamp;
      if (column.timestamp % (15 * 60_000) === 0) evaluated = true;
    }
    if (evaluated) await this.calibration.evaluate(now);
  }

  private async runMaintenance() {
    try {
      await this.calibration?.evaluate();
      this.deps.metrics.gauge(`bclif_calibration_${metricToken(this.symbol)}_healthy`, "Whether the symbol calibration repository completed its latest maintenance pass.", 1);
    } catch (error) {
      this.deps.metrics.gauge(`bclif_calibration_${metricToken(this.symbol)}_healthy`, "Whether the symbol calibration repository completed its latest maintenance pass.", 0);
      this.deps.logger.warn("collector.calibration_maintenance_failed", { symbol: this.symbol, error: message(error) });
    }
    try {
      const queued = await this.retention?.queueVerifiedSupersededTiles() ?? 0;
      const deleted = await this.retention?.runOnce() ?? 0;
      this.deps.metrics.counter("bclif_retention_objects_queued_total", "Verified superseded objects admitted to the fenced deletion queue.", queued);
      this.deps.metrics.counter("bclif_retention_objects_deleted_total", "Objects deleted after execution-time recovery verification.", deleted);
      this.deps.metrics.gauge(`bclif_retention_${metricToken(this.symbol)}_healthy`, "Whether the symbol retention worker completed its latest pass.", 1);
    } catch (error) {
      this.deps.metrics.gauge(`bclif_retention_${metricToken(this.symbol)}_healthy`, "Whether the symbol retention worker completed its latest pass.", 0);
      this.deps.logger.warn("collector.retention_maintenance_failed", { symbol: this.symbol, error: message(error) });
    }
  }

  private observeCoverageMetrics(coverage: ReturnType<BclifCoverageTracker["calculate"]>) {
    const prefix = `bclif_coverage_${metricToken(coverage.symbol)}_${metricToken(coverage.horizon)}`;
    const measurements = [
      ["trade", coverage.tradeCoveragePercent],
      ["liquidation", coverage.liquidationCoveragePercent],
      ["open_interest", coverage.openInterestCoveragePercent],
      ["orderbook", coverage.orderbookCoveragePercent],
      ["funding", coverage.fundingCoveragePercent],
      ["continuity", coverage.continuityPercent]
    ] as const;
    for (const [source, value] of measurements) {
      if (value !== null) this.deps.metrics.gauge(`${prefix}_${source}_percent`, "Exact observed-source coverage percentage for one symbol and horizon.", value);
    }
    if (coverage.continuityPercent !== null) this.deps.metrics.gauge("bclif_coverage_percentage", "Continuity percentage for the most recently published symbol/horizon tile.", coverage.continuityPercent);
  }

  private recordCoverage(start: number, end: number, availability: Record<string, boolean>) {
    const map: Array<[BclifCoverageSource, boolean]> = [
      ["TRADE", Boolean(availability.trades)], ["LIQUIDATION", Boolean(availability.liquidations)], ["OPEN_INTEREST", Boolean(availability.openInterest)],
      ["BOOK_FRAME", Boolean(availability.orderbook)], ["FUNDING", Boolean(availability.funding)]
    ];
    for (const [source, available] of map) if (available) this.coverage.record(source, start, end);
  }

  private async recoverSpool() {
    const recovered = await this.spool.recover();
    if (!recovered.length) return;
    const archived = await this.eventRepository!.archivedDedupKeys(recovered);
    const alreadyArchived = recovered.filter((event) => archived.has(bclifArchivedEventIdentity(event)));
    if (alreadyArchived.length) {
      await this.deduplicator!.commit(alreadyArchived);
      await this.spool.acknowledge(alreadyArchived);
    }
    const pending = await this.deduplicator!.filterNew(recovered.filter((event) => !archived.has(bclifArchivedEventIdentity(event))), Date.now(), false);
    if (pending.length) {
      this.batcher!.add(pending);
      this.deduplicator!.seed(pending);
      await this.batcher!.drain();
    }
  }

  private async flushAndRecover() {
    try {
      await this.batcher!.flushAged();
      await this.recoverSpool();
      this.deps.health.degrade("STORAGE_DEGRADED", false, this.symbol);
    } catch (error) {
      this.deps.health.degrade("STORAGE_DEGRADED", true, this.symbol);
      this.deps.metrics.counter("bclif_storage_failures_total", "Persistent storage operation failures.");
      if ((error as { code?: string }).code === "BCLIF_SPOOL_FULL" || this.spool.usage().ratio >= 1) {
        this.accepting = false;
        this.socket?.stop();
      }
      throw error;
    }
  }

  private restoreCheckpoint(state: Awaited<ReturnType<BclifCheckpointRepository["loadLatest"]>>["state"]) {
    if (!state || !this.cohort || !this.exposure) return;
    this.cohort.importState(state.cohortState, state.processedEventIds, state.sourceCutoffTimestamp);
    this.exposure.normalizer.importState(state.normalizerState);
    if (state.confirmedIntensityState) this.exposure.confirmedNormalizer.importState(state.confirmedIntensityState);
    this.lastConsumedOpenInterest = state.lastConsumedOpenInterest;
    this.lastOiAt = state.lastConsumedOpenInterest?.availableAt ?? null;
    if (state.lastConsumedOpenInterest) this.openInterest.push(state.lastConsumedOpenInterest);
    if (state.coverageIntervals) this.coverage.restore(state.coverageIntervals);
    for (const offset of state.sourceOffsets) {
      const current = this.offsets.get(offset.source);
      if (!current || offset.updatedAt > current.updatedAt) this.offsets.set(offset.source, offset);
    }
    this.lastEnvelope = state.activeFrame;
    if (state.activeFrame) this.restoreFrameContext(state.activeFrame);
    if (state.activeTile) {
      const restored = restoreColumns(state.activeTile);
      const recovered = recoverLatestActiveBucket(restored, this.deps.config.tileColumnCadenceMs, BASE_TILE_HORIZON_MS);
      this.activeColumns = recovered.columns;
      if (recovered.droppedColumns > 0) {
        this.deps.metrics.counter("bclif_legacy_checkpoint_columns_discarded_total", "Legacy active-tile columns discarded while recovering the newest bounded UTC bucket.", recovered.droppedColumns);
        this.deps.logger.warn("collector.legacy_active_tile_recovered", {
          symbol: this.symbol,
          keptBucketStart: recovered.bucketStart,
          droppedColumns: recovered.droppedColumns,
          droppedBuckets: recovered.droppedBuckets
        });
      }
    }
  }

  private async saveCheckpoint(reason: "INTERVAL" | "GRACEFUL_SHUTDOWN" | "BACKFILL_COMPLETE") {
    if (!this.cohort || !this.exposure || !this.checkpointRepository) return;
    const started = performance.now();
    const now = Date.now();
    try {
      // A checkpoint cutoff may only advance after every accepted event at or
      // below it has an immutable archive object and durable dedup record.
      await this.batcher?.drain();
      await this.persistOffsets();
      await this.checkpointRepository.save({
      schemaVersion: 1,
      modelVersion: this.deps.config.modelVersion,
      sourceVersion: this.deps.config.sourceVersion,
      venue: "BYBIT",
      symbol: this.symbol,
      timestamp: now,
      sourceCutoffTimestamp: Math.min(now, this.lastEnvelope?.sourceCutoffTimestamp ?? now),
      cohortState: this.cohort.exportState(),
      normalizerState: this.exposure.normalizer.exportState(),
      confirmedIntensityState: this.exposure.confirmedNormalizer.exportState(),
      instrumentRules: this.rules!,
      lastConsumedOpenInterest: this.lastConsumedOpenInterest,
      sourceOffsets: [...this.offsets.values()],
      processedEventIds: this.cohort.processedIds(),
      activeFrame: this.lastEnvelope,
      activeTile: checkpointTile(this.activeColumns, this.exposure, this.deps.config.tileColumnCadenceMs),
      coverageIntervals: this.coverage.snapshot()
      }, reason);
      this.deps.health.degrade("CHECKPOINT_DEGRADED", false, this.symbol);
      this.deps.metrics.observe("bclif_checkpoint_duration_ms", "Verified checkpoint publication duration.", performance.now() - started);
    } catch (error) {
      this.deps.health.degrade("CHECKPOINT_DEGRADED", true, this.symbol);
      this.deps.metrics.counter("bclif_checkpoint_failures_total", "Checkpoint persistence failures.");
      throw error;
    }
  }

  private async persistOffsets() { for (const offset of this.offsets.values()) await this.offsetRepository!.save(offset); }

  private observeOffset(event: BclifCanonicalEvent) {
    const source = event.kind;
    const previous = this.offsets.get(source);
    const offset: BclifSourceOffset = {
      sourceId: this.sourceId,
      venue: "BYBIT",
      symbol: this.symbol,
      source,
      sourceVersion: this.deps.config.sourceVersion,
      lastExchangeTimestamp: Math.max(previous?.lastExchangeTimestamp ?? 0, event.exchangeTimestamp),
      lastReceivedTimestamp: Math.max(previous?.lastReceivedTimestamp ?? 0, event.receivedTimestamp),
      lastSequence: event.sourceSequence,
      lastEventId: event.eventId,
      continuityStartedAt: previous?.continuityStartedAt ?? event.receivedTimestamp,
      continuityState: "OBSERVED",
      gapCount: previous?.gapCount ?? 0,
      reconnectCount: previous?.reconnectCount ?? 0,
      safeMetadata: previous?.safeMetadata ?? {},
      updatedAt: Date.now()
    };
    this.offsets.set(source, offset);
  }

  private async absorbRecoveredEvents(events: readonly BclifCanonicalEvent[]) {
    const recoveredLiquidations: BclifCanonicalEvent<PersistentLiquidationEvent>[] = [];
    for (const event of events) {
      this.observeOffset(event);
      if (event.kind === "TRADE") this.trades.push(event as BclifCanonicalEvent<PersistentPublicTrade>);
      else if (event.kind === "LIQUIDATION") {
        const typed = event as BclifCanonicalEvent<PersistentLiquidationEvent>;
        this.liquidations.push(typed);
        this.confirmed.push(confirmedEvent(typed));
        recoveredLiquidations.push(typed);
      } else if (event.kind === "OPEN_INTEREST") this.openInterest.push(event.payload as BclifOpenInterestPoint);
      else if (event.kind === "BOOK_FRAME") this.bookFrames.push(event.payload as BclifBookFrame);
      else if (event.kind === "MARK_INDEX") this.tickers.push(event.payload as BclifTickerContext);
      else if (event.kind === "POSITION_RATIO") this.ratios.push(event.payload as BclifRatioContext);
      else if (event.kind === "RISK_TIER") {
        const rules = event.payload as LiquidationInstrumentRules & { availableAt?: number };
        if (rules.venue !== "BYBIT" || rules.symbol !== this.symbol || rules.sourceVersion !== this.deps.config.sourceVersion) throw new Error("BCLIF recovered risk-tier identity mismatch");
        this.rules = rules;
        this.cohort?.updateRules(rules);
      }
    }
    // Canonical chunks and the queryable observed-liquidation projection have
    // separate crash boundaries. Rebuild the projection idempotently before
    // publishing any recovered model state.
    if (recoveredLiquidations.length) await this.confirmedRepository!.persist(recoveredLiquidations);
  }

  private async replayRecoveredEvents(events: readonly BclifCanonicalEvent[]) {
    const ordered = [...events].sort(compareKnownEvents);
    if (!ordered.length) return;
    const cadence = this.deps.config.frameCadenceMs;
    const latestClosedFrame = Math.floor(Date.now() / cadence) * cadence;
    let cursor = 0;
    while (cursor < ordered.length) {
      const eventKnownAt = knownAt(ordered[cursor]!);
      const frameEnd = Math.ceil(eventKnownAt / cadence) * cadence;
      if (frameEnd > latestClosedFrame) break;
      const batch: BclifCanonicalEvent[] = [];
      while (cursor < ordered.length && knownAt(ordered[cursor]!) <= frameEnd) batch.push(ordered[cursor++]!);
      await this.absorbRecoveredEvents(batch);
      await this.processFrameAt(frameEnd, true);
    }
    if (cursor < ordered.length) await this.absorbRecoveredEvents(ordered.slice(cursor));
  }

  private restoreFrameContext(envelope: BclifFrameEnvelope) {
    const frame = envelope.frame;
    const cutoff = envelope.sourceCutoffTimestamp;
    this.tickers.push({
      exchangeTimestamp: frame.timestamp,
      receivedTimestamp: cutoff,
      lastPrice: frame.lastPrice,
      markPrice: frame.markPrice,
      indexPrice: frame.indexPrice,
      basisBps: frame.basisBps,
      singleSideOpenInterest: frame.openInterest,
      fundingRate: frame.fundingRate,
      bestBid: frame.bestBid,
      bestAsk: frame.bestAsk
    });
    if (frame.longAccountRatio !== null && frame.shortAccountRatio !== null) {
      this.ratios.push({ timestamp: frame.timestamp, receivedTimestamp: cutoff, longAccountRatio: frame.longAccountRatio, shortAccountRatio: frame.shortAccountRatio });
    }
  }

  private async updateSourceState() {
    const freshness = this.freshness();
    const now = Date.now();
    const bookStale = !this.subscriptionsAcknowledged || freshness.orderbookAgeMs === null || freshness.orderbookAgeMs > Math.max(15_000, this.deps.config.bookFrameCadenceMs * 3);
    const transportStale = this.lastTransportActivityAt === null || now - this.lastTransportActivityAt > 45_000;
    const tradesStale = !this.streamConnected || !this.subscriptionsAcknowledged || transportStale;
    const oiStale = freshness.openInterestAgeMs === null || freshness.openInterestAgeMs > Math.max(30_000, this.deps.config.contextPollIntervalMs * 2);
    const secondaryStale = !this.streamConnected || bookStale || tradesStale || oiStale;
    this.deps.health.degrade("ORDERBOOK_STALE", bookStale, this.symbol);
    this.deps.health.degrade("TRADES_STALE", tradesStale, this.symbol);
    this.deps.health.degrade("LIQUIDATIONS_STALE", !this.streamConnected || !this.subscriptionsAcknowledged, this.symbol);
    this.deps.health.degrade("OI_STALE", oiStale, this.symbol);
    await this.deps.sourceRepository.updateSource(this.sourceId, {
      state: !this.liveReady() ? "SYNCING" : secondaryStale ? "DEGRADED" : "LIVE",
      continuityState: freshness.openInterestAgeMs !== null ? "DERIVED" : "MISSING",
      sourceCutoffTimestamp: this.lastEnvelope?.sourceCutoffTimestamp ?? null,
      freshness,
      metadata: { authority: "PERSISTENT_NODE", degraded: secondaryStale, reconnects: this.reconnects, gaps: this.gaps }
    });
    for (const [name, value] of [["bclif_oi_refresh_age_ms", freshness.openInterestAgeMs], ["bclif_book_update_age_ms", freshness.orderbookAgeMs]] as const) {
      if (value !== null) this.deps.metrics.gauge(name, "Age of the latest canonical source observation.", value);
    }
    const recentWindowStart = now - 60_000;
    const tradeRate = this.trades.filter((event) => event.receivedTimestamp > recentWindowStart).length / 60;
    const liquidationRate = this.liquidations.filter((event) => event.receivedTimestamp > recentWindowStart).length / 60;
    this.deps.metrics.gauge("bclif_trade_event_rate", "Canonical public trades received per second over the trailing minute for the latest updated symbol.", tradeRate);
    this.deps.metrics.gauge("bclif_liquidation_event_rate", "Canonical liquidation events received per second over the trailing minute for the latest updated symbol.", liquidationRate);
    this.deps.metrics.gauge(`bclif_trade_event_rate_${metricToken(this.symbol)}`, "Canonical public trades received per second over the trailing minute for this symbol.", tradeRate);
    this.deps.metrics.gauge(`bclif_liquidation_event_rate_${metricToken(this.symbol)}`, "Canonical liquidation events received per second over the trailing minute for this symbol.", liquidationRate);
  }

  private updateHealth(source: string, connected: boolean, error: string | null) {
    const state: BclifSourceHealth = {
      source: `${this.symbol}:${source}`,
      initialized: true,
      connected,
      lastMessageAt: source === "TRADE" ? this.lastTradeAt : source === "LIQUIDATION" ? this.lastLiquidationAt : this.lastBookAt,
      reconnects: this.reconnects,
      gaps: this.gaps,
      deduplicated: 0,
      error,
      certainty: connected ? "OBSERVED" : "MISSING"
    };
    this.deps.health.source(state.source, state);
  }

  private bumpContinuity(sources: readonly string[], gapDelta: number, reconnectDelta: number) {
    const now = Date.now();
    for (const source of sources) {
      const previous = this.offsets.get(source);
      this.offsets.set(source, {
        sourceId: this.sourceId,
        venue: "BYBIT",
        symbol: this.symbol,
        source,
        sourceVersion: this.deps.config.sourceVersion,
        lastExchangeTimestamp: previous?.lastExchangeTimestamp ?? null,
        lastReceivedTimestamp: previous?.lastReceivedTimestamp ?? null,
        lastSequence: previous?.lastSequence ?? null,
        lastEventId: previous?.lastEventId ?? null,
        continuityStartedAt: previous?.continuityStartedAt ?? now,
        continuityState: "MISSING",
        gapCount: (previous?.gapCount ?? 0) + gapDelta,
        reconnectCount: (previous?.reconnectCount ?? 0) + reconnectDelta,
        safeMetadata: previous?.safeMetadata ?? {},
        updatedAt: now
      });
    }
  }

  private pruneMemory(frameEnd: number) {
    const cutoff = frameEnd - MEMORY_WINDOW_MS;
    this.trades = this.trades.filter((event) => Math.max(event.exchangeTimestamp, event.receivedTimestamp) > cutoff);
    this.liquidations = this.liquidations.filter((event) => Math.max(event.exchangeTimestamp, event.receivedTimestamp) > cutoff);
    this.confirmed = this.confirmed.filter((event) => Math.max(event.timestamp, event.receivedAt) > cutoff);
    this.bookFrames = this.bookFrames.filter((frame) => frame.receivedTimestamp > cutoff).slice(-2_000);
    this.ratios = this.ratios.filter((ratio) => ratio.receivedTimestamp > cutoff).slice(-2_000);
  }

  private contextEvent(kind: "FUNDING" | "MARK_INDEX" | "POSITION_RATIO" | "RISK_TIER" | "INSTRUMENT_INFO", suffix: string, exchangeTimestamp: number, receivedTimestamp: number, payload: unknown) {
    return canonicalEvent({ eventId: `BYBIT:${this.symbol}:${suffix}`, kind, symbol: this.symbol, exchangeTimestamp, receivedTimestamp, sourceVersion: this.deps.config.sourceVersion, payload });
  }

  private handleOperationalFailure(error: unknown) {
    this.deps.logger.error("collector.symbol_operation_failed", { symbol: this.symbol, error: message(error) });
    if (["BCLIF_SPOOL_FULL", "BCLIF_BATCH_BACKPRESSURE"].includes(String((error as { code?: string }).code || ""))) {
      this.accepting = false;
      this.socket?.stop();
      this.deps.health.degrade("STORAGE_DEGRADED", true, this.symbol);
    }
  }
}

function gridFor(markPrice: number, tickSize: number) {
  const rows = 512;
  const minPrice = Math.max(tickSize, Math.floor(markPrice * 0.35 / tickSize) * tickSize);
  const rawStep = (markPrice * 1.75 - minPrice) / (rows - 1);
  const priceStep = Math.max(tickSize, Math.ceil(rawStep / tickSize) * tickSize);
  return { rows, minPrice, priceStep };
}

function missingColumn(timestamp: number, exposure: BclifExposureRuntime): BclifModelColumn {
  const bounds = exposure.normalizer.exportState();
  return {
    timestamp,
    longExposure: new Float32Array(exposure.rows),
    shortExposure: new Float32Array(exposure.rows),
    combinedExposure: new Float32Array(exposure.rows),
    confidence: new Uint8Array(exposure.rows),
    validity: new Uint8Array(exposure.rows),
    confirmedIntensity: new Uint8Array(exposure.rows),
    confirmedNotional: new Float32Array(exposure.rows),
    confirmedCount: new Uint16Array(exposure.rows),
    causalNormalizationLow: bounds.lastLow,
    causalNormalizationHigh: Math.max(bounds.lastLow + 1e-6, bounds.lastHigh)
  };
}

function checkpointTile(columns: readonly BclifModelColumn[], exposure: BclifExposureRuntime, configuredCadenceMs: number): BclifActiveTileCheckpoint | null {
  if (!columns.length) return null;
  assertSingleBoundedBucket(columns.map((column) => column.timestamp), configuredCadenceMs, BASE_TILE_HORIZON_MS, "checkpoint active tile");
  return {
    rows: exposure.rows,
    minPrice: exposure.minPrice,
    priceStep: exposure.priceStep,
    timeStepMs: columns.length > 1 ? columns[1]!.timestamp - columns[0]!.timestamp : configuredCadenceMs,
    columns: columns.map((column) => ({
      timestamp: column.timestamp,
      longExposure: [...column.longExposure],
      shortExposure: [...column.shortExposure],
      combinedExposure: [...(column.combinedExposure || new Float32Array(exposure.rows))],
      confidence: [...column.confidence],
      validity: [...column.validity],
      confirmedIntensity: [...column.confirmedIntensity],
      confirmedNotional: [...column.confirmedNotional],
      confirmedCount: [...column.confirmedCount],
      causalNormalizationLow: column.causalNormalizationLow!,
      causalNormalizationHigh: column.causalNormalizationHigh!
    }))
  };
}

function restoreColumns(active: BclifActiveTileCheckpoint): BclifModelColumn[] {
  return active.columns.map((column) => ({
    timestamp: column.timestamp,
    longExposure: Float32Array.from(column.longExposure),
    shortExposure: Float32Array.from(column.shortExposure),
    combinedExposure: Float32Array.from(column.combinedExposure),
    confidence: Uint8Array.from(column.confidence),
    validity: Uint8Array.from(column.validity),
    confirmedIntensity: Uint8Array.from(column.confirmedIntensity),
    confirmedNotional: Float32Array.from(column.confirmedNotional),
    confirmedCount: Uint16Array.from(column.confirmedCount),
    causalNormalizationLow: column.causalNormalizationLow,
    causalNormalizationHigh: column.causalNormalizationHigh
  }));
}

function latestKnown<T>(items: readonly T[], cutoff: number, timestamp: (item: T) => number, available: (item: T) => number) {
  return [...items].filter((item) => timestamp(item) <= cutoff && available(item) <= cutoff).sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
}
function age(now: number, timestamp: number | null) { return timestamp === null ? null : Math.max(0, now - timestamp); }
function knownAt(event: Pick<BclifCanonicalEvent, "exchangeTimestamp" | "receivedTimestamp">) { return Math.max(event.exchangeTimestamp, event.receivedTimestamp); }
function compareKnownEvents(left: BclifCanonicalEvent, right: BclifCanonicalEvent) {
  return knownAt(left) - knownAt(right)
    || left.exchangeTimestamp - right.exchangeTimestamp
    || left.eventId.localeCompare(right.eventId);
}
function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [record.code, record.message, record.details, record.hint]
    .filter((value) => typeof value === "string" && value.trim())
    .join(": ") || "Non-Error object";
}
function metricToken(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"; }
function aggregateFreshness(values: readonly BclifSourceFreshness[]): BclifSourceFreshness {
  const keys = ["tradesAgeMs", "liquidationsAgeMs", "orderbookAgeMs", "openInterestAgeMs", "fundingAgeMs", "markPriceAgeMs", "riskTierAgeMs"] as const;
  return Object.fromEntries(keys.map((key) => {
    const available = values.map((value) => value[key]).filter((value): value is number => value !== null);
    return [key, available.length ? Math.max(...available) : null];
  })) as unknown as BclifSourceFreshness;
}
