import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { Crosshair, Lock, X } from "lucide-react";
import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { MarketSymbol } from "../../../market-data/types";
import { blackCorePerformanceMonitor } from "../../../performance/performanceMonitor";
import {
  CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
  buildChartSynchronizedViewport,
  buildChartDockedDepthLadder,
  buildPriceFollowingViewport,
  fitViewportToDeliveredBook,
  translateChartViewportToDock,
  type ChartDockedDepthLadderModel,
  type ChartDockedDepthRow,
  type ChartDockedDepthScaleMode
} from "../chartDockedDepthLadderModel";
import { blackCoreChartPriceViewportStore } from "../chartPriceViewportStore";
import { useConsolidatedLiquidityFeed } from "../consolidatedLiquidityClient";
import { ProfessionalDomLadderTracker } from "../domProfessionalLadder";
import "../chartDockedDepthLadder.css";

type ChartDockedDepthLadderProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  viewportKey: string;
  workspaceId: string;
  onClose: () => void;
};

type CanvasSize = { width: number; height: number };
type VisualRow = { bid: number; ask: number; delta: number; depth: number; activity: number };
type HoverState = { row: ChartDockedDepthRow; x: number; y: number } | null;
type DepthViewMode = "chart" | "range" | "book";

const AGGREGATION_OPTIONS = [1, 5, 10, 20, 50, 100];
const SMOOTHING_TAU_MS = 82;
const CONSOLIDATED_QUERY_BUCKET_USD = 1_000;
const CONSOLIDATED_QUERY_BUFFER_USD = 2_000;
const LADDER_DATA_TOP_PX = 38;
const LADDER_FOOTER_HEIGHT_PX = 26;

export function ChartDockedDepthLadder({ marketSymbol, lastPrice, viewportKey, workspaceId, onClose }: ChartDockedDepthLadderProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef(new ProfessionalDomLadderTracker());
  const animationRef = useRef<{ raf: number | null; lastAt: number; revision: number; rows: VisualRow[] }>({ raf: null, lastAt: 0, revision: -1, rows: [] });
  const latestModelRef = useRef<ChartDockedDepthLadderModel | null>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 320, height: 600 });
  const [chartOriginOffsetY, setChartOriginOffsetY] = useState(0);
  const [hover, setHover] = useState<HoverState>(null);
  const [aggregationTicks, setAggregationTicks] = useState(() => readAggregation(workspaceId));
  const [viewMode, setViewMode] = useState<DepthViewMode>(() => readViewMode(workspaceId));
  const [lockedViewport, setLockedViewport] = useState<ChartPriceTransformSnapshot | null>(null);
  const subscribeViewport = useCallback((listener: () => void) => blackCoreChartPriceViewportStore.subscribe(viewportKey, listener), [viewportKey]);
  const getViewport = useCallback(() => blackCoreChartPriceViewportStore.getSnapshot(viewportKey), [viewportKey]);
  const viewport = useSyncExternalStore(subscribeViewport, getViewport, () => null);
  const dockAlignedChartViewport = useMemo(() => viewport
    ? translateChartViewportToDock(viewport, chartOriginOffsetY)
    : null, [chartOriginOffsetY, viewport]);
  const ladderRenderViewport = useMemo(() => {
    if (!viewport) return null;
    const plotTop = Math.max(LADDER_DATA_TOP_PX, Math.min(viewport.plotTop, size.height - LADDER_FOOTER_HEIGHT_PX - 80));
    const plotBottom = Math.max(plotTop + 80, size.height - LADDER_FOOTER_HEIGHT_PX);
    return {
      ...viewport,
      width: size.width,
      height: size.height,
      plotTop,
      plotBottom
    };
  }, [size.height, size.width, viewport]);
  const followingViewport = useMemo(() => dockAlignedChartViewport && ladderRenderViewport
    ? buildPriceFollowingViewport(dockAlignedChartViewport, lastPrice, CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD, ladderRenderViewport)
    : null, [dockAlignedChartViewport, ladderRenderViewport, lastPrice]);
  const chartSynchronizedViewport = useMemo(() => dockAlignedChartViewport && ladderRenderViewport
    ? buildChartSynchronizedViewport(dockAlignedChartViewport, ladderRenderViewport)
    : null, [dockAlignedChartViewport, ladderRenderViewport]);
  const selectedLiveViewport = viewMode === "chart" ? chartSynchronizedViewport : followingViewport;
  const bufferedLiveViewport = useMemo(() => selectedLiveViewport
    ? buildBufferedRequestViewport(selectedLiveViewport)
    : null, [selectedLiveViewport]);
  const requestViewport = lockedViewport ?? bufferedLiveViewport;
  const requestedRows = requestViewport
    ? clampInteger(Math.round(((requestViewport.plotBottom - requestViewport.plotTop) / 13) * (20 / aggregationTicks)), 80, 180)
    : 80;
  const consolidated = useConsolidatedLiquidityFeed({
    baseAsset: marketSymbol.baseAsset,
    minimumPrice: requestViewport?.priceMin ?? 0,
    maximumPrice: requestViewport?.priceMax ?? 0,
    rowCount: requestedRows,
    enabled: Boolean(requestViewport)
  });

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const chartHost = element.closest(".terminal-grid")?.querySelector<HTMLElement>(".pixi-chart-host") ?? null;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setSize({ width: Math.max(220, bounds.width), height: Math.max(180, bounds.height) });
      if (chartHost) {
        const nextOffset = chartHost.getBoundingClientRect().top - bounds.top;
        setChartOriginOffsetY((current) => Math.abs(current - nextOffset) < 0.25 ? current : nextOffset);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (chartHost) observer.observe(chartHost);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem(aggregationStorageKey(workspaceId), String(aggregationTicks));
  }, [aggregationTicks, workspaceId]);

  useEffect(() => {
    localStorage.setItem(viewModeStorageKey(workspaceId), viewMode);
    setHover(null);
  }, [viewMode, workspaceId]);

  useEffect(() => {
    setLockedViewport(null);
    setHover(null);
  }, [marketSymbol.baseAsset, viewportKey]);

  const professionalDepth = useMemo(() => trackerRef.current.update({
    book: consolidated.book,
    currentPrice: lastPrice ?? consolidated.snapshot?.referencePrice,
    aggregationTicks: 1,
    bookStatus: `CONSOLIDATED_${consolidated.status.toUpperCase()}`,
    now: Date.now(),
    maximumRows: 12_000
  }), [consolidated.book, consolidated.snapshot?.generatedAt, consolidated.snapshot?.referencePrice, consolidated.status, lastPrice]);

  const unlockedViewport = useMemo(() => {
    if (!selectedLiveViewport) return null;
    return viewMode === "book"
      ? fitViewportToDeliveredBook(selectedLiveViewport, professionalDepth)
      : selectedLiveViewport;
  }, [professionalDepth, selectedLiveViewport, viewMode]);
  const effectiveViewport = lockedViewport ?? unlockedViewport;
  const scaleMode: ChartDockedDepthScaleMode = lockedViewport ? "locked" : viewMode === "book" ? "book" : viewMode === "chart" ? "chart" : "follow";

  const model = useMemo(() => effectiveViewport ? buildChartDockedDepthLadder({
    depth: professionalDepth,
    viewport: effectiveViewport,
    preferredRowHeight: 13,
    maximumRows: 180,
    scaleMode
  }) : null, [effectiveViewport, professionalDepth, scaleMode]);
  latestModelRef.current = model;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const state = animationRef.current;
    const targetRows = model.rows.map(toVisualRow);
    const viewportChanged = state.revision !== model.viewportRevision || state.rows.length !== targetRows.length;
    if (viewportChanged) {
      state.rows = targetRows;
      state.revision = model.viewportRevision;
      state.lastAt = performance.now();
      drawLadder(canvas, size, model, state.rows, marketSymbol.quoteAsset);
      return;
    }

    if (state.raf !== null) cancelAnimationFrame(state.raf);
    state.lastAt = performance.now();
    const animate = (now: number) => {
      const activeModel = latestModelRef.current;
      if (!activeModel || activeModel.viewportRevision !== state.revision || activeModel.rows.length !== state.rows.length) {
        state.raf = null;
        return;
      }
      const elapsed = Math.min(64, Math.max(1, now - state.lastAt));
      state.lastAt = now;
      const alpha = 1 - Math.exp(-elapsed / SMOOTHING_TAU_MS);
      let remaining = 0;
      activeModel.rows.forEach((row, index) => {
        const visual = state.rows[index];
        const target = toVisualRow(row);
        visual.bid = approach(visual.bid, target.bid, alpha);
        visual.ask = approach(visual.ask, target.ask, alpha);
        visual.delta = approach(visual.delta, target.delta, alpha);
        visual.depth = approach(visual.depth, target.depth, alpha);
        visual.activity = approach(visual.activity, target.activity, alpha);
        remaining = Math.max(remaining,
          relativeDistance(visual.bid, target.bid),
          relativeDistance(visual.ask, target.ask),
          relativeDistance(visual.delta, target.delta),
          Math.abs(visual.depth - target.depth),
          Math.abs(visual.activity - target.activity)
        );
      });
      const startedAt = performance.now();
      drawLadder(canvas, size, activeModel, state.rows, marketSymbol.quoteAsset);
      blackCorePerformanceMonitor.recordMetric("chart_docked_ladder.canvas_frame_ms", performance.now() - startedAt, "ms", { symbol: marketSymbol.rawSymbol });
      if (remaining > 0.002 && document.visibilityState === "visible") state.raf = requestAnimationFrame(animate);
      else {
        state.rows = activeModel.rows.map(toVisualRow);
        drawLadder(canvas, size, activeModel, state.rows, marketSymbol.quoteAsset);
        state.raf = null;
      }
    };
    state.raf = requestAnimationFrame(animate);
    return () => {
      if (state.raf !== null) cancelAnimationFrame(state.raf);
      state.raf = null;
    };
  }, [marketSymbol.quoteAsset, marketSymbol.rawSymbol, model, size]);

  useEffect(() => () => {
    if (animationRef.current.raf !== null) cancelAnimationFrame(animationRef.current.raf);
  }, []);

  function handlePointerMove(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!model) return setHover(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - bounds.top;
    if (y < model.plotTop || y > model.plotBottom) return setHover(null);
    const index = Math.floor((y - model.plotTop) / Math.max(model.rowHeight, 1));
    const row = model.rows[index];
    if (!row) return setHover(null);
    setHover({ row, x: Math.min(bounds.width - 150, Math.max(8, event.clientX - bounds.left + 10)), y: Math.min(bounds.height - 88, Math.max(42, y + 8)) });
  }

  const sourceDepth = professionalDepth.subscribedDepth ?? Math.max(professionalDepth.bidLevels, professionalDepth.askLevels);
  const status = `CLF ${consolidated.status.toUpperCase()} ${consolidated.snapshot?.includedVenues.length ?? 0}V`;

  return (
    <aside
      ref={rootRef}
      className={`chart-docked-depth-ladder chart-docked-depth-ladder--${professionalDepth.state}`}
      data-chart-docked-depth-ladder="true"
      data-viewport-revision={effectiveViewport?.revision ?? -1}
      data-subscribed-depth={sourceDepth}
      data-depth-scale-mode={scaleMode}
      data-depth-view-mode={viewMode}
    >
      <header className="chart-docked-depth-toolbar">
        <strong>LPP</strong>
        <button
          type="button"
          className="chart-docked-depth-scale"
          onClick={() => setLockedViewport((current) => current ? null : effectiveViewport ? { ...effectiveViewport } : null)}
          title={scaleMode === "locked"
            ? "Price scale is frozen. Click to resume the selected live range mode."
            : "Freeze the ladder's current price range while keeping live depth updates active."}
          aria-label={`Depth scale: ${scaleMode === "locked" ? "scale locked" : viewMode === "book" ? "book fit live" : viewMode === "chart" ? "chart synchronized" : "26 thousand dollar follow"}`}
        >
          {scaleMode === "locked" ? <Lock size={10} /> : <Crosshair size={10} />}
          {scaleMode === "locked" ? "LOCKED" : viewMode === "book" ? "BOOK LIVE" : viewMode === "chart" ? "CHART SYNC" : "26K FOLLOW"}
        </button>
        <label className="chart-docked-depth-view" title="Choose exact chart confluence, a moving 26,000 USD range, or all currently delivered depth">
          VIEW:
          <select
            aria-label="Ladder price scale mode"
            value={viewMode}
            onChange={(event) => {
              setViewMode(event.target.value as DepthViewMode);
              setLockedViewport(null);
            }}
          >
            <option value="chart">CHART</option>
            <option value="range">26K</option>
            <option value="book">BOOK FIT</option>
          </select>
        </label>
        <label title="Aggregate this many native venue ticks before projecting depth onto the chart scale">
          AGG:
          <select value={aggregationTicks} onChange={(event) => setAggregationTicks(Number(event.target.value))}>
            {AGGREGATION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <em>{status} · {sourceDepth || "—"}×2</em>
        <button type="button" onClick={onClose} title="Close full-book ladder" aria-label="Close full-book ladder"><X size={12} /></button>
      </header>
      <div className="chart-docked-depth-columns" aria-hidden="true">
        <span>SUM</span><span>SIZE</span><span>DELTA</span><span>PRICE</span><span>DEPTH</span>
      </div>
      <canvas
        ref={canvasRef}
        className="chart-docked-depth-canvas"
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHover(null)}
        aria-label={`${marketSymbol.rawSymbol} chart-synchronized full delivered order book`}
      />
      {!effectiveViewport && <div className="chart-docked-depth-awaiting">SYNCHRONIZING FULL-RANGE PRICE SCALE</div>}
      {hover && <DepthTooltip hover={hover} quoteAsset={marketSymbol.quoteAsset} />}
      <footer className="chart-docked-depth-footer">
        <span>{consolidated.snapshot ? consolidated.snapshot.includedVenues.map((venue) => venue.venue.toUpperCase()).join("+") : "MULTI-VENUE CLF"} {marketSymbol.rawSymbol}</span>
        <span>{model ? `${formatPrice(model.priceMin, model.priceDecimals)}—${formatPrice(model.priceMax, model.priceDecimals)} · ${formatCompact(model.priceSpan)}` : "—"}</span>
        <span>{model ? `${model.hiddenAboveCount}↑ ${model.hiddenBelowCount}↓` : "—"}</span>
        <b>{consolidated.snapshot ? `${Math.round(consolidated.snapshot.coverageRatio * 100)}% VIEWPORT COVERAGE · ` : ""}VISIBLE RESTING LIMIT DEPTH · HIDDEN/RPI EXCLUDED</b>
      </footer>
    </aside>
  );
}

function DepthTooltip({ hover, quoteAsset }: { hover: Exclude<HoverState, null>; quoteAsset: string }) {
  const { row } = hover;
  return (
    <div className="chart-docked-depth-tooltip" style={{ left: hover.x, top: hover.y }}>
      <strong>{formatPrice(row.price, 2)} {quoteAsset}</strong>
      <span>ASK <b className="ask">{formatCompact(row.askSize * row.price)}</b></span>
      <span>BID <b className="bid">{formatCompact(row.bidSize * row.price)}</b></span>
      <span>DELTA <b className={row.delta >= 0 ? "bid" : "ask"}>{formatSignedCompact(row.delta * row.price)}</b></span>
      <em>{row.coverage === "live" ? "AUTHORITATIVE DELIVERED DEPTH" : "OUTSIDE VENUE COVERAGE"}</em>
    </div>
  );
}

function drawLadder(canvas: HTMLCanvasElement, size: CanvasSize, model: ChartDockedDepthLadderModel, visualRows: VisualRow[], quoteAsset: string) {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const pixelWidth = Math.max(1, Math.round(size.width * dpr));
  const pixelHeight = Math.max(1, Math.round(size.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = "#020304";
  context.fillRect(0, 0, size.width, size.height);

  const columns = [0, size.width * 0.16, size.width * 0.34, size.width * 0.52, size.width * 0.75, size.width];
  const maxVisualDepth = Math.max(1e-12, ...visualRows.map((row) => Math.max(row.bid, row.ask)));
  const profileLeft = columns[4];
  const profileRight = size.width - 7;
  const askGradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  askGradient.addColorStop(0, "rgba(92,0,14,0.34)");
  askGradient.addColorStop(1, "rgba(244,18,47,0.92)");
  const bidGradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  bidGradient.addColorStop(0, "rgba(84,89,97,0.30)");
  bidGradient.addColorStop(1, "rgba(247,249,252,0.92)");
  context.font = '700 7px "IBM Plex Mono", monospace';
  context.textBaseline = "middle";
  context.lineWidth = 1;

  model.rows.forEach((row, index) => {
    const visual = visualRows[index] ?? toVisualRow(row);
    const y = row.top;
    const height = row.height;
    if (row.coverage === "unavailable") {
      context.fillStyle = index % 2 ? "#030405" : "#040506";
      context.fillRect(0, y, size.width, height);
    } else if (row.side === "ask") {
      context.fillStyle = `rgba(74, 2, 13, ${0.08 + visual.depth * 0.11})`;
      context.fillRect(0, y, size.width, height);
    } else if (row.side === "bid") {
      context.fillStyle = `rgba(224, 228, 233, ${0.018 + visual.depth * 0.032})`;
      context.fillRect(0, y, size.width, height);
    }

    context.strokeStyle = "rgba(255,255,255,0.035)";
    context.beginPath();
    context.moveTo(0, y + height);
    context.lineTo(size.width, y + height);
    context.stroke();

    const profileWidth = Math.max(0, size.width - profileLeft - 7);
    const askRatio = visual.ask / maxVisualDepth;
    const bidRatio = visual.bid / maxVisualDepth;
    if (askRatio > 0) {
      const width = Math.max(1, profileWidth * Math.min(1, askRatio));
      context.save();
      context.globalAlpha = 0.58 + visual.activity * 0.42;
      context.fillStyle = askGradient;
      context.fillRect(size.width - 7 - width, y + 1, width, Math.max(1, height - 2));
      context.restore();
    }
    if (bidRatio > 0) {
      const width = Math.max(1, profileWidth * Math.min(1, bidRatio));
      context.save();
      context.globalAlpha = 0.56 + visual.activity * 0.44;
      context.fillStyle = bidGradient;
      context.fillRect(size.width - 7 - width, y + 2, width, Math.max(1, height - 4));
      context.restore();
    }

    const cumulative = row.side === "ask" ? row.askCumulative : row.side === "bid" ? row.bidCumulative : Math.max(row.askCumulative, row.bidCumulative);
    drawRightText(context, row.coverage === "live" ? formatCompact(cumulative * row.price) : "—", columns[1] - 4, y + height / 2, "#a9afb8");
    drawRightText(context, row.totalSize > 0 ? formatSignedCompact(row.signedSize * row.price) : "·", columns[2] - 4, y + height / 2, row.signedSize >= 0 ? "#f2f4f7" : "#ff1c39");
    drawRightText(context, Math.abs(row.delta) > 1e-12 ? formatSignedCompact(row.delta * row.price) : "·", columns[3] - 4, y + height / 2, row.delta >= 0 ? "#f2f4f7" : "#ff1c39");
    drawRightText(context, formatPrice(row.price, model.priceDecimals), columns[4] - 5, y + height / 2, row.isCurrentPrice ? "#ffffff" : "#d7dbe1");

    if (row.totalSize > 0) {
      const nodeAlpha = Math.min(1, 0.18 + visual.depth * 0.55 + visual.activity * 0.35);
      context.save();
      context.shadowBlur = 3 + visual.depth * 4 + visual.activity * 9;
      context.shadowColor = row.side === "ask" ? "rgba(255,0,32,0.9)" : "rgba(255,255,255,0.82)";
      context.fillStyle = row.side === "ask" ? `rgba(255,24,52,${nodeAlpha})` : `rgba(245,247,250,${nodeAlpha})`;
      const nodeHeight = Math.max(2, (height - 3) * (0.58 + visual.depth * 0.42));
      context.fillRect(size.width - 7, y + (height - nodeHeight) / 2, 5, nodeHeight);
      context.fillStyle = row.side === "ask" ? `rgba(255,130,145,${nodeAlpha * 0.82})` : `rgba(255,255,255,${nodeAlpha * 0.88})`;
      context.fillRect(size.width - 5, y + (height - nodeHeight) / 2, 1, nodeHeight);
      context.restore();
    }

    if (row.wall) {
      context.fillStyle = row.wall.side === "sell" ? "#ff1834" : "#f4f6f8";
      context.fillRect(1, y + 1, 2, Math.max(1, height - 2));
    }
  });

  drawCumulativeDepthBand(context, model, visualRows, profileLeft, profileRight, "ask");
  drawCumulativeDepthBand(context, model, visualRows, profileLeft, profileRight, "bid");

  for (let index = 1; index < columns.length - 1; index += 1) {
    context.strokeStyle = "rgba(255,255,255,0.075)";
    context.beginPath();
    context.moveTo(columns[index], model.plotTop);
    context.lineTo(columns[index], model.plotBottom);
    context.stroke();
  }

  if (model.currentPriceY !== null) {
    const y = model.currentPriceY;
    context.strokeStyle = "rgba(255,25,52,0.95)";
    context.shadowBlur = 5;
    context.shadowColor = "rgba(255,0,30,0.72)";
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size.width, y);
    context.stroke();
    context.shadowBlur = 0;
  }

  drawCoverageBoundary(context, model.coverageMax, model, size.width);
  drawCoverageBoundary(context, model.coverageMin, model, size.width);
  context.fillStyle = "rgba(116,123,134,0.52)";
  context.font = '600 6px "IBM Plex Mono", monospace';
  context.textAlign = "left";
  const scaleLabel = model.scaleMode === "chart" ? "CLF CHART-SYNC" : model.scaleMode === "follow" ? "CLF 26K-FOLLOW" : model.scaleMode === "book" ? "CLF BOOK-FIT" : "CLF SCALE-LOCKED";
  context.fillText(`${quoteAsset} · ${scaleLabel}`, 5, Math.min(size.height - 8, model.plotBottom + 13));
}

function drawCumulativeDepthBand(
  context: CanvasRenderingContext2D,
  model: ChartDockedDepthLadderModel,
  visualRows: VisualRow[],
  profileLeft: number,
  profileRight: number,
  side: "ask" | "bid"
) {
  const currentIndex = Math.max(0, model.rows.findIndex((row) => row.isCurrentPrice));
  const indices = side === "ask"
    ? Array.from({ length: currentIndex + 1 }, (_, offset) => currentIndex - offset)
    : Array.from({ length: model.rows.length - currentIndex }, (_, offset) => currentIndex + offset);
  if (indices.length < 2) return;
  let cumulative = 0;
  const points = indices.map((index) => {
    cumulative += side === "ask" ? (visualRows[index]?.ask ?? 0) : (visualRows[index]?.bid ?? 0);
    return { index, cumulative };
  });
  const maximum = points.at(-1)?.cumulative ?? 0;
  if (maximum <= 1e-12) return;
  const width = Math.max(1, profileRight - profileLeft);
  const coordinates = points.map((point) => ({
    x: profileRight - Math.sqrt(point.cumulative / maximum) * width,
    y: model.rows[point.index].top + model.rows[point.index].height / 2
  }));

  context.save();
  context.beginPath();
  context.moveTo(profileRight, coordinates[0].y);
  for (const point of coordinates) context.lineTo(point.x, point.y);
  context.lineTo(profileRight, coordinates.at(-1)!.y);
  context.closePath();
  const gradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  if (side === "ask") {
    gradient.addColorStop(0, "rgba(92,0,14,0.08)");
    gradient.addColorStop(1, "rgba(255,14,42,0.19)");
  } else {
    gradient.addColorStop(0, "rgba(118,124,134,0.06)");
    gradient.addColorStop(1, "rgba(248,250,252,0.16)");
  }
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  coordinates.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
  context.strokeStyle = side === "ask" ? "rgba(255,26,52,0.9)" : "rgba(230,234,240,0.88)";
  context.shadowColor = side === "ask" ? "rgba(255,0,35,0.74)" : "rgba(255,255,255,0.52)";
  context.shadowBlur = 5;
  context.lineWidth = 1.15;
  context.stroke();
  context.restore();
}

function drawCoverageBoundary(context: CanvasRenderingContext2D, price: number | null, model: ChartDockedDepthLadderModel, width: number) {
  const first = model.rows[0];
  const last = model.rows.at(-1);
  if (price === null || !first || !last || price < last.priceLow || price > first.priceHigh) return;
  const row = model.rows.find((candidate) => price <= candidate.priceHigh && price >= candidate.priceLow);
  if (!row) return;
  context.save();
  context.setLineDash([3, 3]);
  context.strokeStyle = "rgba(188,194,202,0.3)";
  context.beginPath();
  context.moveTo(0, row.top + row.height / 2);
  context.lineTo(width, row.top + row.height / 2);
  context.stroke();
  context.restore();
}

function drawRightText(context: CanvasRenderingContext2D, value: string, x: number, y: number, color: string) {
  context.textAlign = "right";
  context.fillStyle = color;
  context.fillText(value, x, y);
}

function toVisualRow(row: ChartDockedDepthRow): VisualRow {
  return { bid: row.bidSize, ask: row.askSize, delta: row.delta, depth: row.depthRatio, activity: row.activityRatio };
}

function approach(current: number, target: number, alpha: number) {
  const value = current + (target - current) * alpha;
  return Math.abs(target - value) <= Math.max(1e-12, Math.abs(target) * 0.0005) ? target : value;
}

function relativeDistance(current: number, target: number) {
  return Math.abs(current - target) / Math.max(1, Math.abs(current), Math.abs(target));
}

function aggregationStorageKey(workspaceId: string) {
  return `bt:chart-docked-depth-ladder:agg:${workspaceId}`;
}

function viewModeStorageKey(workspaceId: string) {
  return `bt:chart-docked-depth-ladder:view:v2:${workspaceId}`;
}

function readAggregation(workspaceId: string) {
  const stored = Number(localStorage.getItem(aggregationStorageKey(workspaceId)));
  return AGGREGATION_OPTIONS.includes(stored) ? stored : 20;
}

function readViewMode(workspaceId: string): DepthViewMode {
  const stored = localStorage.getItem(viewModeStorageKey(workspaceId));
  return stored === "range" || stored === "book" ? stored : "chart";
}

function buildBufferedRequestViewport(viewport: ChartPriceTransformSnapshot): ChartPriceTransformSnapshot {
  const minimumPrice = Math.max(1e-9, Math.floor(viewport.priceMin / CONSOLIDATED_QUERY_BUCKET_USD) * CONSOLIDATED_QUERY_BUCKET_USD);
  return {
    ...viewport,
    priceMin: minimumPrice,
    priceMax: minimumPrice + (viewport.priceMax - viewport.priceMin) + CONSOLIDATED_QUERY_BUFFER_USD
  };
}

function formatPrice(value: number | null, decimals: number) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatCompact(value: number) {
  const absolute = Math.abs(value);
  if (!Number.isFinite(value)) return "—";
  if (absolute >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (absolute >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${trim(value / 1_000)}K`;
  if (absolute >= 10) return trim(value);
  if (absolute >= 1) return value.toFixed(2).replace(/\.00$/, "");
  return absolute === 0 ? "0" : value.toPrecision(3);
}

function formatSignedCompact(value: number) {
  if (Math.abs(value) <= 1e-12) return "0";
  return `${value > 0 ? "+" : "−"}${formatCompact(Math.abs(value))}`;
}

function trim(value: number) {
  return Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
