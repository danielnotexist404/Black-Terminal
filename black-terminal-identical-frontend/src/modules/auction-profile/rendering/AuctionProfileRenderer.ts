import { Container, Graphics, Text } from "pixi.js";
import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../core/types.ts";
import { auctionBrightnessAlpha, normalizedAuctionRowStrength } from "./heatmap.ts";
import { auctionHistogramWidth, auctionProfileHorizontalBounds } from "./histogram.ts";
import { formatAuctionMetric } from "./labels.ts";
import { auctionNodeAlpha } from "./nodes.ts";

export type AuctionProfileRenderTransform = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  xForTime(time: number): number;
  yForPrice(price: number): number;
};

function colorNumber(color: string) {
  const parsed = Number.parseInt(color.replace(/^#/, ""), 16);
  return Number.isFinite(parsed) ? parsed : 0xffffff;
}

export class AuctionProfileRenderer {
  readonly container = new Container();
  private clip = new Graphics();
  private heatmap = new Graphics();
  private histogram = new Graphics();
  private zones = new Graphics();
  private levels = new Graphics();
  private textLayer = new Container();
  private texts: Text[] = [];
  private metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0 };

  constructor() {
    this.container.addChild(this.clip, this.heatmap, this.histogram, this.zones, this.levels, this.textLayer);
    this.container.mask = this.clip;
  }

  private text(text: string, x: number, y: number, color: number, align: "left" | "right" = "left") {
    const label = this.texts.pop() ?? new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 9, fill: 0xffffff } });
    label.text = text;
    label.style.fill = color;
    label.anchor.set(align === "right" ? 1 : 0, 0.5);
    label.x = x;
    label.y = y;
    label.visible = true;
    this.textLayer.addChild(label);
    return label;
  }

  private recycleTexts() {
    for (const child of [...this.textLayer.children]) {
      this.textLayer.removeChild(child);
      if (child instanceof Text) {
        child.visible = false;
        this.texts.push(child);
      }
    }
  }

  draw(snapshot: AuctionProfileSnapshot | null, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform) {
    this.clip.clear().rect(0, transform.top, transform.width, Math.max(1, transform.bottom - transform.top)).fill(0xffffff);
    this.heatmap.clear();
    this.histogram.clear();
    this.zones.clear();
    this.levels.clear();
    this.recycleTexts();
    if (!snapshot) {
      this.metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0 };
      return;
    }
    const rendering = settings.rendering;
    const maximum = Math.max(...snapshot.rows.map(row => Math.abs(row.value)), Number.EPSILON);
    const bounds = auctionProfileHorizontalBounds(snapshot.range, transform.width, transform.xForTime);
    if (!bounds.visible || bounds.width < 1) {
      this.metricsState = { rows: snapshot.rows.length, nodes: snapshot.nodes.length, labels: 0, commands: 0 };
      return;
    }
    const profileWidth = bounds.width;
    const baseX = bounds.right;
    const histogramEnabled = ["HORIZONTAL_HISTOGRAM", "PROFILE_COLUMNS", "COMBINED"].includes(rendering.displayStyle);
    const heatmapEnabled = ["HEATMAP_BLOCKS", "CONTOUR", "COMBINED"].includes(rendering.displayStyle);
    const nodesEnabled = ["NODES_ONLY", "STRUCTURAL_ZONES", "COMBINED"].includes(rendering.displayStyle) || rendering.showNodeLabels;
    let commands = 0;
    for (const row of snapshot.rows) {
      const top = transform.yForPrice(row.high);
      const bottom = transform.yForPrice(row.low);
      const y = Math.min(top, bottom);
      const height = Math.max(1, Math.abs(bottom - top));
      if (y + height < transform.top || y > transform.bottom) continue;
      const positive = row.value >= 0;
      const color = colorNumber(positive ? rendering.positiveColor : rendering.negativeColor);
      const strength = normalizedAuctionRowStrength(row, maximum);
      if (heatmapEnabled) {
        this.heatmap.rect(bounds.left, y, profileWidth, height).fill({
          color,
          alpha: auctionBrightnessAlpha((0.018 + strength * 0.16) * rendering.opacity, rendering.brightness)
        });
        commands += 1;
      }
      if (histogramEnabled) {
        const width = auctionHistogramWidth(row, maximum, profileWidth, rendering.widthPercent);
        this.histogram.rect(baseX - width, y, width, height).fill({
          color,
          alpha: auctionBrightnessAlpha((0.16 + strength * 0.62) * rendering.opacity, rendering.brightness)
        });
        commands += 1;
      }
      if (rendering.showText && strength >= 0.42 && height >= 8) {
        this.text(formatAuctionMetric(row.value), baseX - 4, y + height / 2, colorNumber("#ffffff"), "right");
      }
    }
    if (nodesEnabled) {
      for (const node of snapshot.nodes) {
        const top = transform.yForPrice(node.high);
        const bottom = transform.yForPrice(node.low);
        const y = Math.min(top, bottom);
        const height = Math.max(2, Math.abs(bottom - top));
        if (y + height < transform.top || y > transform.bottom) continue;
        const color = colorNumber(node.type === "LVN" ? rendering.lvnColor : rendering.hvnColor);
        this.zones.rect(bounds.left, y, profileWidth, height)
          .fill({ color, alpha: auctionBrightnessAlpha(auctionNodeAlpha(node) * rendering.opacity, rendering.brightness) })
          .stroke({ color, width: 1, alpha: 0.72 });
        commands += 2;
        if (rendering.showNodeLabels && height >= 6) this.text(node.classification.replaceAll("_", " "), Math.max(4, bounds.left + 4), y + height / 2, color);
      }
    }
    if (rendering.showValueArea && snapshot.keyLevels.vah !== null && snapshot.keyLevels.val !== null) {
      const top = transform.yForPrice(snapshot.keyLevels.vah);
      const bottom = transform.yForPrice(snapshot.keyLevels.val);
      this.levels.rect(bounds.left, Math.min(top, bottom), profileWidth, Math.abs(bottom - top))
        .stroke({ color: colorNumber(rendering.valueAreaColor), width: 1, alpha: 0.3 });
      commands += 1;
    }
    if (rendering.showKeyLevels) {
      const entries: Array<[string, number | null, string]> = [
        ["POC", snapshot.keyLevels.poc, rendering.pocColor],
        ["VAH", snapshot.keyLevels.vah, rendering.valueAreaColor],
        ["VAL", snapshot.keyLevels.val, rendering.valueAreaColor],
        ["IBH", snapshot.keyLevels.ibHigh, rendering.balancedColor],
        ["IBL", snapshot.keyLevels.ibLow, rendering.balancedColor]
      ];
      entries.forEach(([name, price, color]) => {
        if (price === null) return;
        const y = transform.yForPrice(price);
        if (y < transform.top || y > transform.bottom) return;
        const number = colorNumber(color);
        this.levels.moveTo(bounds.left, y).lineTo(bounds.right, y).stroke({ color: number, width: name === "POC" ? 2 : 1, alpha: name === "POC" ? 0.9 : 0.48 });
        this.text(name, Math.max(4, bounds.left + 3), y - 6, number);
        commands += 1;
      });
    }
    this.metricsState = {
      rows: snapshot.rows.length,
      nodes: snapshot.nodes.length,
      labels: this.textLayer.children.length,
      commands
    };
  }

  metrics() {
    return { ...this.metricsState, textPool: this.texts.length };
  }

  dispose() {
    this.container.mask = null;
    this.container.destroy({ children: true });
    this.texts.forEach(text => text.destroy());
    this.texts = [];
  }
}
