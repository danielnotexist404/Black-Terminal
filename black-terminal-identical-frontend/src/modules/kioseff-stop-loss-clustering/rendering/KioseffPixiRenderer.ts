import { Container, Graphics, Text } from "pixi.js";
import type { KioseffSnapshot } from "../core/canonical.ts";
import type { KioseffSettingsV1 } from "../core/settings.ts";
import {
  buildKioseffRenderModel,
  layoutKioseffLabels,
  type KioseffRenderZone
} from "./renderModel.ts";

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
  private lastRenderMetrics = {
    activeZones: 0,
    violatedZones: 0,
    panePoints: 0,
    geometryCommandCount: 0
  };

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
    violated: boolean,
    settings: KioseffSettingsV1
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
    if (!zone.drawAsLine) {
      this.zoneGeometry
        .rect(left, y, right - left, height)
        .fill({ color, alpha })
        .stroke({
          color,
          width: Math.max(0.5, settings.style.activeLineWidth),
          alpha
        });
    }
    const middle = transform.yForPrice(zone.price);
    if (zone.drawAsLine || zone.hot) {
      this.lineGeometry
        .moveTo(left, middle)
        .lineTo(right, middle)
        .stroke({
          color,
          width: Math.max(0.5, settings.style.activeLineWidth),
          alpha: zone.hot ? 1 : alpha
        });
    }
    if (zone.hot) {
      this.lineGeometry
        .moveTo(left, middle)
        .lineTo(right, middle)
        .stroke({ color, width: settings.style.hotLineWidth, alpha: 0.1 });
    }
  }

  private drawLabels(
    zones: readonly KioseffRenderZone[],
    transform: KioseffRenderTransform,
    settings: KioseffSettingsV1
  ) {
    const labels = layoutKioseffLabels(
      zones,
      transform.yForPrice,
      transform.top + settings.style.labelFontSize / 2,
      transform.height - settings.style.labelFontSize / 2,
      settings.style.labelFontSize
    );
    for (const { zone, y } of labels) {
      const text = this.acquireText();
      text.text = zone.labelText!;
      text.style.fill = colorNumber(zone.labelColor);
      text.style.fontSize = settings.style.labelFontSize;
      text.anchor.set(1, 0.5);
      text.x = Math.max(2, transform.width - 6);
      text.y = Math.round(y * 2) / 2;
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
    transform: KioseffRenderTransform,
    settings: KioseffSettingsV1
  ) {
    if (!pane.length) return;
    const buyColor = colorNumber(settings.style.oscillatorBuyColor);
    const sellColor = colorNumber(settings.style.oscillatorSellColor);
    const visible = pane.filter((point) => {
      const x = transform.xForTime(point.time);
      return x >= -4 && x <= transform.width + 4;
    });
    if (!visible.length) return;
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
          color: buyColor,
          alpha: point.radiateBuy ? 0.95 : 0.5
        });
        if (point.radiateBuy) {
          this.paneGeometry.circle(x, y, 8).stroke({ color: buyColor, width: 2, alpha: 0.18 });
        }
      }
      if (point.sellStopsHit !== null) {
        const y = yForValue(point.sellStopsHit);
        this.paneGeometry.circle(x, y, point.radiateSell ? 4 : 2).fill({
          color: sellColor,
          alpha: point.radiateSell ? 0.95 : 0.5
        });
        if (point.radiateSell) {
          this.paneGeometry.circle(x, y, 8).stroke({ color: sellColor, width: 2, alpha: 0.18 });
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
          .stroke({ color: buyColor, width: 1, alpha: 0.76 });
      }
      if (previous.sellAverage !== null && current.sellAverage !== null) {
        this.paneGeometry
          .moveTo(transform.xForTime(previous.time), yForValue(previous.sellAverage))
          .lineTo(transform.xForTime(current.time), yForValue(current.sellAverage))
          .stroke({ color: sellColor, width: 1, alpha: 0.76 });
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
      this.lastRenderMetrics = {
        activeZones: 0,
        violatedZones: 0,
        panePoints: 0,
        geometryCommandCount: 0
      };
      for (const text of this.textPool) text.visible = false;
      return;
    }
    const model = buildKioseffRenderModel(snapshot, settings);
    this.lastRenderMetrics = {
      activeZones: model.activeZones.length,
      violatedZones: model.violatedZones.length,
      panePoints: model.pane.length,
      geometryCommandCount: model.geometryCommandCount
    };
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
    for (const zone of model.activeZones) this.drawZone(zone, transform, false, settings);
    for (const zone of model.violatedZones) this.drawZone(zone, transform, true, settings);
    this.drawLabels([...model.activeZones, ...model.violatedZones], transform, settings);
    this.drawCurves(model.curves, transform);
    this.drawPane(model.pane, transform, settings);
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
      visibleTextObjects: this.usedTexts,
      containerVisible: this.container.visible,
      ...this.lastRenderMetrics
    };
  }
}
