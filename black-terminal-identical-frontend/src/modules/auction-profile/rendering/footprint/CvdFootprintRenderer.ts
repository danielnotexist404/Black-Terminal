import { Container, Graphics, Text } from "pixi.js";
import type { AuctionBlockCell, AuctionProfileSettings, AuctionProfileSnapshot } from "../../core/types.ts";
import { auctionBrightnessAlpha } from "../heatmap.ts";
import { auctionCellRenderStrides, downsampleAuctionCells } from "../cells.ts";
import { auctionDirectionalColor } from "../colors.ts";
import { auctionCellTextVisible, formatAuctionCellMetric, formatAuctionMetric } from "../labels.ts";
import type { AuctionProfileRenderTransform } from "../AuctionProfileRenderer.ts";
import { auctionProfileSettingsForDevice } from "../deviceBudget.ts";

export const CVD_FOOTPRINT_RENDERER_KIND = "TIME_PRICE_FOOTPRINT" as const;
export const auctionCellColor = auctionDirectionalColor;

function cellFontSize(size: AuctionProfileSettings["rendering"]["cellTextSize"], width: number, height: number) {
  const fixed = { TINY: 7, SMALL: 8, NORMAL: 10, LARGE: 12, HUGE: 15 } as const;
  if (size !== "AUTO") return fixed[size];
  return Math.max(7, Math.min(11, Math.floor(Math.min(height - 2, width / 4.5))));
}

export class CvdFootprintRenderer {
  readonly container = new Container();
  private clip = new Graphics();
  private cells = new Graphics();
  private textLayer = new Container();
  private textPool: Text[] = [];
  private textByKey = new Map<string, Text>();
  private activeTextKeys = new Set<string>();
  private hoverLayer = new Graphics();
  private hoverText = new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 8, lineHeight: 11, fill: 0xf4f6f7 } });
  private hitCells: Array<{ x: number; y: number; width: number; height: number; cell: AuctionBlockCell; snapshot: AuctionProfileSnapshot }> = [];
  private viewport = { width: 0, top: 0, bottom: 0 };
  private cvdMetric: AuctionProfileSettings["cvdMetric"] = "NET_CVD";
  private metricsState = { cells: 0, labels: 0, commands: 0 };

  constructor() {
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
    this.container.addChild(this.clip, this.cells, this.textLayer, this.hoverLayer, this.hoverText);
    this.container.mask = this.clip;
  }

  private text(key: string, value: string, x: number, y: number, fontSize: number) {
    let label = this.textByKey.get(key);
    if (!label) {
      label = this.textPool.pop() ?? new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 9, fill: 0xffffff } });
      this.textByKey.set(key, label);
      this.textLayer.addChild(label);
    }
    this.activeTextKeys.add(key);
    if (label.text !== value) label.text = value;
    if (label.style.fontSize !== fontSize) label.style.fontSize = fontSize;
    label.anchor.set(0.5);
    label.position.set(x, y);
    label.visible = true;
  }

  private finishTextFrame() {
    for (const [key, label] of this.textByKey) {
      if (this.activeTextKeys.has(key)) continue;
      this.textLayer.removeChild(label);
      label.visible = false;
      this.textPool.push(label);
      this.textByKey.delete(key);
    }
    this.metricsState.labels = this.activeTextKeys.size;
  }

  draw(snapshots: readonly AuctionProfileSnapshot[] | AuctionProfileSnapshot | null, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform) {
    const effectiveSettings = auctionProfileSettingsForDevice(settings, transform.constrainedTouchRenderer);
    this.cvdMetric = effectiveSettings.cvdMetric;
    this.activeTextKeys.clear();
    this.cells.clear();
    this.clip.clear().rect(0, transform.top, transform.width, Math.max(1, transform.bottom - transform.top)).fill(0xffffff);
    this.hitCells = [];
    this.metricsState = { cells: 0, labels: 0, commands: 0 };
    this.viewport = { width: transform.width, top: transform.top, bottom: transform.bottom };
    this.clearHover();
    const items: readonly AuctionProfileSnapshot[] = snapshots
      ? (Array.isArray(snapshots) ? snapshots as readonly AuctionProfileSnapshot[] : [snapshots as AuctionProfileSnapshot])
      : [];
    for (const snapshot of items) {
      const visibleBlocks = snapshot.matrix.blocks.filter(block => {
        const left = transform.xForTime(block.startTime);
        const right = transform.xForTime(block.endTime + 1);
        return Math.max(left, right) >= 0 && Math.min(left, right) <= transform.width;
      }).length;
      const visibleRows = snapshot.matrix.rows.filter(row => {
        const top = transform.yForPrice(row.high);
        const bottom = transform.yForPrice(row.low);
        return Math.max(top, bottom) >= transform.top && Math.min(top, bottom) <= transform.bottom;
      }).length;
      const strides = auctionCellRenderStrides(visibleBlocks, visibleRows, effectiveSettings.rendering.maximumVisibleColumns, effectiveSettings.rendering.maximumVisibleRows);
      for (const cell of downsampleAuctionCells(snapshot.matrix.cells, strides.columnStride, strides.rowStride)) {
        const rawLeft = transform.xForTime(cell.startTime);
        const rawRight = transform.xForTime(cell.endTime + 1);
        const x = Math.min(rawLeft, rawRight);
        const width = Math.max(1, Math.abs(rawRight - rawLeft) - 0.45);
        const top = transform.yForPrice(cell.priceHigh);
        const bottom = transform.yForPrice(cell.priceLow);
        const y = Math.min(top, bottom);
        const height = Math.max(1, Math.abs(bottom - top) - 0.35);
        if (x + width < 0 || x > transform.width || y + height < transform.top || y > transform.bottom) continue;
        const strength = Math.abs(cell.normalizedValue);
        const color = auctionDirectionalColor(cell.rawValue, strength, effectiveSettings.rendering);
        const alpha = auctionBrightnessAlpha((0.3 + strength * 0.66) * effectiveSettings.rendering.opacity, effectiveSettings.rendering.brightness);
        this.cells.rect(x, y, width, height).fill({ color, alpha });
        if (effectiveSettings.rendering.cellBorder !== "NONE") {
          this.cells.rect(x, y, width, height).stroke({ color: 0x090909, width: effectiveSettings.rendering.cellBorder === "HIGH_CONTRAST" ? 1.2 : 0.65, alpha: effectiveSettings.rendering.cellBorder === "SUBTLE" ? 0.64 : 0.9 });
        }
        if (cell.isDeveloping) this.cells.rect(x, y, width, height).stroke({ color: 0xffffff, width: 0.8, alpha: 0.4 });
        if (effectiveSettings.rendering.showText && this.activeTextKeys.size < effectiveSettings.rendering.maximumVisibleLabels && auctionCellTextVisible(effectiveSettings.rendering.cellTextMode, width, height, strength)) {
          this.text(`footprint:${snapshot.profileId}:${cell.id}`, formatAuctionCellMetric(cell.rawValue, snapshot.engine, effectiveSettings.cvdMetric), x + width / 2, y + height / 2, cellFontSize(effectiveSettings.rendering.cellTextSize, width, height));
        }
        this.hitCells.push({ x, y, width, height, cell, snapshot });
        this.metricsState.cells += 1;
        this.metricsState.commands += 1;
      }
    }
    this.finishTextFrame();
  }

  clearHover() {
    this.hoverLayer.clear();
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
  }

  drawHover(x: number, y: number) {
    const hit = [...this.hitCells].reverse().find(candidate => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
    if (!hit) return this.clearHover();
    const { cell, snapshot } = hit;
    this.hoverText.text = [
      `CVD FOOTPRINT · ${cell.isDeveloping ? "DEVELOPING" : "FINALIZED"}`,
      `Time   ${new Date(cell.startTime * 1000).toISOString().slice(0, 19)} UTC`,
      `Price  ${cell.priceLow.toLocaleString()} — ${cell.priceHigh.toLocaleString()}`,
      `Value  ${formatAuctionCellMetric(cell.rawValue, snapshot.engine, this.cvdMetric)}`,
      `Buy    ${formatAuctionMetric(cell.buyValue)}`,
      `Sell   ${formatAuctionMetric(cell.sellValue)}`,
      `CVD    ${formatAuctionMetric(cell.buyValue - cell.sellValue)}`,
      `Trades ${cell.tradeCount.toLocaleString()} · ${cell.dataQuality.replaceAll("_", " ")}`
    ].join("\n");
    const padding = 7;
    const boxWidth = Math.max(226, this.hoverText.width + padding * 2);
    const boxHeight = this.hoverText.height + padding * 2;
    const left = x + 14 + boxWidth <= this.viewport.width ? x + 14 : Math.max(0, x - boxWidth - 14);
    const top = Math.max(this.viewport.top, Math.min(this.viewport.bottom - boxHeight, y + 12));
    this.hoverText.position.set(left + padding, top + padding);
    this.hoverText.visible = true;
    this.hoverLayer.clear().roundRect(left, top, boxWidth, boxHeight, 3).fill({ color: 0x05070a, alpha: 0.97 }).stroke({ color: 0x4b5058, width: 0.8, alpha: 0.9 });
    this.hoverLayer.visible = true;
  }

  metrics() {
    return { ...this.metricsState, textPool: this.textPool.length };
  }

  dispose() {
    this.container.mask = null;
    this.container.destroy({ children: true });
    this.textPool.forEach(text => text.destroy());
    this.textPool = [];
    this.textByKey.clear();
  }
}
