import { BufferImageSource, Container, Graphics, Sprite, Texture } from "pixi.js";
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { createThermalPalette } from "./thermalPalette.ts";

export interface LiquidationFieldRenderTransform {
  width: number;
  height: number;
  top: number;
  bottom: number;
  xForTime(time: number): number;
  yForPrice(price: number): number;
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function exposureIntensity(value: number, scale: number, gamma: number) {
  const normalized = Math.log1p(Math.max(0, value)) / Math.max(1e-9, Math.log1p(Math.max(1, scale)));
  return clampByte(255 * Math.pow(Math.max(0, Math.min(1, normalized)), Math.max(0.2, gamma)));
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
  private textureKey = "";
  private rgba: Uint8Array | null = null;

  constructor() {
    this.container.addChild(this.clip, this.overlay);
    this.container.mask = this.clip;
  }

  setState(snapshot: LiquidationFieldSnapshot | null, settings: LiquidationFieldSettings) {
    this.snapshot = snapshot;
    this.settings = settings;
    const nextKey = snapshot
      ? [snapshot.header.checksum, snapshot.generatedAt, settings.viewMode, settings.palette, settings.opacity,
          settings.gamma, settings.minimumConfidence, settings.sideFilter].join(":")
      : "empty";
    if (nextKey === this.textureKey) return;
    this.textureKey = nextKey;
    this.rebuildTexture();
  }

  draw(transform: LiquidationFieldRenderTransform) {
    this.clip.clear().rect(0, transform.top, transform.width, Math.max(0, transform.bottom - transform.top)).fill(0xffffff);
    this.overlay.clear();
    const snapshot = this.snapshot;
    const settings = this.settings;
    const sprite = this.sprite;
    if (!snapshot || !settings || !sprite) return;

    const left = transform.xForTime(snapshot.header.startTime);
    const right = transform.xForTime(snapshot.header.endTime);
    const top = transform.yForPrice(snapshot.header.maxPrice);
    const bottom = transform.yForPrice(snapshot.header.minPrice);
    sprite.x = Math.min(left, right);
    sprite.y = Math.min(top, bottom);
    sprite.width = Math.max(1, Math.abs(right - left));
    sprite.height = Math.max(1, Math.abs(bottom - top));
    sprite.alpha = Math.max(0, Math.min(1, settings.opacity / 100));
    sprite.visible = right >= 0 && left <= transform.width && bottom >= transform.top && top <= transform.bottom;

    if (settings.confirmedMarkersVisible) {
      for (const event of snapshot.confirmedEvents) {
        const x = transform.xForTime(event.timestamp);
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
    const snapshot = this.snapshot;
    const settings = this.settings;
    if (!snapshot || !settings) {
      if (this.sprite) this.sprite.visible = false;
      return;
    }
    const { columns, rows, exposureScale } = snapshot.header;
    const required = columns * rows * 4;
    const rgba = this.rgba?.length === required ? this.rgba : new Uint8Array(required);
    this.rgba = rgba;
    const lut = createThermalPalette(settings.palette);
    const longLut = createThermalPalette("BLACK_TERMINAL_BLOOD");
    const shortLut = createThermalPalette("INSTITUTIONAL_MONOCHROME");

    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const sourceIndex = column * rows + row;
        const targetIndex = ((rows - 1 - row) * columns + column) * 4;
        const valid = snapshot.validity[sourceIndex]! > 0;
        const confidence = snapshot.confidence[sourceIndex]!;
        const confidencePass = snapshot.certainty === "SYNTHETIC_TEST" || confidence >= settings.minimumConfidence * 2.55;
        let intensity = snapshot.normalizedIntensity[sourceIndex]!;
        let selectedLut = lut;

        if (settings.viewMode === "LONG_EXPOSURE") {
          intensity = exposureIntensity(snapshot.longExposure[sourceIndex]!, exposureScale, settings.gamma);
          selectedLut = longLut;
        } else if (settings.viewMode === "SHORT_EXPOSURE") {
          intensity = exposureIntensity(snapshot.shortExposure[sourceIndex]!, exposureScale, settings.gamma);
          selectedLut = shortLut;
        } else if (settings.viewMode === "CONFIDENCE_FIELD") {
          intensity = confidence;
        } else if (settings.viewMode === "CONFIRMED_LIQUIDATIONS") {
          intensity = snapshot.confirmedIntensity[sourceIndex]!;
        } else if (settings.viewMode === "DIRECTIONAL_SPLIT") {
          const long = snapshot.longExposure[sourceIndex]!;
          const short = snapshot.shortExposure[sourceIndex]!;
          intensity = exposureIntensity(Math.max(long, short), exposureScale, settings.gamma);
          selectedLut = long >= short ? longLut : shortLut;
        }

        // Unavailable intervals remain visibly distinct; they are never silently interpolated.
        if (!valid) {
          const hatch = ((column + row) % 9) < 2 ? 14 : 5;
          rgba[targetIndex] = hatch;
          rgba[targetIndex + 1] = 4;
          rgba[targetIndex + 2] = 18;
          rgba[targetIndex + 3] = 255;
          continue;
        }
        if (!confidencePass) intensity = Math.min(intensity, 22);
        const lutIndex = Math.max(0, Math.min(255, intensity)) * 4;
        rgba[targetIndex] = selectedLut[lutIndex]!;
        rgba[targetIndex + 1] = selectedLut[lutIndex + 1]!;
        rgba[targetIndex + 2] = selectedLut[lutIndex + 2]!;
        rgba[targetIndex + 3] = 255;
      }
    }

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
  }

  metrics() {
    return {
      textures: this.texture ? 1 : 0,
      cells: this.snapshot ? this.snapshot.header.columns * this.snapshot.header.rows : 0
    };
  }

  dispose() {
    this.texture?.destroy(true);
    this.texture = null;
    this.source = null;
    this.sprite = null;
    this.rgba = null;
    this.container.destroy({ children: true });
  }
}
