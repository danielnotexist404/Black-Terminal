import { Container, Graphics, Text } from "pixi.js";
import type { AuctionBlockCell, AuctionProfileSettings, AuctionProfileSnapshot } from "../core/types.ts";
import { auctionCellRenderStrides, downsampleAuctionCells } from "./cells.ts";
import { auctionBrightnessAlpha, normalizedAuctionRowStrength } from "./heatmap.ts";
import { auctionHistogramWidth, auctionProfileHorizontalBounds, auctionProfileStartX } from "./histogram.ts";
import { auctionCellTextVisible, formatAuctionCellMetric, formatAuctionMetric } from "./labels.ts";
import { auctionNodeAlpha } from "./nodes.ts";

export type AuctionProfileRenderTransform = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  xForTime(time: number): number;
  xForLookbackBars(bars: number): number;
  yForPrice(price: number): number;
};

function colorNumber(color: string) {
  const parsed = Number.parseInt(color.replace(/^#/, ""), 16);
  return Number.isFinite(parsed) ? parsed : 0xffffff;
}

function mixColor(from: string, to: string, amount: number) {
  const left = colorNumber(from);
  const right = colorNumber(to);
  const t = Math.max(0, Math.min(1, amount));
  const channel = (shift: number) => Math.round(((left >> shift) & 0xff) * (1 - t) + ((right >> shift) & 0xff) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function auctionCellColor(value: number, strength: number, settings: AuctionProfileSettings["rendering"]) {
  if (value === 0) return colorNumber(settings.balancedColor);
  if (value > 0) return mixColor("#202020", settings.positiveColor, Math.pow(strength, 0.72));
  return mixColor("#2a0508", settings.negativeColor, Math.pow(strength, 0.72));
}

function cellFontSize(size: AuctionProfileSettings["rendering"]["cellTextSize"], width: number, height: number) {
  const fixed = { TINY: 7, SMALL: 8, NORMAL: 10, LARGE: 12, HUGE: 15 } as const;
  if (size !== "AUTO") return fixed[size];
  return Math.max(7, Math.min(11, Math.floor(Math.min(height - 2, width / 4.5))));
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
  private textByKey = new Map<string, Text>();
  private activeTextKeys = new Set<string>();
  private hoverLayer = new Graphics();
  private hoverText = new Text({
    text: "",
    style: { fontFamily: "IBM Plex Mono", fontSize: 8, lineHeight: 11, fill: 0xf4f6f7 }
  });
  private hitCells: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    cell: AuctionBlockCell;
    snapshot: AuctionProfileSnapshot;
  }> = [];
  private viewport = { width: 0, top: 0, bottom: 0 };
  private cvdMetric: AuctionProfileSettings["cvdMetric"] = "NET_CVD";
  private metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0 };

  constructor() {
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
    this.container.addChild(this.clip, this.heatmap, this.histogram, this.zones, this.levels, this.textLayer, this.hoverLayer, this.hoverText);
    this.container.mask = this.clip;
  }

  private text(key: string, text: string, x: number, y: number, color: number, align: "left" | "center" | "right" = "left", fontSize = 9) {
    let label = this.textByKey.get(key);
    if (!label) {
      label = this.texts.pop() ?? new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 9, fill: 0xffffff } });
      this.textByKey.set(key, label);
      this.textLayer.addChild(label);
    }
    this.activeTextKeys.add(key);
    if (label.text !== text) label.text = text;
    if (label.style.fill !== color) label.style.fill = color;
    if (label.style.fontSize !== fontSize) label.style.fontSize = fontSize;
    const anchor = align === "right" ? 1 : align === "center" ? 0.5 : 0;
    if (label.anchor.x !== anchor || label.anchor.y !== 0.5) label.anchor.set(anchor, 0.5);
    label.x = x;
    label.y = y;
    label.visible = true;
    return label;
  }

  private finishTextFrame() {
    for (const [key, label] of this.textByKey) {
      if (this.activeTextKeys.has(key)) continue;
      this.textLayer.removeChild(label);
      label.visible = false;
      this.texts.push(label);
      this.textByKey.delete(key);
    }
    this.metricsState.labels = this.activeTextKeys.size;
  }

  private drawSnapshot(snapshot: AuctionProfileSnapshot | null, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform, append: boolean) {
    if (!append) {
      this.clip.clear().rect(0, transform.top, transform.width, Math.max(1, transform.bottom - transform.top)).fill(0xffffff);
      this.heatmap.clear();
      this.histogram.clear();
      this.zones.clear();
      this.levels.clear();
      this.metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0 };
      this.hitCells = [];
      this.viewport = { width: transform.width, top: transform.top, bottom: transform.bottom };
      this.clearHover();
    }
    if (!snapshot) return;
    const rendering = settings.rendering;
    const maximum = Math.max(...snapshot.rows.map(row => Math.abs(row.value)), Number.EPSILON);
    const startX = auctionProfileStartX(
      snapshot.scope,
      snapshot.range,
      transform.xForTime,
      transform.xForLookbackBars
    );
    const bounds = auctionProfileHorizontalBounds(snapshot.range, transform.width, transform.xForTime, startX);
    if (!bounds.visible || bounds.width < 1) {
      this.metricsState = {
        rows: this.metricsState.rows + snapshot.rows.length,
        nodes: this.metricsState.nodes + snapshot.nodes.length,
        labels: this.textLayer.children.length,
        commands: this.metricsState.commands
      };
      return;
    }
    const profileWidth = bounds.width;
    const baseX = bounds.right;
    const dynamicEnabled = ["DYNAMIC_BLOCKS", "DYNAMIC_KEY_LEVELS", "DYNAMIC_AGGREGATE"].includes(rendering.presentationMode);
    const histogramEnabled = ["AGGREGATE_HISTOGRAM", "DYNAMIC_AGGREGATE", "MACRO_STRUCTURE"].includes(rendering.presentationMode);
    const nodesEnabled = ["STRUCTURAL_NODES", "MACRO_STRUCTURE"].includes(rendering.presentationMode) || (
      ["DYNAMIC_KEY_LEVELS", "DYNAMIC_AGGREGATE"].includes(rendering.presentationMode) &&
      (settings.nodeDetection.showLvns || settings.nodeDetection.showHvns)
    );
    let commands = 0;
    let labels = 0;
    if (dynamicEnabled) {
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
      const strides = auctionCellRenderStrides(visibleBlocks, visibleRows, rendering.maximumVisibleColumns, rendering.maximumVisibleRows);
      const renderCells = downsampleAuctionCells(snapshot.matrix.cells, strides.columnStride, strides.rowStride);
      for (const cell of renderCells) {
        const rawLeft = transform.xForTime(cell.startTime);
        const rawRight = transform.xForTime(cell.endTime + 1);
        const x = Math.min(rawLeft, rawRight);
        const width = Math.max(1, Math.abs(rawRight - rawLeft) - 0.45);
        if (x + width < 0 || x > transform.width) continue;
        const top = transform.yForPrice(cell.priceHigh);
        const bottom = transform.yForPrice(cell.priceLow);
        const y = Math.min(top, bottom);
        const height = Math.max(1, Math.abs(bottom - top) - 0.35);
        if (y + height < transform.top || y > transform.bottom) continue;
        this.hitCells.push({ x, y, width, height, cell, snapshot });
        const strength = Math.abs(cell.normalizedValue);
        const color = auctionCellColor(cell.rawValue, strength, rendering);
        const alpha = auctionBrightnessAlpha((0.3 + strength * 0.66) * rendering.opacity, rendering.brightness);
        this.heatmap.rect(x, y, width, height).fill({ color, alpha });
        if (rendering.cellBorder !== "NONE") {
          const borderAlpha = rendering.cellBorder === "SUBTLE" ? 0.64 : rendering.cellBorder === "STANDARD" ? 0.82 : 1;
          const borderWidth = rendering.cellBorder === "HIGH_CONTRAST" ? 1.2 : 0.65;
          this.heatmap.rect(x, y, width, height).stroke({ color: 0x090909, width: borderWidth, alpha: borderAlpha });
        }
        if (cell.isDeveloping) this.heatmap.rect(x, y, width, height).stroke({ color: 0xffffff, width: 0.8, alpha: 0.34 });
        if (rendering.showText && labels < rendering.maximumVisibleLabels && auctionCellTextVisible(rendering.cellTextMode, width, height, strength)) {
          this.text(`cell:${snapshot.profileId}:${cell.id}`, formatAuctionCellMetric(cell.rawValue, snapshot.engine, settings.cvdMetric), x + width / 2, y + height / 2, 0xffffff, "center", cellFontSize(rendering.cellTextSize, width, height));
          labels += 1;
        }
        commands += 1;
      }
    }
    if (histogramEnabled) {
      const histogramWidth = Math.min(profileWidth, transform.width * rendering.widthPercent / 100);
      for (const row of snapshot.rows) {
        const top = transform.yForPrice(row.high);
        const bottom = transform.yForPrice(row.low);
        const y = Math.min(top, bottom);
        const height = Math.max(1, Math.abs(bottom - top));
        if (y + height < transform.top || y > transform.bottom) continue;
        const strength = normalizedAuctionRowStrength(row, maximum);
        const color = auctionCellColor(row.value, strength, rendering);
        const width = auctionHistogramWidth(row, maximum, histogramWidth, rendering.widthPercent);
        this.histogram.rect(baseX - width, y, width, height).fill({
          color,
          alpha: auctionBrightnessAlpha((0.16 + strength * 0.62) * rendering.opacity, rendering.brightness)
        });
        commands += 1;
        if (rendering.showText && strength >= 0.42 && height >= 8 && labels < rendering.maximumVisibleLabels) {
          this.text(`histogram:${snapshot.profileId}:${row.index}`, formatAuctionMetric(row.value), baseX - 4, y + height / 2, 0xffffff, "right");
          labels += 1;
        }
      }
    }
    if (nodesEnabled) {
      const detailCap = rendering.structuralDetail === "MINIMAL" ? 1 : rendering.structuralDetail === "STANDARD" ? 3 : rendering.structuralDetail === "DETAILED" ? 10 : Number.POSITIVE_INFINITY;
      const ranked = [...snapshot.nodes].sort((left, right) => (right.prominence + right.normalizedScore) - (left.prominence + left.normalizedScore));
      const lvns = settings.nodeDetection.showLvns ? ranked.filter(node => node.type === "LVN").slice(0, Math.min(detailCap, rendering.maximumVisibleLvns)) : [];
      const hvns = settings.nodeDetection.showHvns ? ranked.filter(node => node.type === "HVN").slice(0, Math.min(detailCap, rendering.maximumVisibleHvns)) : [];
      const fullChart = rendering.zoneExtensionMode === "FULL_CHART";
      const extendRight = ["EXTEND_RIGHT", "UNTIL_FIRST_TOUCH", "UNTIL_MITIGATED", "UNTIL_INVALIDATED"].includes(rendering.zoneExtensionMode);
      const fixedRight = rendering.zoneExtensionMode === "FIXED_N_BARS"
        ? Math.min(transform.width, bounds.right + profileWidth / Math.max(1, snapshot.range.loadedBars) * rendering.fixedExtensionBars)
        : bounds.right;
      const zoneLeft = fullChart ? 0 : bounds.left;
      const zoneRight = fullChart || extendRight
        ? transform.width
        : fixedRight;
      for (const node of [...lvns, ...hvns].slice(0, rendering.maximumVisibleStructuralZones)) {
        const top = transform.yForPrice(node.high);
        const bottom = transform.yForPrice(node.low);
        const y = Math.min(top, bottom);
        const height = Math.max(2, Math.abs(bottom - top));
        if (y + height < transform.top || y > transform.bottom) continue;
        const color = colorNumber(node.type === "LVN" ? rendering.lvnColor : rendering.hvnColor);
        this.zones.rect(zoneLeft, y, Math.max(1, zoneRight - zoneLeft), height)
          .fill({ color, alpha: auctionBrightnessAlpha(auctionNodeAlpha(node) * rendering.opacity * 0.72, rendering.brightness) })
          .stroke({ color, width: 0.8, alpha: 0.56 });
        commands += 2;
        if (rendering.showNodeLabels && height >= 6 && labels < rendering.maximumVisibleLabels) {
          this.text(`node:${snapshot.profileId}:${node.id}`, node.classification.replaceAll("_", " "), Math.max(4, bounds.left + 4), y + height / 2, color);
          labels += 1;
        }
      }
    }
    const keyLevelsEnabled = ["DYNAMIC_KEY_LEVELS", "DYNAMIC_AGGREGATE", "AGGREGATE_HISTOGRAM", "MACRO_STRUCTURE"].includes(rendering.presentationMode);
    if (keyLevelsEnabled) {
      const entries: Array<[string, number | null, string, boolean, boolean]> = [
        ["POC", snapshot.keyLevels.poc, rendering.pocColor, rendering.showKeyLevels, false],
        ["VAH", snapshot.keyLevels.vah, rendering.valueAreaColor, rendering.showValueArea, true],
        ["VAL", snapshot.keyLevels.val, rendering.valueAreaColor, rendering.showValueArea, true],
        ["IBH", snapshot.keyLevels.ibHigh, rendering.negativeColor, rendering.showInitialBalance, true],
        ["IBL", snapshot.keyLevels.ibLow, rendering.negativeColor, rendering.showInitialBalance, true],
        ["MID", snapshot.keyLevels.midpoint, rendering.balancedColor, rendering.showMidpoint, true]
      ];
      entries.forEach(([name, price, color, visible, dashed]) => {
        if (!visible || price === null) return;
        const y = transform.yForPrice(price);
        if (y < transform.top || y > transform.bottom) return;
        const number = colorNumber(color);
        if (dashed) {
          for (let x = bounds.left; x < bounds.right; x += 13) this.levels.moveTo(x, y).lineTo(Math.min(bounds.right, x + 7), y).stroke({ color: number, width: 0.8, alpha: 0.58 });
        } else {
          this.levels.moveTo(bounds.left, y).lineTo(bounds.right, y).stroke({ color: number, width: 1.35, alpha: 0.88 });
        }
        if (labels < rendering.maximumVisibleLabels) {
          this.text(`level:${snapshot.profileId}:${name}`, name, Math.max(4, bounds.left + 3), y - 6, number);
          labels += 1;
        }
        commands += 1;
      });
    }
    this.metricsState = {
      rows: this.metricsState.rows + snapshot.rows.length,
      nodes: this.metricsState.nodes + snapshot.nodes.length,
      labels: this.textLayer.children.length,
      commands: this.metricsState.commands + commands
    };
  }

  draw(snapshots: AuctionProfileSnapshot | readonly AuctionProfileSnapshot[] | null, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform) {
    this.cvdMetric = settings.cvdMetric;
    this.activeTextKeys.clear();
    const items = snapshots ? (Array.isArray(snapshots) ? snapshots : [snapshots as AuctionProfileSnapshot]) : [];
    if (!items.length) {
      this.drawSnapshot(null, settings, transform, false);
      this.finishTextFrame();
      return;
    }
    items.forEach((snapshot, index) => this.drawSnapshot(snapshot, settings, transform, index > 0));
    this.finishTextFrame();
  }

  clearHover() {
    this.hoverLayer.clear();
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
  }

  drawHover(x: number, y: number) {
    let hit: (typeof this.hitCells)[number] | undefined;
    for (let index = this.hitCells.length - 1; index >= 0; index -= 1) {
      const candidate = this.hitCells[index]!;
      if (
        x >= candidate.x && x <= candidate.x + candidate.width &&
        y >= candidate.y && y <= candidate.y + candidate.height
      ) {
        hit = candidate;
        break;
      }
    }
    if (!hit) {
      this.clearHover();
      return;
    }
    const { cell, snapshot } = hit;
    const start = new Date(cell.startTime * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const end = new Date(cell.endTime * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    this.hoverText.text = [
      `AUCTION CELL · ${cell.isDeveloping ? "DEVELOPING" : "FINALIZED"}`,
      `Block  ${start}`,
      `End    ${end}`,
      `Price  ${cell.priceLow.toLocaleString()} — ${cell.priceHigh.toLocaleString()}`,
      `Engine ${snapshot.engine.replaceAll("_", " ")}`,
      `Value  ${formatAuctionCellMetric(cell.rawValue, snapshot.engine, this.cvdMetric)}`,
      `Buy    ${formatAuctionMetric(cell.buyValue)}`,
      `Sell   ${formatAuctionMetric(cell.sellValue)}`,
      `Total  ${formatAuctionMetric(cell.totalValue)}`,
      `CVD    ${formatAuctionMetric(cell.buyValue - cell.sellValue)}`,
      `USD    $${formatAuctionMetric(cell.notional)}`,
      `Trades ${cell.tradeCount.toLocaleString()} · ${cell.dataQuality.replaceAll("_", " ")}`
    ].join("\n");
    this.hoverText.visible = true;
    const padding = 7;
    const boxWidth = Math.max(230, this.hoverText.width + padding * 2);
    const boxHeight = this.hoverText.height + padding * 2;
    const left = x + 14 + boxWidth <= this.viewport.width ? x + 14 : Math.max(0, x - boxWidth - 14);
    const top = Math.max(this.viewport.top, Math.min(this.viewport.bottom - boxHeight, y + 12));
    this.hoverText.position.set(left + padding, top + padding);
    this.hoverLayer.clear().roundRect(left, top, boxWidth, boxHeight, 3)
      .fill({ color: 0x05070a, alpha: 0.97 })
      .stroke({ color: 0x4b5058, width: 0.8, alpha: 0.9 });
    this.hoverLayer.visible = true;
  }

  metrics() {
    return { ...this.metricsState, textPool: this.texts.length };
  }

  dispose() {
    this.container.mask = null;
    this.container.destroy({ children: true });
    this.texts.forEach(text => text.destroy());
    this.texts = [];
    this.textByKey.clear();
    this.activeTextKeys.clear();
  }
}
