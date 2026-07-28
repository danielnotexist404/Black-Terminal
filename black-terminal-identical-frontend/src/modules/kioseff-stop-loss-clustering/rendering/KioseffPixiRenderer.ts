import { Container, Graphics, Text } from "pixi.js";
import type { KioseffSnapshot } from "../core/canonical.ts";
import type { KioseffSettingsV1 } from "../core/settings.ts";
import { buildKioseffRenderModel, type KioseffRenderZone } from "./renderModel.ts";

export type KioseffRenderTransform = {
  width: number;
  height: number;
  top: number;
  xForTime(time: number): number;
  yForPrice(price: number): number;
};

function colorNumber(color: string) {
  const normalized = color.trim().replace(/^#/, "");
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : 0xffffff;
}

function compactVolume(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export class KioseffPixiRenderer {
  readonly container = new Container();
  private clip = new Graphics();
  private xRay = new Graphics();
  private zoneGeometry = new Graphics();
  private curveGeometry = new Graphics();
  private lineGeometry = new Graphics();
  private paneGeometry = new Graphics();
  private textLayer = new Container();
  private textPool: Text[] = [];
  private usedTexts = 0;

  constructor() {
    this.container.addChild(
      this.clip,
      this.xRay,
      this.zoneGeometry,
      this.curveGeometry,
      this.lineGeometry,
      this.paneGeometry,
      this.textLayer
    );
    this.container.mask = this.clip;
  }

  private acquireText() {
    let text = this.textPool[this.usedTexts];
    if (!text) {
      text = new Text({
        text: "",
        style: {
          fontFamily: "IBM Plex Mono",
          fontSize: 9,
          fill: 0xffffff,
          fontWeight: "700"
        }
      });
      this.textPool.push(text);
      this.textLayer.addChild(text);
    }
    text.visible = true;
    this.usedTexts += 1;
    return text;
  }

  private drawZone(
    zone: KioseffRenderZone,
    transform: KioseffRenderTransform,
    violated: boolean
  ) {
    const start = transform.xForTime(zone.startTime ?? zone.creationTime);
    const end =
      violated && zone.endTime !== null
        ? transform.xForTime(zone.endTime)
        : transform.width;
    const left = Math.max(0, Math.min(start, end));
    const right = Math.min(transform.width, Math.max(start, end));
    if (right <= left) return;
    const top = transform.yForPrice(zone.priceHigh);
    const bottom = transform.yForPrice(zone.priceLow);
    const y = Math.min(top, bottom);
    const height = Math.max(1, Math.abs(bottom - top));
    if (y + height < transform.top || y > transform.height) return;
    const color = colorNumber(zone.color);
    const strengthAlpha = zone.strength === "strong" ? 0.2 : 0.09;
    const alpha = zone.opacity ?? strengthAlpha;
    this.zoneGeometry.rect(left, y, right - left, height).fill({
      color,
      alpha: violated ? alpha * 0.62 : alpha
    });
    const middle = transform.yForPrice(zone.price);
    this.lineGeometry
      .moveTo(left, middle)
      .lineTo(right, middle)
      .stroke({ color, width: zone.hot ? 1.5 : 0.75, alpha: zone.hot ? 0.92 : 0.55 });
    if (zone.hot) {
      this.lineGeometry
        .moveTo(left, middle)
        .lineTo(right, middle)
        .stroke({ color, width: 5, alpha: 0.13 });
      this.lineGeometry
        .moveTo(left, middle)
        .lineTo(right, middle)
        .stroke({ color, width: 10, alpha: 0.06 });
    }
    if (zone.showLabel && this.usedTexts < 120) {
      const text = this.acquireText();
      text.text = compactVolume(zone.signedVolume);
      text.style.fill = color;
      text.x = Math.max(2, Math.min(transform.width - text.width - 4, violated ? left : right - 58));
      text.y = middle - 6;
    }
  }

  private drawCurves(
    curves: ReturnType<typeof buildKioseffRenderModel>["curves"],
    transform: KioseffRenderTransform
  ) {
    for (const curve of curves) {
      const color = curve.side === "buy-stop" ? 0x55ffda : 0xff65fb;
      for (let index = 1; index < curve.points.length; index += 1) {
        if (index % 2 === 0) continue;
        const previous = curve.points[index - 1]!;
        const current = curve.points[index]!;
        this.curveGeometry
          .moveTo(transform.xForTime(previous.time), transform.yForPrice(previous.price))
          .lineTo(transform.xForTime(current.time), transform.yForPrice(current.price))
          .stroke({ color, width: 1, alpha: 0.72 });
      }
    }
  }

  private drawPane(
    pane: ReturnType<typeof buildKioseffRenderModel>["pane"],
    transform: KioseffRenderTransform
  ) {
    if (!pane.length) return;
    const visible = pane.slice(-300);
    const paneTop = transform.height * 0.82;
    const paneBottom = transform.height - 4;
    const zero = (paneTop + paneBottom) / 2;
    const values = visible.flatMap((point) =>
      [point.buyStopsHit, point.sellStopsHit, point.buyAverage, point.sellAverage].filter(
        (value): value is number => value !== null
      )
    );
    const maximum = Math.max(1, ...values.map(Math.abs));
    this.paneGeometry
      .rect(0, paneTop, transform.width, paneBottom - paneTop)
      .fill({ color: 0x05070b, alpha: 0.58 });
    this.paneGeometry
      .moveTo(0, zero)
      .lineTo(transform.width, zero)
      .stroke({ color: 0xffffff, width: 1, alpha: 0.18 });
    const yForValue = (value: number) =>
      zero - (value / maximum) * ((paneBottom - paneTop) * 0.43);
    for (const point of visible) {
      const x = transform.xForTime(point.time);
      if (point.buyStopsHit !== null) {
        const y = yForValue(point.buyStopsHit);
        this.paneGeometry.circle(x, y, point.radiateBuy ? 4 : 2).fill({
          color: 0x55ffda,
          alpha: point.radiateBuy ? 0.95 : 0.5
        });
        if (point.radiateBuy) {
          this.paneGeometry.circle(x, y, 8).stroke({ color: 0x55ffda, width: 2, alpha: 0.18 });
        }
      }
      if (point.sellStopsHit !== null) {
        const y = yForValue(point.sellStopsHit);
        this.paneGeometry.circle(x, y, point.radiateSell ? 4 : 2).fill({
          color: 0xff65fb,
          alpha: point.radiateSell ? 0.95 : 0.5
        });
        if (point.radiateSell) {
          this.paneGeometry.circle(x, y, 8).stroke({ color: 0xff65fb, width: 2, alpha: 0.18 });
        }
      }
    }
    for (let index = 1; index < visible.length; index += 1) {
      const previous = visible[index - 1]!;
      const current = visible[index]!;
      if (previous.buyAverage !== null && current.buyAverage !== null) {
        this.paneGeometry
          .moveTo(transform.xForTime(previous.time), yForValue(previous.buyAverage))
          .lineTo(transform.xForTime(current.time), yForValue(current.buyAverage))
          .stroke({ color: 0x55ffda, width: 1, alpha: 0.76 });
      }
      if (previous.sellAverage !== null && current.sellAverage !== null) {
        this.paneGeometry
          .moveTo(transform.xForTime(previous.time), yForValue(previous.sellAverage))
          .lineTo(transform.xForTime(current.time), yForValue(current.sellAverage))
          .stroke({ color: 0xff65fb, width: 1, alpha: 0.76 });
      }
    }
  }

  draw(
    snapshot: KioseffSnapshot | null,
    settings: KioseffSettingsV1,
    transform: KioseffRenderTransform
  ) {
    this.clip.clear().rect(0, transform.top, transform.width, transform.height - transform.top).fill(0xffffff);
    this.xRay.clear();
    this.zoneGeometry.clear();
    this.curveGeometry.clear();
    this.lineGeometry.clear();
    this.paneGeometry.clear();
    this.usedTexts = 0;
    if (!snapshot) {
      for (const text of this.textPool) text.visible = false;
      return;
    }
    const model = buildKioseffRenderModel(snapshot, settings);
    if (model.xRay) {
      const top = transform.yForPrice(model.xRay.priceHigh);
      const bottom = transform.yForPrice(model.xRay.priceLow);
      const y = Math.min(top, bottom);
      const height = Math.abs(bottom - top);
      for (let index = 0; index < 50; index += 1) {
        const midpointDistance = Math.abs(index - 24.5) / 24.5;
        this.xRay
          .rect(0, y + (height * index) / 50, transform.width, height / 50 + 0.5)
          .fill({
            color: index < 25 ? 0xff22cc : 0x6929f2,
            alpha: 0.07 + (1 - midpointDistance) * 0.05
          });
      }
    }
    for (const zone of model.activeZones) this.drawZone(zone, transform, false);
    for (const zone of model.violatedZones) this.drawZone(zone, transform, true);
    this.drawCurves(model.curves, transform);
    this.drawPane(model.pane, transform);
    for (let index = this.usedTexts; index < this.textPool.length; index += 1) {
      this.textPool[index]!.visible = false;
    }
  }

  dispose() {
    this.container.mask = null;
    this.container.destroy({ children: true });
    this.textPool = [];
  }

  metrics() {
    return {
      graphics: 6,
      containers: 2,
      textObjects: this.textPool.length,
      visibleTextObjects: this.usedTexts
    };
  }
}
