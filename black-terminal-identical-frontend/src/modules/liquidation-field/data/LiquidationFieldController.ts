import type { Candle } from "../../../chart-engine/types.ts";
import { migrateLiquidationFieldSettings } from "../core/settings.ts";
import type {
  BclifModelAuthority,
  LiquidationFieldRuntimeStatus,
  LiquidationFieldSettings,
  LiquidationFieldSnapshot
} from "../core/types.ts";
import { applyBclifVisualCertificationProfile, createLiquidationFieldFixture } from "../testing/fixtures.ts";
import { LiquidationFieldWorkerClient } from "../worker/LiquidationFieldWorkerClient.ts";
import { BrowserLiquidationFieldFallback } from "./BrowserLiquidationFieldFallback.ts";
import {
  PersistentLiquidationFieldAccessError,
  PersistentLiquidationFieldClient,
  PersistentLiquidationFieldUnavailableError,
  persistentErrorAllowsInitialBrowserFallback,
  type PersistentLiquidationFieldLoadResult
} from "./PersistentLiquidationFieldClient.ts";
import { LiquidationFieldTileContractError } from "./LiquidationFieldTileCodec.ts";

export interface LiquidationFieldControllerOptions {
  symbol: string;
  settings: LiquidationFieldSettings;
  getCandles: () => Candle[];
  getReplayActive?: () => boolean;
  onSnapshot: (snapshot: LiquidationFieldSnapshot | null) => void;
  onStatus: (status: LiquidationFieldRuntimeStatus) => void;
  persistentClient?: PersistentLiquidationFieldAuthorityClient;
  createBrowserFallback?: (options: ConstructorParameters<typeof BrowserLiquidationFieldFallback>[0]) => BrowserLiquidationFieldHandle;
}

export interface PersistentLiquidationFieldAuthorityClient {
  load(signal: AbortSignal): Promise<PersistentLiquidationFieldLoadResult>;
  probe(signal: AbortSignal): Promise<boolean>;
  updateSettings(settings: LiquidationFieldSettings): boolean;
  clear(): void;
}

export interface BrowserLiquidationFieldHandle {
  start(reason?: string): Promise<void>;
  updateSettings(settings: LiquidationFieldSettings): void;
  dispose(): void;
}

type SelectedAuthority = BclifModelAuthority | "PROBING";

/**
 * Authority selector for BCLIF. Persistent market memory is resolved before a
 * browser WebSocket can be constructed. Once selected, an authority remains
 * exclusive for the lifetime of this controller.
 */
export class LiquidationFieldController {
  private settings: LiquidationFieldSettings;
  private readonly persistent: PersistentLiquidationFieldAuthorityClient;
  private fallback: BrowserLiquidationFieldHandle | null = null;
  private fixtureWorker: LiquidationFieldWorkerClient | null = null;
  private persistentRefreshTimer: number | null = null;
  private fallbackProbeTimer: number | null = null;
  private readonly abort = new AbortController();
  private disposed = false;
  private persistentRefreshInFlight = false;
  private fallbackProbeInFlight = false;
  private fallbackProbeAttempt = 0;
  private persistentGeneration = 0;
  private hasPersistentSnapshot = false;
  private selectedAuthority: SelectedAuthority = "PROBING";

  constructor(private readonly options: LiquidationFieldControllerOptions) {
    this.settings = migrateLiquidationFieldSettings(options.settings);
    this.persistent = options.persistentClient ?? new PersistentLiquidationFieldClient({
      symbol: options.symbol,
      settings: this.settings,
      getCandles: options.getCandles,
      getReplayActive: options.getReplayActive
    });
  }

  async start() {
    if (isBclifVisualFixtureEnabled()) {
      this.selectedAuthority = "TEST_FIXTURE";
      await this.buildFixture();
      return;
    }
    this.status({
      state: "LOADING",
      message: "Resolving protected persistent BCLIF authority before opening any browser market stream.",
      source: "PERSISTENT_COLLECTOR",
      authority: "PERSISTENT_NODE",
      persistence: "ON",
      collectorNodeId: null,
      lastInputAt: null
    });
    try {
      const generation = this.persistentGeneration;
      const result = await this.persistent.load(this.abort.signal);
      if (this.disposed || generation !== this.persistentGeneration) {
        if (!this.disposed) void this.start();
        return;
      }
      if (result.kind === "FALLBACK") {
        await this.startBrowserFallback(result.reason);
        return;
      }
      this.selectedAuthority = "PERSISTENT_NODE";
      if (result.kind === "SNAPSHOT") {
        this.hasPersistentSnapshot = true;
        this.options.onSnapshot(result.snapshot);
        this.persistentStatus(result.freshness, result.message, result.collectorNodeId, result.snapshot.generatedAt);
      } else {
        this.options.onSnapshot(null);
        this.persistentStatus("COLLECTING", result.message, result.collectorNodeId, null);
      }
      this.schedulePersistentRefresh();
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      if (persistentErrorAllowsInitialBrowserFallback(error)) {
        await this.startBrowserFallback(fallbackReason(error));
        return;
      }
      this.failClosed(error);
    }
  }

  updateSettings(settings: LiquidationFieldSettings) {
    this.settings = migrateLiquidationFieldSettings(settings);
    if (this.persistent.updateSettings(this.settings)) {
      this.persistentGeneration += 1;
      if (this.selectedAuthority === "PERSISTENT_NODE") this.schedulePersistentRefresh(0);
      if (this.selectedAuthority === "BROWSER_FALLBACK") this.scheduleFallbackProbe(0);
    }
    this.fallback?.updateSettings(this.settings);
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    if (this.persistentRefreshTimer !== null) window.clearTimeout(this.persistentRefreshTimer);
    if (this.fallbackProbeTimer !== null) window.clearTimeout(this.fallbackProbeTimer);
    this.fallback?.dispose();
    this.fixtureWorker?.dispose();
    this.persistent.clear();
  }

  private async startBrowserFallback(reason: string) {
    if (this.disposed || this.selectedAuthority === "PERSISTENT_NODE") return;
    this.selectedAuthority = "BROWSER_FALLBACK";
    this.fallback?.dispose();
    const fallbackOptions = {
      symbol: this.options.symbol,
      settings: this.settings,
      getCandles: this.options.getCandles,
      onSnapshot: this.options.onSnapshot,
      onStatus: this.options.onStatus
    };
    this.fallback = this.options.createBrowserFallback?.(fallbackOptions) ?? new BrowserLiquidationFieldFallback(fallbackOptions);
    await this.fallback.start(reason);
    this.scheduleFallbackProbe();
  }

  private scheduleFallbackProbe(delayMs?: number) {
    if (this.disposed || this.selectedAuthority !== "BROWSER_FALLBACK") return;
    if (this.fallbackProbeTimer !== null) window.clearTimeout(this.fallbackProbeTimer);
    const seed = [...this.options.symbol].reduce((sum, character) => (sum * 33 + character.charCodeAt(0)) >>> 0, 5381);
    const jitter = (seed + this.fallbackProbeAttempt++ * 7_919) % 15_001;
    this.fallbackProbeTimer = window.setTimeout(() => {
      this.fallbackProbeTimer = null;
      void this.probePersistentRecovery();
    }, delayMs ?? 30_000 + jitter);
  }

  private async probePersistentRecovery() {
    if (this.disposed || this.selectedAuthority !== "BROWSER_FALLBACK" || this.fallbackProbeInFlight) return;
    this.fallbackProbeInFlight = true;
    try {
      const available = await this.persistent.probe(this.abort.signal);
      if (this.disposed || this.selectedAuthority !== "BROWSER_FALLBACK" || !available) return;

      // Atomic authority handoff: stop the browser stream before requesting and
      // verifying any persistent tile. The last browser frame may remain frozen
      // until a verified persistent snapshot replaces it, but no second stream
      // or model runs concurrently.
      this.fallback?.dispose();
      this.fallback = null;
      this.selectedAuthority = "PROBING";
      this.status({
        state: "LOADING",
        message: "Persistent BCLIF authority recovered; verifying durable tiles before handoff.",
        source: "PERSISTENT_COLLECTOR",
        authority: "PERSISTENT_NODE",
        persistence: "ON",
        collectorNodeId: null,
        lastInputAt: null
      });
      const result = await this.persistent.load(this.abort.signal);
      if (this.disposed) return;
      if (result.kind === "FALLBACK") {
        await this.startBrowserFallback(`persistent recovery verification failed: ${result.reason}`);
        return;
      }
      this.selectedAuthority = "PERSISTENT_NODE";
      if (result.kind === "SNAPSHOT") {
        this.hasPersistentSnapshot = true;
        this.options.onSnapshot(result.snapshot);
        this.persistentStatus(result.freshness, result.message, result.collectorNodeId, result.snapshot.generatedAt);
      } else {
        this.hasPersistentSnapshot = false;
        this.options.onSnapshot(null);
        this.persistentStatus("COLLECTING", result.message, result.collectorNodeId, null);
      }
      this.schedulePersistentRefresh();
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      if (error instanceof PersistentLiquidationFieldAccessError || error instanceof LiquidationFieldTileContractError) {
        this.fallback?.dispose();
        this.fallback = null;
        this.selectedAuthority = "PROBING";
        this.failClosed(error);
        return;
      }
      if (this.selectedAuthority === "PROBING") {
        await this.startBrowserFallback(`persistent recovery attempt failed: ${fallbackReason(error)}`);
      }
    } finally {
      this.fallbackProbeInFlight = false;
      if (this.selectedAuthority === "BROWSER_FALLBACK") this.scheduleFallbackProbe();
    }
  }

  private schedulePersistentRefresh(delayMs?: number) {
    if (this.disposed || this.selectedAuthority !== "PERSISTENT_NODE") return;
    if (this.persistentRefreshTimer !== null) window.clearTimeout(this.persistentRefreshTimer);
    const cadence = Math.max(15_000, Math.min(60_000, this.settings.liveUpdateCadenceMs * 5));
    this.persistentRefreshTimer = window.setTimeout(() => {
      this.persistentRefreshTimer = null;
      void this.refreshPersistentLiveEdge();
    }, delayMs ?? cadence);
  }

  private async refreshPersistentLiveEdge() {
    if (this.disposed || this.selectedAuthority !== "PERSISTENT_NODE" || this.persistentRefreshInFlight) return;
    this.persistentRefreshInFlight = true;
    const generation = this.persistentGeneration;
    try {
      const result = await this.persistent.load(this.abort.signal);
      if (this.disposed || this.selectedAuthority !== "PERSISTENT_NODE" || generation !== this.persistentGeneration) return;
      if (result.kind === "SNAPSHOT") {
        this.hasPersistentSnapshot = true;
        this.options.onSnapshot(result.snapshot);
        this.persistentStatus(result.freshness, result.message, result.collectorNodeId, result.snapshot.generatedAt);
      } else if (result.kind === "WAITING") {
        this.persistentStatus(
          this.hasPersistentSnapshot ? "STALE" : "COLLECTING",
          this.hasPersistentSnapshot
            ? "Persistent manifest is temporarily empty; retaining only the last verified persistent field."
            : result.message,
          result.collectorNodeId,
          null
        );
      } else {
        this.persistentStatus(
          "STALE",
          "Persistent collector is temporarily unavailable; browser fallback remains disabled while verified persistent data is active.",
          null,
          null
        );
      }
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      if (error instanceof PersistentLiquidationFieldAccessError) {
        this.hasPersistentSnapshot = false;
        this.options.onSnapshot(null);
        this.failClosed(error);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.status({
        state: "STALE",
        message: "Persistent live-edge refresh failed; the last verified tile set remains visible without browser data mixing.",
        source: "PERSISTENT_COLLECTOR",
        authority: "PERSISTENT_NODE",
        persistence: "ON",
        collectorNodeId: null,
        lastInputAt: null,
        error: detail
      });
    } finally {
      this.persistentRefreshInFlight = false;
      this.schedulePersistentRefresh(generation === this.persistentGeneration ? undefined : 0);
    }
  }

  private async buildFixture() {
    this.fixtureWorker = new LiquidationFieldWorkerClient();
    const lastCandle = this.options.getCandles().at(-1);
    const alignedNow = lastCandle ? lastCandle.time * 1_000 : Date.now();
    const fixture = createLiquidationFieldFixture(alignedNow);
    const snapshot = applyBclifVisualCertificationProfile(await this.fixtureWorker.build({ ...fixture, settings: this.settings }));
    if (this.disposed) return;
    this.options.onSnapshot(snapshot);
    this.status({
      state: "LIVE",
      message: "Deterministic localhost visual fixture — synthetic test data, never trading data.",
      source: "SYNTHETIC_TEST",
      authority: "TEST_FIXTURE",
      persistence: "OFF",
      collectorNodeId: null,
      lastInputAt: alignedNow
    });
  }

  private persistentStatus(
    state: LiquidationFieldRuntimeStatus["state"],
    message: string,
    collectorNodeId: string | null,
    lastInputAt: number | null
  ) {
    this.status({
      state,
      message,
      source: "PERSISTENT_COLLECTOR",
      authority: "PERSISTENT_NODE",
      persistence: "ON",
      collectorNodeId,
      lastInputAt
    });
  }

  private failClosed(error: unknown) {
    const access = error instanceof PersistentLiquidationFieldAccessError;
    const contractFailure = error instanceof LiquidationFieldTileContractError;
    const detail = error instanceof Error ? error.message : String(error);
    this.options.onSnapshot(null);
    this.status({
      state: access ? "UNAVAILABLE" : "ERROR",
      message: access
        ? "Persistent Liquidation Intelligence access is not authorized. Browser fallback was not started."
        : contractFailure
          ? "Persistent BCLIF tile verification failed. Browser fallback was not started."
          : "Persistent Liquidation Intelligence is unavailable.",
      source: "PERSISTENT_COLLECTOR",
      authority: "PERSISTENT_NODE",
      persistence: "ON",
      collectorNodeId: null,
      lastInputAt: null,
      error: detail
    });
  }

  private status(status: LiquidationFieldRuntimeStatus) {
    if (!this.disposed) this.options.onStatus(status);
  }
}

export function isBclifVisualFixtureEnabled(locationValue?: Pick<Location, "hostname" | "search">) {
  const resolved = locationValue ?? (typeof window === "undefined" ? { hostname: "", search: "" } : window.location);
  const local = resolved.hostname === "localhost" || resolved.hostname === "127.0.0.1" || resolved.hostname === "::1";
  return local && new URLSearchParams(resolved.search).get("bclifVisualFixture") === "1";
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function fallbackReason(error: unknown) {
  if (error instanceof PersistentLiquidationFieldUnavailableError) return error.reason;
  return error instanceof Error ? error.name : "NETWORK";
}
