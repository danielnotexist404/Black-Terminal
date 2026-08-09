import { BufferImageSource, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { extractBclifOperationalClusters } from "../core/operationalClusters.ts";
import {
  bclifRenderSettingsHash,
  buildBclifDisplayProjection,
  type BclifDisplayProjection
} from "./displayProjection.ts";
import { buildBclifDisplayTexture } from "./displayTexture.ts";
import { buildBclifRawExposureExport } from "../core/rawShelfDiagnostics.ts";

export interface LiquidationFieldRenderTransform {
  width: number;
  height: number;
  top: number;
  bottom: number;
  priceMin: number;
  priceMax: number;
  currentPrice: number;
  constrainedTouchRenderer: boolean;
  xForTimestampMs(timestampMs: number): number;
  yForPrice(price: number): number;
}
export type BclifRendererReadiness =
  | "RENDERER_INITIALIZING"
  | "WEBGL_CONTEXT_READY"
  | "FILTERED_EMPTY"
  | "INVISIBLE_TEXTURE"
  | "TEXTURE_ERROR";

export interface BclifRendererMetrics {
  readiness: BclifRendererReadiness;
  webglContextReady: boolean;
  textureAllocated: boolean;
  bufferValid: boolean;
  snapshotApplied: boolean;
  textureUploaded: boolean;
  drawPassActive: boolean;
  textureUploadCount: number;
  rendererAttachmentTimestamp: number;
  textureUploadTimestamp: number | null;
  textureUploadDurationMs: number | null;
  texturePreparationAndUpdateMs: number | null;
  latestModelGeneration: number;
  latestRenderedGeneration: number;
  generationLag: number;
  rawNonZeroCells: number;
  validCells: number;
  visibleCells: number;
  filteredCells: number;
  nonZeroTexels: number;
  minimumAlpha: number;
  maximumAlpha: number;
  textureDimensions: string | null;
  error: string | null;
}
export function validateBclifProjection(projection: BclifDisplayProjection) {
  if (!Number.isInteger(projection.columns) || !Number.isInteger(projection.rows) || projection.columns <= 0 || projection.rows <= 0) {
    throw new Error("BCLIF_TEXTURE_DIMENSIONS_INVALID");
  }
  const cells = projection.columns * projection.rows;
  for (const channel of [projection.intensity, projection.alpha, projection.validity, projection.yellowEligible]) {
    if (channel.length !== cells) throw new Error("BCLIF_TEXTURE_BUFFER_LENGTH_INVALID");
  }
  if (!Number.isFinite(projection.minPrice) || !Number.isFinite(projection.maxPrice) || projection.maxPrice <= projection.minPrice) {
    throw new Error("BCLIF_TEXTURE_PRICE_DOMAIN_INVALID");
  }
}


function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * One persistent GPU texture plus a small overlay geometry. No DOM cells and no
 * one-Pixi-object-per-field-cell allocation are used in the hot path.
 */
export class BlackCoreLiquidationFieldRenderer {
  readonly container = new Container();
  private clip = new Graphics();
  private overlay = new Graphics();
  private sprite: Sprite | null = null;
  private texture: Texture<BufferImageSource> | null = null;
  private source: BufferImageSource | null = null;
  private snapshot: LiquidationFieldSnapshot | null = null;
  private settings: LiquidationFieldSettings | null = null;
  private stateKey = "";
  private textureKey = "";
  private rgba: Uint8Array | null = null;
  private projection: BclifDisplayProjection | null = null;
  private projectionWorker: Worker | null = null;
  private projectionGeneration = 0;
  private pendingProjectionKey = "";
  private readonly rendererAttachmentTimestamp = Date.now();
  private webglContextReady = true;
  private textureUploadCount = 0;
  private textureUploadTimestamp: number | null = null;
  private textureUploadDurationMs: number | null = null;
  private texturePreparationAndUpdateMs: number | null = null;
  private latestRenderedGeneration = 0;
  private lastError: string | null = null;
  private drawPassActive = false;
  private bufferValid = false;
  private currentTextureUploaded = false;
  private readonly onProjectionReady?: (metrics: BclifRendererMetrics) => void;

  constructor(onProjectionReady?: (metrics: BclifRendererMetrics) => void) {
    this.onProjectionReady = onProjectionReady;
    this.container.addChild(this.clip, this.overlay);
    this.container.mask = this.clip;
    if (typeof Worker !== "undefined") {
      this.projectionWorker = new Worker(new URL("./displayProjectionWorker.ts", import.meta.url), {
        type: "module",
        name: "black-core-bclif-display-projection"
      });
      this.projectionWorker.onmessage = (event: MessageEvent<{
        generation: number;
        key: string;
        projection: BclifDisplayProjection | null;
      }>) => {
        if (event.data.generation !== this.projectionGeneration || event.data.key !== this.pendingProjectionKey) return;
        this.pendingProjectionKey = "";
        this.textureKey = event.data.key;
        this.projection = event.data.projection;
        this.rebuildTexture();
        this.emitMetrics();
      };
      this.projectionWorker.onerror = (event) => {
        this.pendingProjectionKey = "";
        this.lastError = event.message || "BCLIF_PROJECTION_WORKER_FAILED";
        if (this.sprite) this.sprite.visible = false;
        this.emitMetrics();
      };
    }
  }

  setState(snapshot: LiquidationFieldSnapshot | null, settings: LiquidationFieldSettings) {
    const snapshotChanged = this.snapshot !== snapshot;
    this.snapshot = snapshot;
    this.settings = settings;
    const nextKey = snapshot
      ? [snapshot.header.checksum, snapshot.authority, snapshot.header.sourceCutoffTimestamp, bclifRenderSettingsHash(settings)].join(":")
      : "empty";
    if (snapshotChanged || nextKey !== this.stateKey) {
      this.stateKey = nextKey;
      this.projection = null;
      this.projectionGeneration += 1;
      this.pendingProjectionKey = "";
      this.bufferValid = false;
      this.currentTextureUploaded = false;
      this.drawPassActive = false;
    }
    if (!snapshot && this.sprite) this.sprite.visible = false;
  }

  draw(transform: LiquidationFieldRenderTransform) {
    this.drawPassActive = false;
    this.clip.clear().rect(0, transform.top, transform.width, Math.max(0, transform.bottom - transform.top)).fill(0xffffff);
    this.overlay.clear();
    const snapshot = this.snapshot;
    const settings = this.settings;
    if (!snapshot || !settings) return;

    const projectionKey = [
      this.stateKey,
      Math.round(transform.priceMin / Math.max(snapshot.header.priceStep, 1e-8)),
      Math.round(transform.priceMax / Math.max(snapshot.header.priceStep, 1e-8)),
      Math.round(transform.width / 64),
      Math.round((transform.bottom - transform.top) / 64),
      Math.round(transform.currentPrice / Math.max(snapshot.header.priceStep, 1e-8)),
      transform.constrainedTouchRenderer ? 1 : 0
    ].join(":");
    if (!this.projection || this.textureKey !== projectionKey) {
      const context = {
        chartPriceMinimum: transform.priceMin,
        chartPriceMaximum: transform.priceMax,
        currentPrice: transform.currentPrice,
        plotWidth: transform.width,
        plotHeight: transform.bottom - transform.top,
        constrainedTouchRenderer: transform.constrainedTouchRenderer
      };
      if (this.projectionWorker) {
        this.requestProjection(projectionKey, snapshot, settings, context);
      } else {
        this.textureKey = projectionKey;
        this.projection = buildBclifDisplayProjection(snapshot, settings, context);
        this.rebuildTexture();
        this.emitMetrics();
      }
    }
    const projection = this.projection;
    const sprite = this.sprite;
    if (!projection || !sprite) return;

    const left = transform.xForTimestampMs(snapshot.header.startTime);
    const right = transform.xForTimestampMs(snapshot.header.endTime);
    const top = transform.yForPrice(projection.maxPrice);
    const bottom = transform.yForPrice(projection.minPrice);
    sprite.x = Math.min(left, right);
    sprite.y = Math.min(top, bottom);
    sprite.width = Math.max(1, Math.abs(right - left));
    sprite.height = Math.max(1, Math.abs(bottom - top));
    sprite.alpha = Math.max(0, Math.min(1, settings.opacity / 100));
    sprite.visible = !settings.rawCohortShelvesVisible
      && right >= 0 && left <= transform.width && bottom >= transform.top && top <= transform.bottom;
    this.drawPassActive = sprite.visible;

    if (settings.rawCohortShelvesVisible) {
      const shelves = snapshot.rawCohortShelves ?? snapshot.cohorts.map((cohort) => ({
        cohortId: cohort.id,
        side: cohort.side,
        createdAt: cohort.createdAt,
        sourceIntervalStart: cohort.sourceIntervalStart,
        sourceIntervalEnd: cohort.sourceIntervalEnd,
        entryLower: cohort.entryLower,
        entryMean: cohort.entryMean,
        entryUpper: cohort.entryUpper,
        liquidationLower: cohort.liquidationLower,
        liquidationMean: cohort.liquidationMean,
        liquidationUpper: cohort.liquidationUpper,
        remainingMass: cohort.estimatedRemainingNotional,
        confidence: cohort.confidence,
        entrySource: cohort.entryDistribution.source,
        leverageContributions: cohort.leverageDistribution,
        marginMode: cohort.marginMode
      }));
      const maximumMass = Math.max(1, ...shelves.map((shelf) => shelf.remainingMass));
      for (const shelf of shelves) {
        if (!(shelf.remainingMass > 0)) continue;
        const x1 = transform.xForTimestampMs(shelf.createdAt);
        const x2 = transform.xForTimestampMs(snapshot.header.endTime);
        if (x2 < 0 || x1 > transform.width) continue;
        const y = transform.yForPrice(shelf.liquidationMean);
        if (y < transform.top || y > transform.bottom) continue;
        const color = shelf.side === "LONG" ? 0xc8102e : 0xe7eaee;
        const strength = Math.sqrt(shelf.remainingMass / maximumMass);
        this.overlay.moveTo(Math.max(0, x1), y).lineTo(Math.min(transform.width, x2), y)
          .stroke({ color, alpha: 0.28 + strength * 0.62, width: 0.75 + strength * 1.25 });
        for (const boundary of [shelf.liquidationLower, shelf.liquidationUpper]) {
          const boundaryY = transform.yForPrice(boundary);
          if (boundaryY < transform.top || boundaryY > transform.bottom) continue;
          this.overlay.moveTo(Math.max(0, x1), boundaryY).lineTo(Math.min(transform.width, x2), boundaryY)
            .stroke({ color, alpha: 0.08 + strength * 0.14, width: 0.5 });
        }
      }
    }

    const focusPercent = settings.focusBand === "PERCENT_2" ? 2
      : settings.focusBand === "PERCENT_5" ? 5
        : settings.focusBand === "PERCENT_10" ? 10
          : settings.focusBand === "CUSTOM" ? settings.customFocusBandPercent : 0;
    if (focusPercent > 0) {
      const focusTop = transform.yForPrice(transform.currentPrice * (1 + focusPercent / 100));
      const focusBottom = transform.yForPrice(transform.currentPrice * (1 - focusPercent / 100));
      this.overlay.rect(0, Math.min(focusTop, focusBottom), transform.width, Math.abs(focusBottom - focusTop))
        .fill({ color: 0x8390a3, alpha: 0.018 })
        .stroke({ color: 0xc6ccd5, alpha: 0.075, width: 1 });
    }

    if (settings.collectionStartMarkerVisible && projection.liveCalibrationStartTime !== null) {
      const sourceStartX = transform.xForTimestampMs(projection.liveCalibrationStartTime);
      if (sourceStartX >= 0 && sourceStartX <= transform.width) {
        this.overlay.moveTo(sourceStartX, transform.top).lineTo(sourceStartX, transform.bottom)
          .stroke({ color: 0xaab2be, alpha: 0.24, width: 1 });
      }
    }

    if (settings.cohortBirthMarkersVisible) {
      for (const cohort of snapshot.cohorts) {
        const x = transform.xForTimestampMs(cohort.createdAt);
        const y = transform.yForPrice(cohort.liquidationMean);
        if (x < 0 || x > transform.width || y < transform.top || y > transform.bottom) continue;
        const color = cohort.side === "LONG" ? 0xd00024 : 0xe2e5e9;
        this.overlay.moveTo(x, Math.max(transform.top, y - 8)).lineTo(x, Math.min(transform.bottom, y + 8))
          .stroke({ color, alpha: 0.42, width: 1 });
        this.overlay.circle(x, y, 1.8).fill({ color, alpha: 0.78 });
      }
    }

    if (settings.uncertaintyEnvelopesVisible) {
      for (const cluster of extractBclifOperationalClusters(snapshot, transform.currentPrice, settings).slice(0, 12)) {
        const yTop = transform.yForPrice(cluster.priceHigh);
        const yBottom = transform.yForPrice(cluster.priceLow);
        this.overlay.rect(0, Math.min(yTop, yBottom), transform.width, Math.abs(yBottom - yTop))
          .stroke({ color: cluster.side === "LONG_LIQUIDATION" ? 0xb20b2a : 0xcbd1d9, alpha: 0.11, width: 1 });
      }
    }

    if (settings.confirmedMarkersVisible) {
      for (const event of snapshot.confirmedEvents) {
        const x = transform.xForTimestampMs(event.timestamp);
        const y = transform.yForPrice(event.bankruptcyPrice);
        if (x < 0 || x > transform.width || y < transform.top || y > transform.bottom) continue;
        const color = event.liquidatedPositionSide === "LONG" ? 0xff1738 : 0xf4f2f3;
        this.overlay.circle(x, y, 2.3).fill({ color, alpha: 0.92 }).circle(x, y, 5.5).stroke({ color, alpha: 0.42, width: 1 });
      }
    }

    if (settings.cascadePathsVisible) {
      for (const risk of snapshot.cascade) {
        const center = (risk.triggerRange[0] + risk.triggerRange[1]) / 2;
        const y = transform.yForPrice(center);
        const color = risk.direction === "DOWN" ? 0xff1738 : 0xf4f2f3;
        this.overlay.moveTo(Math.max(0, right - 110), y).lineTo(Math.min(transform.width, right), y).stroke({
          color,
          width: 1 + risk.cascadeProbability * 2,
          alpha: 0.18 + risk.cascadeProbability * 0.52
        });
      }
    }
  }

  private rebuildTexture() {
    const startedAt = typeof performance === "undefined" ? 0 : performance.now();
    const projection = this.projection;
    const settings = this.settings;
    if (!projection || !settings) {
      if (this.sprite) this.sprite.visible = false;
      return;
    }
    const { columns, rows } = projection;
    let rgba: Uint8Array;
    try {
      validateBclifProjection(projection);
      rgba = projection.rgba ?? buildBclifDisplayTexture(projection, settings, this.rgba);
      if (rgba.length !== columns * rows * 4) throw new Error("BCLIF_RGBA_BUFFER_LENGTH_INVALID");
      this.bufferValid = true;
    } catch (error) {
      this.bufferValid = false;
      this.currentTextureUploaded = false;
      this.lastError = error instanceof Error ? error.message : "BCLIF_TEXTURE_VALIDATION_FAILED";
      if (this.sprite) this.sprite.visible = false;
      this.emitMetrics();
      return;
    }
    this.rgba = rgba;

    const dimensionsChanged = !this.source || this.source.width !== columns || this.source.height !== rows;
    if (dimensionsChanged) {
      if (this.sprite) this.container.removeChild(this.sprite);
      this.texture?.destroy(true);
      this.source = new BufferImageSource({ resource: rgba, width: columns, height: rows, format: "rgba8unorm" });
      this.source.style.scaleMode = "linear";
      this.texture = new Texture({ source: this.source });
      this.sprite = new Sprite(this.texture);
      this.container.addChildAt(this.sprite, 1);
    } else if (this.source) {
      this.source.resource = rgba;
      this.source.update();
    }
    this.textureUploadCount += 1;
    this.currentTextureUploaded = true;
    this.textureUploadTimestamp = Date.now();
    this.textureUploadDurationMs = typeof performance === "undefined" ? null : performance.now() - startedAt;
    this.texturePreparationAndUpdateMs = this.textureUploadDurationMs === null
      ? null : Number(this.textureUploadDurationMs.toFixed(3));
    this.latestRenderedGeneration = this.snapshot?.generations?.modelGeneration ?? this.projectionGeneration;
    this.lastError = null;
    if (typeof globalThis !== "undefined") {
      const instrumentation = globalThis as typeof globalThis & {
        __BCLIF_RENDER_METRICS__?: Record<string, unknown>;
        __BCLIF_RAW_EXPOSURE_EXPORT__?: () => ReturnType<typeof buildBclifRawExposureExport> | null;
      };
      instrumentation.__BCLIF_RENDER_METRICS__ = {
        ...this.metrics(),
        texturePreparationAndUpdateMs: this.texturePreparationAndUpdateMs,
        recordedAt: Date.now()
      };
      instrumentation.__BCLIF_RAW_EXPOSURE_EXPORT__ = () => this.snapshot
        ? buildBclifRawExposureExport(this.snapshot)
        : null;
    }
  }

  private requestProjection(
    key: string,
    snapshot: LiquidationFieldSnapshot,
    settings: LiquidationFieldSettings,
    context: Parameters<typeof buildBclifDisplayProjection>[2]
  ) {
    if (!this.projectionWorker || this.pendingProjectionKey === key) return;
    this.pendingProjectionKey = key;
    const generation = ++this.projectionGeneration;
    this.projectionWorker.postMessage({ generation, key, snapshot, settings, context });
  }

  metrics() {
    const latestModelGeneration = this.snapshot?.generations?.modelGeneration ?? 0;
    const maximumAlpha = this.projection?.maximumAlpha ?? 0;
    const readiness = this.resolveReadiness(maximumAlpha);
    return {
      readiness,
      webglContextReady: this.webglContextReady,
      textureAllocated: Boolean(this.texture),
      bufferValid: this.bufferValid,
      snapshotApplied: Boolean(this.snapshot),
      textureUploaded: this.currentTextureUploaded,
      drawPassActive: this.drawPassActive,
      textureUploadCount: this.textureUploadCount,
      rendererAttachmentTimestamp: this.rendererAttachmentTimestamp,
      textureUploadTimestamp: this.textureUploadTimestamp,
      textureUploadDurationMs: this.textureUploadDurationMs,
      texturePreparationAndUpdateMs: this.texturePreparationAndUpdateMs,
      latestModelGeneration,
      latestRenderedGeneration: this.latestRenderedGeneration,
      generationLag: Math.max(0, latestModelGeneration - this.latestRenderedGeneration),
      rawNonZeroCells: this.projection?.rawNonZeroCells ?? 0,
      validCells: this.projection?.validCells ?? 0,
      visibleCells: this.projection?.visibleCells ?? 0,
      filteredCells: this.projection?.filteredCells ?? 0,
      nonZeroTexels: this.projection?.visibleCells ?? 0,
      minimumAlpha: this.projection?.minimumVisibleAlpha ?? 0,
      maximumAlpha,
      textureDimensions: this.projection ? `${this.projection.columns}x${this.projection.rows}` : null,
      error: this.lastError,
      textures: this.texture ? 1 : 0,
      cells: this.projection ? this.projection.columns * this.projection.rows : 0,
      authority: this.snapshot?.authority ?? null,
      checksum: this.snapshot?.header.checksum ?? null,
      bounds: this.projection && this.snapshot ? {
        startTime: this.snapshot.header.startTime,
        endTime: this.snapshot.header.endTime,
        minPrice: this.projection.minPrice,
        maxPrice: this.projection.maxPrice
      } : null,
      displayPriceStep: this.projection?.priceStep ?? null,
      displayTimeStepMs: this.projection?.timeStepMs ?? null,
      modelHash: this.projection?.modelHash ?? null,
      exposureHash: this.projection?.exposureHash ?? null,
      renderSettingsHash: this.projection?.renderSettingsHash ?? null,
      displayRasterHash: this.projection?.displayRasterHash ?? null,
      yellowEligibleCells: this.projection?.yellowEligibleCells ?? 0
    };
  }

  handleContextLost() {
    this.webglContextReady = false;
    this.drawPassActive = false;
    this.currentTextureUploaded = false;
    this.lastError = "WEBGL_CONTEXT_LOST";
    if (this.sprite) this.sprite.visible = false;
    this.emitMetrics();
  }

  handleContextRestored() {
    this.webglContextReady = true;
    this.lastError = null;
    this.textureKey = "";
    this.projectionGeneration += 1;
    this.rebuildTexture();
    this.emitMetrics();
  }

  private emitMetrics() {
    const metrics = this.metrics();
    this.onProjectionReady?.(metrics);
    if (typeof globalThis !== "undefined") {
      const target = globalThis as typeof globalThis & { __BCLIF_RENDER_METRICS__?: BclifRendererMetrics };
      target.__BCLIF_RENDER_METRICS__ = metrics;
    }
  }

  private resolveReadiness(maximumAlpha: number): BclifRendererReadiness {
    if (this.lastError) return "TEXTURE_ERROR";
    if (!this.webglContextReady || !this.projection) return "RENDERER_INITIALIZING";
    if (this.projection.rawNonZeroCells > 0 && this.projection.visibleCells === 0) return "FILTERED_EMPTY";
    if (maximumAlpha === 0) return "INVISIBLE_TEXTURE";
    return "WEBGL_CONTEXT_READY";
  }

  dispose() {
    this.projectionGeneration += 1;
    this.projectionWorker?.terminate();
    this.projectionWorker = null;
    this.texture?.destroy(true);
    this.texture = null;
    this.source = null;
    this.sprite = null;
    this.rgba = null;
    this.projection = null;
    this.container.destroy({ children: true });
  }
}
