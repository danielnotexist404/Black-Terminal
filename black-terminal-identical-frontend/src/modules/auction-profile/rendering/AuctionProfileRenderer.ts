import { Container, Graphics, Text } from "pixi.js";
import {
  AUCTION_PROFILE_RENDERER_KIND,
  auctionProfileEffectiveWidthPercent,
  auctionProfileBarSpans,
  buildAuctionProfileRows,
  compressAuctionProfileSegments,
  resolveAuctionProfilePlacement,
  resolveAuctionProfileRangeBounds,
  type AuctionProfileBarSpan,
  type AuctionProfileDisplayBlock,
  type AuctionProfileRowProjection
} from "../core/profileGeometry.ts";
import type { AuctionProfileSettings, AuctionProfileSnapshot } from "../core/types.ts";
import { auctionBrightnessAlpha } from "./heatmap.ts";
import { auctionColorNumber, auctionDirectionalColor } from "./colors.ts";
import { auctionCellTextVisible, formatAuctionCellMetric, formatAuctionMetric, formatAuctionProfileRowMetric } from "./labels.ts";
import { auctionProfileSettingsForDevice } from "./deviceBudget.ts";

export { AUCTION_PROFILE_RENDERER_KIND };

export type AuctionProfileRenderTransform = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  constrainedTouchRenderer?: boolean;
  xForTime(time: number): number;
  xForLookbackBars(bars: number): number;
  yForPrice(price: number): number;
};

function labelVisible(mode: AuctionProfileSettings["rendering"]["rowLabelMode"], width: number, height: number, strength: number) {
  if (mode === "OFF" || mode === "HOVER") return false;
  if (mode === "STRONG_ONLY") return strength >= 0.62 && width >= 24 && height >= 8;
  if (mode === "ALWAYS") return width >= 14 && height >= 7;
  return width >= 28 && height >= 9;
}

export function auctionProfileDrawSignature(
  snapshots: readonly AuctionProfileSnapshot[],
  settings: AuctionProfileSettings,
  transform: AuctionProfileRenderTransform,
  renderingSignature = JSON.stringify(settings.rendering)
) {
  const projectionSignature = snapshots.map(snapshot => [
    snapshot.profileId,
    snapshot.profileVersion,
    transform.xForTime(snapshot.range.start).toFixed(2),
    transform.xForTime(snapshot.range.end + 1).toFixed(2),
    transform.yForPrice(snapshot.grid.priceLow).toFixed(2),
    transform.yForPrice(snapshot.grid.priceHigh).toFixed(2)
  ].join(":"));
  return [
    snapshots.length,
    projectionSignature.join("|"),
    renderingSignature,
    settings.nodeDetection.prominence,
    settings.nodeDetection.showLvns,
    settings.nodeDetection.showHvns,
    transform.width,
    transform.height,
    transform.top,
    transform.bottom
  ].join(";");
}

export class AuctionProfileRenderer {
  readonly container = new Container();
  private clip = new Graphics();
  private background = new Graphics();
  private profiles = new Graphics();
  private segments = new Graphics();
  private nodes = new Graphics();
  private levels = new Graphics();
  private textLayer = new Container();
  private textPool: Text[] = [];
  private textByKey = new Map<string, Text>();
  private activeTextKeys = new Set<string>();
  private hoverLayer = new Graphics();
  private hoverText = new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 8, lineHeight: 11, fill: 0xf4f6f7 } });
  private hitRows: Array<{ left: number; right: number; top: number; bottom: number; row: AuctionProfileRowProjection; snapshot: AuctionProfileSnapshot }> = [];
  private hitBlocks: Array<{ left: number; right: number; top: number; bottom: number; row: AuctionProfileRowProjection; block: AuctionProfileDisplayBlock; snapshot: AuctionProfileSnapshot }> = [];
  private viewport = { width: 0, top: 0, bottom: 0 };
  private settings: AuctionProfileSettings | null = null;
  private lastDrawSignature = "";
  private lastRenderingSettings: AuctionProfileSettings["rendering"] | null = null;
  private renderingSettingsSignature = "";
  private metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0, footprintCells: 0, profileBlocks: 0 };

  constructor() {
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
    this.container.addChild(this.clip, this.background, this.profiles, this.segments, this.nodes, this.levels, this.textLayer, this.hoverLayer, this.hoverText);
    this.container.mask = this.clip;
  }

  private text(key: string, value: string, x: number, y: number, color = 0xffffff, align: "left" | "center" | "right" = "left", size = 8) {
    let label = this.textByKey.get(key);
    if (!label) {
      label = this.textPool.pop() ?? new Text({ text: "", style: { fontFamily: "IBM Plex Mono", fontSize: 8, fill: 0xffffff } });
      this.textByKey.set(key, label);
      this.textLayer.addChild(label);
    }
    this.activeTextKeys.add(key);
    if (label.text !== value) label.text = value;
    if (label.style.fill !== color) label.style.fill = color;
    if (label.style.fontSize !== size) label.style.fontSize = size;
    const anchor = align === "right" ? 1 : align === "center" ? 0.5 : 0;
    label.anchor.set(anchor, 0.5);
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

  private drawSegments(
    snapshot: AuctionProfileSnapshot,
    row: AuctionProfileRowProjection,
    span: AuctionProfileBarSpan,
    top: number,
    height: number,
    settings: AuctionProfileSettings,
    blockMaximum: number
  ) {
    if (!row.timeSegments.length || span.right <= span.left) return;
    const spanWidth = span.right - span.left;
    const maximumBlocks = Math.max(1, Math.min(
      settings.rendering.maximumVisibleColumns,
      Math.floor(spanWidth / settings.rendering.profileBlockPixelWidth)
    ));
    const source = compressAuctionProfileSegments(row.timeSegments, maximumBlocks, settings.rendering.profileBlockValueMode);
    const width = spanWidth / source.length;
    let cursor = span.left;
    source.forEach((block, index) => {
      const right = index === source.length - 1 ? span.right : Math.min(span.right, cursor + width);
      const blockWidth = Math.max(0.5, right - cursor);
      const strength = Math.min(1, Math.abs(block.value) / Math.max(blockMaximum, Number.EPSILON));
      const color = auctionDirectionalColor(block.value, strength, settings.rendering);
      const valueAreaAlpha = row.inValueArea ? 1 : 0.62;
      this.segments.rect(cursor, top, blockWidth, height)
        .fill({ color, alpha: auctionBrightnessAlpha((0.36 + strength * 0.62) * settings.rendering.opacity * valueAreaAlpha, settings.rendering.brightness) })
        .stroke({ color: 0x070707, width: settings.rendering.cellBorder === "NONE" ? 0 : 0.7, alpha: 0.92 });
      if (
        settings.rendering.showText
        && this.activeTextKeys.size < settings.rendering.maximumVisibleLabels
        && auctionCellTextVisible(settings.rendering.cellTextMode, blockWidth, height, strength)
      ) {
        this.text(
          `profile-block:${snapshot.profileId}:${row.rowIndex}:${index}`,
          formatAuctionCellMetric(block.value, snapshot.engine, settings.cvdMetric),
          cursor + blockWidth / 2,
          top + height / 2,
          block.value < 0 ? 0xffffff : strength > 0.66 ? 0x080808 : 0xffffff,
          "center",
          Math.max(6, Math.min(8, height - 1))
        );
      }
      this.hitBlocks.push({ left: cursor, right, top, bottom: top + height, row, block, snapshot });
      this.metricsState.profileBlocks += 1;
      cursor = right;
    });
  }

  private drawSnapshot(snapshot: AuctionProfileSnapshot, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform, snapshotIndex: number, snapshotCount: number) {
    const rawRangeLeft = transform.xForTime(snapshot.range.start);
    const rawRangeRight = transform.xForTime(snapshot.range.end + 1);
    const range = resolveAuctionProfileRangeBounds(transform.width, rawRangeLeft, rawRangeRight);
    const { left: rangeLeft, right: rangeRight } = range;
    if (rangeRight <= 0 || rangeLeft >= transform.width) return;
    if (snapshot.scope === "SESSION" && snapshotIndex < snapshotCount - 1 && rangeRight - rangeLeft < 18) return;
    const matrixProfile = settings.rendering.profileBodyStyle === "HDLX_CVD_BLOCKS";
    const profileGeometry = matrixProfile
      ? settings.rendering.profileSide === "LEFT" ? "SINGLE_SIDED_RIGHT" : "SINGLE_SIDED_LEFT"
      : settings.rendering.profileGeometry;
    const configuredPlacement = matrixProfile
      ? settings.rendering.profileSide === "LEFT" ? "RANGE_START" : "RANGE_END"
      : settings.rendering.profilePlacement;
    const placement = snapshot.scope === "SESSION" && configuredPlacement === "RIGHT" ? "INSIDE_RANGE" : configuredPlacement;
    const baseWidthPercent = settings.rendering.profileWidthAuto
      ? snapshot.scope === "MACRO_COMPOSITE" ? 30 : snapshot.scope === "SESSION" ? 28 : 32
      : settings.rendering.widthPercent;
    const widthPercent = matrixProfile
      ? auctionProfileEffectiveWidthPercent(baseWidthPercent, settings.rendering.profileLengthPercent)
      : baseWidthPercent;
    const bounds = resolveAuctionProfilePlacement(placement, transform.width, rangeLeft, rangeRight, widthPercent);
    const rows = buildAuctionProfileRows(snapshot, settings);
    const visibleRows = rows.filter(row => {
      const top = transform.yForPrice(row.priceHigh);
      const bottom = transform.yForPrice(row.priceLow);
      return Math.max(top, bottom) >= transform.top && Math.min(top, bottom) <= transform.bottom;
    });
    if (!visibleRows.length) return;
    const blockValues = visibleRows.flatMap(row => row.timeSegments.map(segment => Math.abs(segment.value))).filter(value => value > 0).sort((a, b) => a - b);
    const robustIndex = Math.max(0, Math.min(blockValues.length - 1, Math.floor(blockValues.length * 0.98)));
    const blockMaximum = blockValues[robustIndex] ?? 1;
    const profileTop = Math.max(transform.top, Math.min(...visibleRows.map(row => transform.yForPrice(row.priceHigh))));
    const profileBottom = Math.min(transform.bottom, Math.max(...visibleRows.map(row => transform.yForPrice(row.priceLow))));
    if (!matrixProfile) {
      this.background.rect(bounds.left, profileTop, bounds.width, Math.max(1, profileBottom - profileTop))
        .fill({ color: 0x080a0d, alpha: 0.34 })
        .stroke({ color: snapshot.matrix.blocks.at(-1)?.isDeveloping ? 0xaeb4bc : 0x3c4148, width: 0.7, alpha: 0.62 });
    }
    if (!matrixProfile && ["BIDIRECTIONAL_DELTA", "POSITIVE_NEGATIVE_SPLIT", "MIRRORED", "CENTERED"].includes(profileGeometry)) {
      this.background.moveTo(bounds.center, profileTop).lineTo(bounds.center, profileBottom).stroke({ color: 0xb9bec5, width: 0.7, alpha: 0.36 });
    }

    const structureVisible = snapshotIndex === snapshotCount - 1 || settings.rendering.showHistoricalExtensions;
    if (
      structureVisible
      && settings.rendering.showValueArea
      && snapshot.keyLevels.vah !== null
      && snapshot.keyLevels.val !== null
      && settings.rendering.valueAreaFillOpacity > 0
    ) {
      const vahY = transform.yForPrice(snapshot.keyLevels.vah);
      const valY = transform.yForPrice(snapshot.keyLevels.val);
      const fillTop = Math.max(transform.top, Math.min(vahY, valY));
      const fillBottom = Math.min(transform.bottom, Math.max(vahY, valY));
      if (fillBottom > fillTop && range.width > 0) {
        this.background.rect(range.left, fillTop, range.width, fillBottom - fillTop).fill({
          color: auctionColorNumber(settings.rendering.valueAreaFillColor),
          alpha: auctionBrightnessAlpha(settings.rendering.valueAreaFillOpacity, settings.rendering.brightness)
        });
      }
    }
    const minimumProminence = Math.max(settings.nodeDetection.prominence, settings.rendering.structuralDetail === "MINIMAL" ? 0.42 : 0.3);
    const ranked = structureVisible
      ? [...snapshot.nodes]
        .filter(node => node.prominence >= minimumProminence && (node.type === "LVN" || node.normalizedScore >= 0.55))
        .sort((left, right) => (right.prominence + right.normalizedScore) - (left.prominence + left.normalizedScore))
      : [];
    const detailCap = settings.rendering.structuralDetail === "MINIMAL" ? 3 : settings.rendering.structuralDetail === "STANDARD" ? 6 : settings.rendering.structuralDetail === "DETAILED" ? 12 : Number.POSITIVE_INFINITY;
    const lvn = settings.nodeDetection.showLvns ? ranked.filter(node => node.type === "LVN").slice(0, Math.min(detailCap, settings.rendering.maximumVisibleLvns)) : [];
    const hvn = settings.nodeDetection.showHvns ? ranked.filter(node => node.type === "HVN").slice(0, Math.min(detailCap, settings.rendering.maximumVisibleHvns)) : [];
    for (const node of [...lvn, ...hvn].slice(0, settings.rendering.maximumVisibleStructuralZones)) {
      const top = transform.yForPrice(node.high);
      const bottom = transform.yForPrice(node.low);
      const y = Math.min(top, bottom);
      const height = Math.max(2, Math.abs(bottom - top));
      if (y + height < transform.top || y > transform.bottom) continue;
      const color = auctionColorNumber(node.type === "LVN" ? settings.rendering.lvnColor : settings.rendering.hvnColor);
      this.nodes.rect(range.left, y, range.width, height).stroke({ color, width: node.type === "LVN" ? 0.75 : 1, alpha: node.type === "LVN" ? 0.58 : 0.76 });
      if (settings.rendering.showNodeLabels && this.activeTextKeys.size < settings.rendering.maximumVisibleLabels) {
        const labelAtLeft = settings.rendering.profileSide === "LEFT";
        this.text(
          `profile-node:${snapshot.profileId}:${node.id}`,
          node.classification.replaceAll("_", " "),
          labelAtLeft ? range.left + 3 : range.right - 3,
          y + height / 2,
          color,
          labelAtLeft ? "left" : "right"
        );
      }
      this.metricsState.nodes += 1;
    }

    for (const row of visibleRows) {
      const top = transform.yForPrice(row.priceHigh);
      const bottom = transform.yForPrice(row.priceLow);
      const y = Math.min(top, bottom);
      const height = Math.max(1, Math.abs(bottom - top) - 0.35);
      const spans = auctionProfileBarSpans(row, profileGeometry, bounds);
      for (const span of spans) {
        const width = Math.max(0, span.right - span.left);
        if (width < 0.5) continue;
        if (matrixProfile) {
          this.drawSegments(snapshot, row, span, y, height, settings, blockMaximum);
        } else {
          const signedValue = span.role === "NEGATIVE" ? -Math.abs(row.rawWidthValue) : span.role === "POSITIVE" ? Math.abs(row.rawWidthValue) : 0;
          const color = auctionDirectionalColor(signedValue, row.normalizedWidth, settings.rendering);
          this.profiles.rect(span.left, y, width, height)
            .fill({ color, alpha: auctionBrightnessAlpha((0.28 + row.normalizedWidth * 0.66) * settings.rendering.opacity, settings.rendering.brightness) })
            .stroke({ color: 0x080808, width: settings.rendering.cellBorder === "NONE" ? 0 : 0.6, alpha: 0.78 });
          if (settings.rendering.timeSegmentsMode !== "OFF") this.drawSegments(snapshot, row, span, y, height, settings, blockMaximum);
        }
        this.hitRows.push({ left: span.left, right: span.right, top: y, bottom: y + height, row, snapshot });
        this.metricsState.commands += 1;
      }
      const widest = spans.reduce((winner, span) => span.right - span.left > winner.right - winner.left ? span : winner, spans[0]!);
      const labelWidth = widest ? widest.right - widest.left : 0;
      if (!matrixProfile && widest && settings.rendering.showText && this.activeTextKeys.size < settings.rendering.maximumVisibleLabels && labelVisible(settings.rendering.rowLabelMode, labelWidth, height, row.normalizedWidth)) {
        this.text(`profile-row:${snapshot.profileId}:${row.rowIndex}`, formatAuctionProfileRowMetric(row.rawWidthValue, settings.rendering.profileWidthMetric), widest.left + labelWidth / 2, y + height / 2, 0xffffff, "center", Math.max(7, Math.min(10, height - 1)));
      }
      this.metricsState.rows += 1;
    }

    const keyLevels: Array<[string, number | null, string, boolean, "POC" | "VALUE" | "DASHED"]> = structureVisible ? [
      ["POC", snapshot.keyLevels.poc, settings.rendering.pocColor, settings.rendering.showKeyLevels, "POC"],
      ["VAH", snapshot.keyLevels.vah, settings.rendering.valueAreaColor, settings.rendering.showValueArea, "VALUE"],
      ["VAL", snapshot.keyLevels.val, settings.rendering.valueAreaColor, settings.rendering.showValueArea, "VALUE"],
      ["IBH", snapshot.keyLevels.ibHigh, settings.rendering.negativeColor, settings.rendering.showInitialBalance, "DASHED"],
      ["IBL", snapshot.keyLevels.ibLow, settings.rendering.negativeColor, settings.rendering.showInitialBalance, "DASHED"]
    ] : [];
    for (const [name, price, colorValue, visible, role] of keyLevels) {
      if (!visible || price === null) continue;
      const y = transform.yForPrice(price);
      if (y < transform.top || y > transform.bottom) continue;
      const color = auctionColorNumber(colorValue);
      if (role === "DASHED") {
        for (let x = range.left; x < range.right; x += 12) this.levels.moveTo(x, y).lineTo(Math.min(range.right, x + 6), y).stroke({ color, width: 0.8, alpha: 0.7 });
      } else {
        const glowWidth = role === "POC" ? 5 : 3.2;
        const coreWidth = role === "POC" ? 2.2 : 1.25;
        this.levels.moveTo(range.left, y).lineTo(range.right, y).stroke({ color, width: glowWidth, alpha: role === "POC" ? 0.17 : 0.12 });
        this.levels.moveTo(range.left, y).lineTo(range.right, y).stroke({ color, width: coreWidth, alpha: 0.98 });
      }
      if (this.activeTextKeys.size < settings.rendering.maximumVisibleLabels) {
        const labelAtLeft = settings.rendering.profileSide === "LEFT";
        this.text(`profile-level:${snapshot.profileId}:${name}`, name, labelAtLeft ? range.left + 3 : range.right - 3, y - 6, color, labelAtLeft ? "left" : "right");
      }
    }
  }

  draw(snapshots: AuctionProfileSnapshot | readonly AuctionProfileSnapshot[] | null, settings: AuctionProfileSettings, transform: AuctionProfileRenderTransform) {
    const effectiveSettings = auctionProfileSettingsForDevice(settings, transform.constrainedTouchRenderer);
    const items = snapshots ? (Array.isArray(snapshots) ? snapshots : [snapshots as AuctionProfileSnapshot]) : [];
    if (this.lastRenderingSettings !== effectiveSettings.rendering) {
      this.lastRenderingSettings = effectiveSettings.rendering;
      this.renderingSettingsSignature = JSON.stringify(effectiveSettings.rendering);
    }
    const signature = auctionProfileDrawSignature(items, effectiveSettings, transform, this.renderingSettingsSignature);
    if (signature === this.lastDrawSignature) return;
    this.settings = effectiveSettings;
    this.activeTextKeys.clear();
    this.background.clear();
    this.profiles.clear();
    this.segments.clear();
    this.nodes.clear();
    this.levels.clear();
    this.hitRows = [];
    this.hitBlocks = [];
    this.metricsState = { rows: 0, nodes: 0, labels: 0, commands: 0, footprintCells: 0, profileBlocks: 0 };
    this.viewport = { width: transform.width, top: transform.top, bottom: transform.bottom };
    this.clip.clear().rect(0, transform.top, transform.width, Math.max(1, transform.bottom - transform.top)).fill(0xffffff);
    this.clearHover();
    items.forEach((snapshot, index) => this.drawSnapshot(snapshot, effectiveSettings, transform, index, items.length));
    this.finishTextFrame();
    this.lastDrawSignature = signature;
  }

  clearHover() {
    this.hoverLayer.clear();
    this.hoverLayer.visible = false;
    this.hoverText.visible = false;
  }

  drawHover(x: number, y: number) {
    const blockHit = [...this.hitBlocks].reverse().find(candidate => x >= candidate.left && x <= candidate.right && y >= candidate.top && y <= candidate.bottom);
    if (blockHit && this.settings) {
      const { row, block, snapshot } = blockHit;
      this.hoverText.text = [
        `CVD PROFILE BLOCK · ${block.finalized ? "FINALIZED" : "DEVELOPING"}`,
        `Price       ${row.priceLow.toLocaleString()} — ${row.priceHigh.toLocaleString()}`,
        `Block Delta ${formatAuctionCellMetric(block.deltaValue, snapshot.engine, this.settings.cvdMetric)}`,
        `Develop CVD ${formatAuctionCellMetric(block.cumulativeValue, snapshot.engine, this.settings.cvdMetric)}`,
        `Period      ${new Date(block.startTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
        `Sources     ${block.sourceCount.toLocaleString()} matrix ${block.sourceCount === 1 ? "cell" : "cells"}`,
        `Data        ${snapshot.quality.quality} · ${snapshot.quality.exactTradeCoveragePercent.toFixed(0)}% exact`
      ].join("\n");
      return this.placeHover(x, y);
    }
    const hit = [...this.hitRows].reverse().find(candidate => x >= candidate.left && x <= candidate.right && y >= candidate.top && y <= candidate.bottom);
    if (!hit || !this.settings) return this.clearHover();
    const { row, snapshot } = hit;
    this.hoverText.text = [
      `RADAP · ${snapshot.matrix.blocks.at(-1)?.isDeveloping ? "DEVELOPING" : "FINALIZED"}`,
      `Price  ${row.priceLow.toLocaleString()} — ${row.priceHigh.toLocaleString()}`,
      `Width  ${formatAuctionProfileRowMetric(row.rawWidthValue, this.settings.rendering.profileWidthMetric)}`,
      `CVD    ${formatAuctionMetric(row.netCvd)}`,
      `Buy    ${formatAuctionMetric(row.buyVolume)}`,
      `Sell   ${formatAuctionMetric(row.sellVolume)}`,
      `Total  ${formatAuctionMetric(row.totalVolume)}`,
      `Data   ${snapshot.quality.quality} · ${snapshot.quality.exactTradeCoveragePercent.toFixed(0)}% exact`
    ].join("\n");
    this.placeHover(x, y);
  }

  private placeHover(x: number, y: number) {
    const padding = 7;
    const boxWidth = Math.max(230, this.hoverText.width + padding * 2);
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
    this.lastDrawSignature = "";
    this.lastRenderingSettings = null;
    this.container.mask = null;
    this.container.destroy({ children: true });
    this.textPool.forEach(text => text.destroy());
    this.textPool = [];
    this.textByKey.clear();
  }
}
