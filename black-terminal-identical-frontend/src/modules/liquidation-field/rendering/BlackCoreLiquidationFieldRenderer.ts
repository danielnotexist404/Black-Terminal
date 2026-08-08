import { BufferImageSource, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { extractBclifOperationalClusters } from "../core/operationalClusters.ts";
import {
  bclifRenderSettingsHash,
  buildBclifDisplayProjection,
  type BclifDisplayProjection
} from "./displayProjection.ts";
import { buildBclifDisplayTexture } from "./displayTexture.ts";

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

  constructor(private readonly onProjectionReady?: () => void) {
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
        this.onProjectionReady?.();
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
    }
    if (!snapshot && this.sprite) this.sprite.visible = false;
  }

  draw(transform: LiquidationFieldRenderTransform) {
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
    sprite.visible = right >= 0 && left <= transform.width && bottom >= transform.top && top <= transform.bottom;

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
    const rgba = projection.rgba ?? buildBclifDisplayTexture(projection, settings, this.rgba);
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
    if (typeof globalThis !== "undefined") {
      const instrumentation = globalThis as typeof globalThis & {
        __BCLIF_RENDER_METRICS__?: Record<string, unknown>;
      };
      instrumentation.__BCLIF_RENDER_METRICS__ = {
        ...this.metrics(),
        texturePreparationAndUpdateMs: typeof performance === "undefined"
          ? null
          : Number((performance.now() - startedAt).toFixed(3)),
        recordedAt: Date.now()
      };
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
    return {
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
