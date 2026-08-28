import { Container, Graphics } from "pixi.js";
import type { Candle } from "../../../chart-engine/types";
import { HorizonWaveEngine } from "../core/HorizonWaveEngine";
import type { HorizonCandleMode, HorizonCrosshairSample, HorizonWaveProjection } from "../core/types";

const SILVER = 0xe9e7e8;
const SILVER_BRIGHT = 0xffffff;
const BLOOD = 0xb30824;
const BLOOD_BRIGHT = 0xef193a;
const GRAPHITE = 0x777277;
const PANEL = 0x080808;

type HorizonRenderContext = {
  candles: readonly Candle[];
  firstIndex: number;
  lastIndex: number;
  pixelsPerCandle: number;
  plotTop: number;
  plotBottom: number;
  xForIndex: (index: number) => number;
  yForPrice: (price: number) => number;
  settings: HorizonCandleMode;
};

function pressureColor(score: number) {
  if (score > 0.075) return SILVER;
  if (score < -0.075) return BLOOD;
  return GRAPHITE;
}

function pressureAlpha(score: number, base: number, gain: number) {
  return Math.min(0.98, base + Math.abs(score) * gain);
}

export class HorizonEnvelopeLayer {
  readonly graphics = new Graphics();

  draw(projection: HorizonWaveProjection, context: HorizonRenderContext) {
    const g = this.graphics;
    g.clear();
    if (!context.settings.showWaveEnvelope || projection.buckets.length < 2) return;

    const polygon: number[] = [];
    for (const bucket of projection.buckets) {
      polygon.push(context.xForIndex(bucket.centerIndex), context.yForPrice(bucket.upperEnvelope));
    }
    for (let index = projection.buckets.length - 1; index >= 0; index--) {
      const bucket = projection.buckets[index]!;
      polygon.push(context.xForIndex(bucket.centerIndex), context.yForPrice(bucket.lowerEnvelope));
    }
    if (polygon.length >= 6) {
      g.poly(polygon).fill({ color: PANEL, alpha: projection.lod === "wave" ? 0.62 : 0.34 });
    }

    for (let index = 1; index < projection.buckets.length; index++) {
      const previous = projection.buckets[index - 1]!;
      const current = projection.buckets[index]!;
      const score = (previous.directionScore + current.directionScore) / 2;
      const color = pressureColor(score);
      const alpha = pressureAlpha(score, 0.18, 0.34);
      const x0 = context.xForIndex(previous.centerIndex);
      const x1 = context.xForIndex(current.centerIndex);
      g.moveTo(x0, context.yForPrice(previous.upperEnvelope))
        .lineTo(x1, context.yForPrice(current.upperEnvelope))
        .stroke({ width: projection.lod === "wave" ? 1.35 : 0.8, color, alpha });
      g.moveTo(x0, context.yForPrice(previous.lowerEnvelope))
        .lineTo(x1, context.yForPrice(current.lowerEnvelope))
        .stroke({ width: projection.lod === "wave" ? 1.35 : 0.8, color, alpha: alpha * 0.78 });
    }
  }

  clear() { this.graphics.clear(); }
}

export class HorizonPressureLayer {
  readonly graphics = new Graphics();

  draw(projection: HorizonWaveProjection, context: HorizonRenderContext) {
    const g = this.graphics;
    g.clear();
    if (!context.settings.showDirectionalPressure || projection.buckets.length === 0) return;

    for (let index = 1; index < projection.buckets.length; index++) {
      const previous = projection.buckets[index - 1]!;
      const bucket = projection.buckets[index]!;
      const color = pressureColor(bucket.directionScore);
      const alpha = pressureAlpha(bucket.directionScore, 0.16, 0.56);
      const x0 = context.xForIndex(previous.centerIndex);
      const x1 = context.xForIndex(bucket.centerIndex);
      const y0 = context.yForPrice(previous.centerline);
      const y1 = context.yForPrice(bucket.centerline);
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({
        width: projection.lod === "wave" ? 2.2 : projection.lod === "clusters" ? 1.45 : 1,
        color,
        alpha
      });

      if (projection.lod !== "candles") {
        const pressureHeight = Math.max(1, Math.abs(context.yForPrice(bucket.close) - y1));
        const width = Math.max(0.6, Math.min(5, (x1 - x0) * 0.72));
        g.rect(x1 - width / 2, Math.min(y1, context.yForPrice(bucket.close)), width, pressureHeight)
          .fill({ color, alpha: alpha * 0.2 });
      }
    }
  }

  clear() { this.graphics.clear(); }
}

export class HorizonRejectionHeatLayer {
  readonly graphics = new Graphics();

  draw(projection: HorizonWaveProjection, context: HorizonRenderContext) {
    const g = this.graphics;
    g.clear();
    if (!context.settings.showRejectionHeat) return;

    for (const bucket of projection.buckets) {
      const x = context.xForIndex(bucket.centerIndex);
      if (bucket.upperRejection > 0.12) {
        const top = context.yForPrice(bucket.high);
        const body = context.yForPrice(Math.max(bucket.open, bucket.close));
        g.moveTo(x, top).lineTo(x, body).stroke({
          width: projection.lod === "wave" ? 1.8 : 1.1,
          color: BLOOD_BRIGHT,
          alpha: Math.min(0.72, bucket.upperRejection * 0.64)
        });
      }
      if (bucket.lowerRejection > 0.12) {
        const body = context.yForPrice(Math.min(bucket.open, bucket.close));
        const bottom = context.yForPrice(bucket.low);
        g.moveTo(x, body).lineTo(x, bottom).stroke({
          width: projection.lod === "wave" ? 1.8 : 1.1,
          color: SILVER_BRIGHT,
          alpha: Math.min(0.62, bucket.lowerRejection * 0.58)
        });
      }
    }
  }

  clear() { this.graphics.clear(); }
}

export class HorizonMicroCandleLayer {
  readonly graphics = new Graphics();

  draw(projection: HorizonWaveProjection, context: HorizonRenderContext) {
    const g = this.graphics;
    g.clear();
    if (!context.settings.showMicroCandles || projection.lod === "wave") return;

    const inferredStep = projection.buckets.length > 1
      ? Math.abs(context.xForIndex(projection.buckets[1]!.centerIndex) - context.xForIndex(projection.buckets[0]!.centerIndex))
      : Math.max(1, context.pixelsPerCandle * projection.bucketSize);
    const bodyWidth = Math.max(0.55, Math.min(7, inferredStep * 0.64));

    for (const bucket of projection.buckets) {
      const x = context.xForIndex(bucket.centerIndex);
      const openY = context.yForPrice(bucket.open);
      const closeY = context.yForPrice(bucket.close);
      const highY = context.yForPrice(bucket.high);
      const lowY = context.yForPrice(bucket.low);
      const score = bucket.directionScore;
      const bullish = score > 0.075 || (Math.abs(score) <= 0.075 && bucket.close >= bucket.open);
      const bearish = score < -0.075 || (Math.abs(score) <= 0.075 && bucket.close < bucket.open);
      const color = bullish ? SILVER : bearish ? BLOOD : GRAPHITE;
      const wick = bullish ? SILVER_BRIGHT : bearish ? BLOOD_BRIGHT : GRAPHITE;
      const alpha = pressureAlpha(score, projection.lod === "candles" ? 0.62 : 0.42, 0.45);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(openY - closeY));
      g.moveTo(x, highY).lineTo(x, lowY).stroke({ width: Math.max(0.45, Math.min(1.1, bodyWidth * 0.22)), color: wick, alpha: alpha * 0.78 });
      if (bullish) {
        g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight)
          .fill({ color, alpha: 0.055 })
          .stroke({ width: Math.max(0.45, Math.min(1, bodyWidth * 0.2)), color, alpha });
      } else {
        g.rect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight).fill({ color, alpha });
      }
    }
  }

  clear() { this.graphics.clear(); }
}

export class HorizonCrosshairLayer {
  resolve(engine: HorizonWaveEngine, candles: readonly Candle[], projection: HorizonWaveProjection | null, index: number): HorizonCrosshairSample | null {
    return engine.sourceAt(candles, projection, index);
  }
}

export class HorizonCandleRenderer {
  readonly container = new Container();
  readonly envelope = new HorizonEnvelopeLayer();
  readonly pressure = new HorizonPressureLayer();
  readonly rejection = new HorizonRejectionHeatLayer();
  readonly microCandles = new HorizonMicroCandleLayer();
  readonly crosshair = new HorizonCrosshairLayer();
  private projection: HorizonWaveProjection | null = null;

  constructor(private readonly engine: HorizonWaveEngine) {
    this.container.addChild(
      this.envelope.graphics,
      this.pressure.graphics,
      this.rejection.graphics,
      this.microCandles.graphics
    );
  }

  draw(context: HorizonRenderContext) {
    this.projection = this.engine.project(
      context.candles,
      context.firstIndex,
      context.lastIndex,
      context.pixelsPerCandle,
      context.settings
    );
    this.envelope.draw(this.projection, context);
    this.pressure.draw(this.projection, context);
    this.rejection.draw(this.projection, context);
    this.microCandles.draw(this.projection, context);
    return this.projection;
  }

  currentProjection() { return this.projection; }

  clear() {
    this.projection = null;
    this.envelope.clear();
    this.pressure.clear();
    this.rejection.clear();
    this.microCandles.clear();
  }

  dispose() {
    this.clear();
    this.container.destroy({ children: true });
  }
}
