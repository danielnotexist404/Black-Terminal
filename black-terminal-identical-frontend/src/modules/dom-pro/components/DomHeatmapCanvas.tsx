import { useEffect, useRef } from "react";
import type { DepthHistoryPoint } from "../depthHistoryStore";
import { domPerformanceTrace } from "../domPerformanceTrace";
import type { DomVisualQuality } from "../domAdaptiveQuality";
import { domVisualScheduler } from "../domVisualScheduler";
import { computeDomWallLabelLayout } from "../domWallLabelLayout";
import { domPriceToTopPct, type DomProPriceCamera } from "../domPriceCamera";
import type { DomHeatmapFrame, MacroLiquidityBand, VolumeProfileNode } from "../types";

type Ribbon = { id: string; price: number; intensity: number; side: "supply" | "demand" | "poc"; kind: VolumeProfileNode["kind"] };
type Gap = { id: string; low: number; high: number };

type Props = {
  frames: DomHeatmapFrame[];
  camera: DomProPriceCamera;
  macroBands: MacroLiquidityBand[];
  depthPoints: DepthHistoryPoint[];
  ribbons: Ribbon[];
  gaps: Gap[];
  currentPrice: number;
  quality: DomVisualQuality;
  interactionActive: boolean;
  hoveredPrice?: number;
  enhancedGraphics: boolean;
  showLevelDetails: boolean;
};

export function DomHeatmapCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  const idRef = useRef(`dom-heatmap:${Math.random().toString(36).slice(2)}`);
  const rowBidRef = useRef(new Float32Array(0));
  const rowAskRef = useRef(new Float32Array(0));
  propsRef.current = props;

  useEffect(() => {
    const id = idRef.current;
    return domVisualScheduler.register(id, () => drawHeatmap(canvasRef.current, propsRef.current, rowBidRef, rowAskRef), 2);
  }, []);

  useEffect(() => {
    domVisualScheduler.markDirty(idRef.current);
  }, [props.frames, props.camera, props.macroBands, props.depthPoints, props.ribbons, props.gaps, props.currentPrice, props.quality, props.interactionActive, props.hoveredPrice, props.enhancedGraphics, props.showLevelDetails]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => domVisualScheduler.markDirty(idRef.current));
    observer.observe(canvas);
    const visibility = new IntersectionObserver((entries) => domVisualScheduler.setVisible(idRef.current, Boolean(entries[0]?.isIntersecting)), { threshold: 0.01 });
    visibility.observe(canvas);
    return () => { observer.disconnect(); visibility.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} className="dom-pro-heatmap-layer" data-heatmap-frames={props.frames.length} data-camera-version={props.camera.version} data-camera-min={props.camera.visiblePriceMin} data-camera-max={props.camera.visiblePriceMax} data-current-price-top={domPriceToTopPct(props.camera, props.currentPrice)} data-visual-mode={props.enhancedGraphics ? "enhanced" : "standard"} aria-label="Incremental liquidity heatmap" />;
}

function drawHeatmap(
  canvas: HTMLCanvasElement | null,
  props: Props,
  bidRef: { current: Float32Array },
  askRef: { current: Float32Array }
) {
  if (!canvas) return;
  const startedAt = performance.now();
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const plotWidth = Math.max(1, rect.width - 72);
  const plotHeight = rect.height;
  const yFor = (price: number) => domPriceToTopPct(props.camera, price) / 100 * plotHeight;

  drawGaps(context, props.gaps, yFor, plotWidth, plotHeight);
  if (!props.enhancedGraphics) drawBands(context, props.macroBands, yFor, plotWidth, props.interactionActive, false, props.showLevelDetails);
  drawDepthMemory(context, props.depthPoints, yFor, plotWidth, props.quality, props.interactionActive);
  drawRibbons(context, props.ribbons, yFor, plotWidth, props.interactionActive);

  const maxColumns = props.interactionActive ? 48 : props.quality === "full" ? 140 : props.quality === "balanced" ? 96 : 60;
  const frameStride = Math.max(1, Math.ceil(props.frames.length / maxColumns));
  const columns = Math.max(1, Math.ceil(props.frames.length / frameStride));
  // Camera geometry is shared; IMM keeps its own pixel-resolution data grid.
  const rowCount = Math.max(64, Math.min(512, Math.floor(plotHeight)));
  canvas.dataset.resolutionRows = String(rowCount);
  if (bidRef.current.length !== rowCount) bidRef.current = new Float32Array(rowCount);
  if (askRef.current.length !== rowCount) askRef.current = new Float32Array(rowCount);
  const bid = bidRef.current;
  const ask = askRef.current;
  let visibleCells = 0;
  let drawCalls = 0;
  for (let column = 0; column < columns; column += 1) {
    bid.fill(0); ask.fill(0);
    const start = column * frameStride;
    const end = Math.min(props.frames.length, start + frameStride);
    for (let frameIndex = start; frameIndex < end; frameIndex += 1) {
      const cells = props.frames[frameIndex]?.cells ?? [];
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const cell = cells[cellIndex];
        if (cell.price < props.camera.visiblePriceMin || cell.price > props.camera.visiblePriceMax) continue;
        const row = Math.max(0, Math.min(rowCount - 1, Math.floor(yFor(cell.price) / plotHeight * rowCount)));
        const target = cell.side === "bid" ? bid : ask;
        if (cell.intensity > target[row]) target[row] = cell.intensity;
        visibleCells += 1;
      }
    }
    const x = column / columns * plotWidth;
    const columnWidth = Math.max(1, plotWidth / columns + 0.5);
    for (let row = 0; row < rowCount; row += 1) {
      const intensity = Math.max(bid[row], ask[row]);
      if (intensity < 0.035) continue;
      const isAsk = ask[row] >= bid[row];
      context.fillStyle = isAsk ? `rgba(255,18,24,${Math.min(.92, .08 + intensity * .84)})` : `rgba(238,242,250,${Math.min(.78, .05 + intensity * .7)})`;
      context.fillRect(x, row / rowCount * plotHeight, columnWidth, Math.max(1, plotHeight / rowCount + 0.4));
      drawCalls += 1;
    }
  }
  if (props.enhancedGraphics) drawBands(context, props.macroBands, yFor, plotWidth, props.interactionActive, true, props.showLevelDetails);
  const currentY = yFor(props.currentPrice);
  if (currentY >= 0 && currentY <= plotHeight) {
    context.strokeStyle = "rgba(255,255,255,.82)";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(0, currentY); context.lineTo(plotWidth, currentY); context.stroke();
  }
  if (Number.isFinite(props.hoveredPrice)) {
    const hoveredRow = Math.max(0, Math.min(rowCount - 1, Math.floor(yFor(Number(props.hoveredPrice)) / plotHeight * rowCount)));
    const top = hoveredRow / rowCount * plotHeight;
    const rowHeight = Math.max(1, plotHeight / rowCount);
    context.fillStyle = "rgba(255,255,255,.055)";
    context.fillRect(0, top, plotWidth, rowHeight);
    context.strokeStyle = "rgba(255,255,255,.34)";
    context.lineWidth = 1;
    context.strokeRect(0, top, plotWidth, rowHeight);
  }
  drawScale(context, props.camera, plotWidth, plotHeight);
  domPerformanceTrace.record("canvas.heatmap_draw", performance.now() - startedAt, visibleCells, drawCalls);
  domPerformanceTrace.increment("canvas.heatmap_draw_calls", drawCalls);
}

function drawGaps(context: CanvasRenderingContext2D, gaps: Gap[], yFor: (price: number) => number, width: number, height: number) {
  context.save();
  context.fillStyle = "rgba(42,42,48,.18)";
  for (const gap of gaps) {
    const top = Math.max(0, yFor(gap.high));
    const bottom = Math.min(height, yFor(gap.low));
    if (bottom > top) context.fillRect(0, top, width, bottom - top);
  }
  context.restore();
}

function drawBands(
  context: CanvasRenderingContext2D,
  bands: MacroLiquidityBand[],
  yFor: (price: number) => number,
  width: number,
  simple: boolean,
  enhanced: boolean,
  showDetails: boolean
) {
  if (!enhanced) {
    drawBandsStandard(context, bands, yFor, width, simple || !showDetails);
    return;
  }
  for (const band of bands) {
    const y = yFor(band.price);
    if (y < -24 || y > context.canvas.height + 24) continue;
    const isSupply = band.side === "supply";
    const isPoc = band.side === "poc";
    const half = Math.max(3.5, Math.min(12, band.strength * 9 + 2.5));
    const color = isSupply ? "255,0,10" : "238,242,250";
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, `rgba(${color},.08)`);
    gradient.addColorStop(.18, `rgba(${color},${Math.max(.32, band.strength * .72)})`);
    gradient.addColorStop(.58, `rgba(${color},${Math.max(.58, band.strength * .98)})`);
    gradient.addColorStop(.88, `rgba(${color},${Math.max(.2, band.strength * .5)})`);
    gradient.addColorStop(1, `rgba(${color},.04)`);
    const top = y - half;
    const stripHeight = half * 2;
    context.save();
    if (!simple) {
      context.shadowColor = isSupply ? "rgba(255,0,12,.72)" : "rgba(245,248,255,.54)";
      context.shadowBlur = isPoc ? 20 : 14;
    }
    context.fillStyle = gradient;
    context.fillRect(0, top, width, stripHeight);
    context.restore();
    if (!showDetails || simple) continue;

    const sideLabel = isPoc ? "POC" : isSupply ? "SELL WALL" : "BUY WALL";
    const fullLabel = `${sideLabel} / ${formatPrice(band.price)}`;
    context.font = "700 9px IBM Plex Mono, monospace";
    const layout = computeDomWallLabelLayout({ top, height: stripHeight, width, measuredWidth: context.measureText(fullLabel).width });
    if (!layout.visible) continue;
    context.save();
    context.beginPath();
    context.rect(layout.clipX, layout.clipY, layout.clipWidth, layout.clipHeight);
    context.clip();
    context.textBaseline = "middle";
    context.fillStyle = isSupply ? "rgba(255,255,255,.97)" : "rgba(10,12,15,.95)";
    context.fillText(layout.compact ? sideLabel : fullLabel, layout.x, layout.y);
    if (!layout.compact && width >= 270) {
      context.textAlign = "right";
      context.font = "700 8px IBM Plex Mono, monospace";
      context.fillText(`${band.touches} touches / ${Math.round(band.strength * 100)}%`, width - 10, layout.y);
    }
    context.restore();
  }
}

function drawBandsStandard(context: CanvasRenderingContext2D, bands: MacroLiquidityBand[], yFor: (price: number) => number, width: number, simple: boolean) {
  for (const band of bands) {
    const y = yFor(band.price);
    if (y < -20 || y > context.canvas.height + 20) continue;
    const half = Math.max(2, Math.min(10, band.strength * 9));
    const color = band.side === "supply" ? "255,0,10" : "238,242,250";
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, `rgba(${color},.02)`); gradient.addColorStop(.55, `rgba(${color},${Math.max(.18, band.strength * .72)})`); gradient.addColorStop(1, `rgba(${color},.03)`);
    const top = y - half;
    const stripHeight = half * 2;
    context.fillStyle = gradient; context.fillRect(0, top, width, stripHeight);
    if (!simple) {
      const fullLabel = `${band.side === "supply" ? "SELL WALL" : "BUY WALL"} · ${formatPrice(band.price)}`;
      context.font = "700 9px IBM Plex Mono, monospace";
      const layout = computeDomWallLabelLayout({ top, height: stripHeight, width, measuredWidth: context.measureText(fullLabel).width });
      if (!layout.visible) continue;
      context.save();
      context.beginPath();
      context.rect(layout.clipX, layout.clipY, layout.clipWidth, layout.clipHeight);
      context.clip();
      context.textBaseline = "middle";
      context.fillStyle = band.side === "supply" ? "rgba(255,255,255,.96)" : "rgba(10,12,15,.94)";
      context.fillText(layout.compact ? (band.side === "supply" ? "SELL" : "BUY") : fullLabel, layout.x, layout.y);
      context.restore();
    }
  }
}

function drawDepthMemory(context: CanvasRenderingContext2D, points: DepthHistoryPoint[], yFor: (price: number) => number, width: number, quality: DomVisualQuality, simple: boolean) {
  const stride = simple || quality === "degraded" ? 3 : quality === "balanced" ? 2 : 1;
  for (let index = 0; index < points.length; index += stride) {
    const point = points[index]; const y = yFor(point.price);
    if (y < -8 || y > context.canvas.height + 8) continue;
    context.fillStyle = point.side === "ask" ? `rgba(255,20,24,${Math.max(.08, point.strength * .55)})` : `rgba(238,242,250,${Math.max(.06, point.strength * .42)})`;
    context.fillRect(0, y - 1, width * Math.min(.94, .18 + point.strength * .7), Math.max(2, point.strength * 7));
  }
}

function drawRibbons(context: CanvasRenderingContext2D, ribbons: Ribbon[], yFor: (price: number) => number, width: number, simple: boolean) {
  if (simple) return;
  for (const ribbon of ribbons) {
    const y = yFor(ribbon.price); if (y < -8 || y > context.canvas.height + 8) continue;
    context.fillStyle = ribbon.side === "supply" ? `rgba(255,0,8,${ribbon.intensity * .45})` : `rgba(245,247,252,${ribbon.intensity * .36})`;
    context.fillRect(0, y - 1, width, Math.max(2, ribbon.intensity * 6));
  }
}

function drawScale(context: CanvasRenderingContext2D, camera: DomProPriceCamera, left: number, height: number) {
  context.fillStyle = "rgba(180,186,198,.9)"; context.font = "8px IBM Plex Mono, monospace";
  for (let index = 0; index <= 6; index += 1) {
    const y = index / 6 * height;
    const price = camera.visiblePriceMax - index / 6 * (camera.visiblePriceMax - camera.visiblePriceMin);
    context.fillText(formatPrice(price), left + 7, Math.max(9, Math.min(height - 3, y + 3)));
  }
}

function formatPrice(value: number) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: value >= 1000 ? 1 : 4 }) : "--";
}
