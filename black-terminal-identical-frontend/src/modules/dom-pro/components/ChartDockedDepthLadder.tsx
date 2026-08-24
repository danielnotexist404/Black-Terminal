import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { Crosshair, Lock, X } from "lucide-react";
import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { MarketSymbol } from "../../../market-data/types";
import { blackCorePerformanceMonitor } from "../../../performance/performanceMonitor";
import type { LiquidationFieldRuntimeStatus, LiquidationFieldSnapshot } from "../../liquidation-field/core/types";
import {
  CHART_DOCKED_DEPTH_FOLLOW_SPAN_USD,
  buildStableLiquidityProjection,
  buildChartSynchronizedViewport,
  buildChartDockedDepthLadder,
  buildPriceFollowingViewport,
  fitViewportToDeliveredBook,
  resolveChartDockedProjectionRowCount,
  resolveLiquiditySignificance,
  translateChartViewportToDock,
  type ChartDockedDepthLadderModel,
  type ChartDockedDepthRow,
  type ChartDockedDepthScaleMode
} from "../chartDockedDepthLadderModel";
import { blackCoreChartPriceViewportStore } from "../chartPriceViewportStore";
import { useConsolidatedLiquidityFeed } from "../consolidatedLiquidityClient";
import { ProfessionalDomLadderTracker } from "../domProfessionalLadder";
import {
  buildCumulativeLiquidationPressureBand,
  buildLiquidationPressureProfile,
  fitViewportToLiquidationProfile,
  resolveLiquidationNodeWidthRatio,
  type LiquidationPressureProfileModel,
  type LiquidationPressureProfileRow
} from "../liquidationPressureProfileModel";
import "../chartDockedDepthLadder.css";

type ChartDockedDepthLadderProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  viewportKey: string;
  workspaceId: string;
  liquidationSnapshot: LiquidationFieldSnapshot | null;
  liquidationStatus: LiquidationFieldRuntimeStatus;
  onLiquidationProfileDemandChange: (requested: boolean) => void;
  onClose: () => void;
};

type CanvasSize = { width: number; height: number };
type VisualRow = { bid: number; ask: number; delta: number; depth: number; activity: number };
type LiquidationVisualRow = { long: number; short: number; total: number; intensity: number; confidence: number; confirmed: number };
type HoverState =
  | { mode: "dom"; row: ChartDockedDepthRow; x: number; y: number }
  | { mode: "lpp"; row: LiquidationPressureProfileRow; x: number; y: number }
  | null;
type DepthViewMode = "chart" | "range" | "book";
type LadderProfileMode = "dom" | "lpp";

const AGGREGATION_OPTIONS = [1, 5, 10, 20, 50, 100];
const SMOOTHING_TAU_MS = 82;
const LADDER_DATA_TOP_PX = 38;
const LADDER_FOOTER_HEIGHT_PX = 26;
const EPSILON = 1e-12;

export function ChartDockedDepthLadder({
  marketSymbol,
  lastPrice,
  viewportKey,
  workspaceId,
  liquidationSnapshot,
  liquidationStatus,
  onLiquidationProfileDemandChange,
  onClose
}: ChartDockedDepthLadderProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef(new ProfessionalDomLadderTracker());
  const animationRef = useRef<{ raf: number | null; lastAt: number; revision: number; rows: VisualRow[] }>({ raf: null, lastAt: 0, revision: -1, rows: [] });
  const liquidationAnimationRef = useRef<{ raf: number | null; lastAt: number; revision: string; rows: LiquidationVisualRow[] }>({ raf: null, lastAt: 0, revision: "", rows: [] });
  const latestModelRef = useRef<ChartDockedDepthLadderModel | null>(null);
  const latestLiquidationModelRef = useRef<LiquidationPressureProfileModel | null>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 320, height: 600 });
  const [chartOriginOffsetY, setChartOriginOffsetY] = useState(0);
  const [hover, setHover] = useState<HoverState>(null);
  const [aggregationTicks, setAggregationTicks] = useState(() => readAggregation(workspaceId));
  const [viewMode, setViewMode] = useState<DepthViewMode>(() => readViewMode(workspaceId));
  const [profileMode, setProfileMode] = useState<LadderProfileMode>(() => readProfileMode(workspaceId));
  const [lockedViewport, setLockedViewport] = useState<ChartPriceTransformSnapshot | null>(null);
  const liquidationSnapshotForSymbol = useMemo(() => liquidationSnapshot
    && normalizeLppSymbol(liquidationSnapshot.header.symbol) === normalizeLppSymbol(`${marketSymbol.baseAsset}USDT`)
    ? liquidationSnapshot
    : null, [liquidationSnapshot, marketSymbol.baseAsset]);
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
  const requestViewport = lockedViewport ?? selectedLiveViewport;
  const requestedRows = requestViewport
    ? resolveChartDockedProjectionRowCount(requestViewport.plotBottom - requestViewport.plotTop, aggregationTicks)
    : 80;
  const requestProjection = useMemo(() => requestViewport
    ? buildStableLiquidityProjection(requestViewport, requestedRows)
    : null, [requestViewport, requestedRows]);
  const consolidated = useConsolidatedLiquidityFeed({
    baseAsset: marketSymbol.baseAsset,
    minimumPrice: requestProjection?.minimumPrice ?? 0,
    maximumPrice: requestProjection?.maximumPrice ?? 0,
    rowCount: requestProjection?.rowCount ?? requestedRows,
    priceStep: requestProjection?.priceStep ?? 0,
    enabled: profileMode === "dom" && Boolean(requestProjection)
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
    localStorage.setItem(profileModeStorageKey(workspaceId), profileMode);
    setLockedViewport(null);
    setHover(null);
    onLiquidationProfileDemandChange(profileMode === "lpp");
    return () => onLiquidationProfileDemandChange(false);
  }, [onLiquidationProfileDemandChange, profileMode, workspaceId]);

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
      ? profileMode === "lpp" && liquidationSnapshotForSymbol
        ? fitViewportToLiquidationProfile(selectedLiveViewport, liquidationSnapshotForSymbol)
        : fitViewportToDeliveredBook(selectedLiveViewport, professionalDepth)
      : selectedLiveViewport;
  }, [liquidationSnapshotForSymbol, professionalDepth, profileMode, selectedLiveViewport, viewMode]);
  const effectiveViewport = lockedViewport ?? unlockedViewport;
  const scaleMode: ChartDockedDepthScaleMode = lockedViewport ? "locked" : viewMode === "book" ? "book" : viewMode === "chart" ? "chart" : "follow";

  const model = useMemo(() => profileMode === "dom" && effectiveViewport ? buildChartDockedDepthLadder({
    depth: professionalDepth,
    viewport: effectiveViewport,
    preferredRowHeight: 13,
    maximumRows: 180,
    scaleMode
  }) : null, [effectiveViewport, professionalDepth, profileMode, scaleMode]);
  latestModelRef.current = model;

  const liquidationModel = useMemo(() => profileMode === "lpp" && effectiveViewport && liquidationSnapshotForSymbol
    ? buildLiquidationPressureProfile({
        snapshot: liquidationSnapshotForSymbol,
        viewport: effectiveViewport,
        currentPrice: lastPrice,
        maximumRows: 180
      })
    : null, [effectiveViewport, lastPrice, liquidationSnapshotForSymbol, profileMode]);
  latestLiquidationModelRef.current = liquidationModel;

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !liquidationModel || !liquidationSnapshotForSymbol) return;
    const state = liquidationAnimationRef.current;
    const revision = `${liquidationModel.viewportRevision}:${liquidationModel.rows.length}:${liquidationModel.priceStep}:${liquidationModel.priceMin}:${liquidationModel.priceMax}`;
    const targetRows = liquidationModel.rows.map(toLiquidationVisualRow);
    if (state.revision !== revision || state.rows.length !== targetRows.length) {
      state.rows = targetRows;
      state.revision = revision;
      state.lastAt = performance.now();
      drawLiquidationPressureProfile(canvas, size, liquidationModel, state.rows, marketSymbol.quoteAsset);
      return;
    }

    if (state.raf !== null) cancelAnimationFrame(state.raf);
    state.lastAt = performance.now();
    const animate = (now: number) => {
      const activeModel = latestLiquidationModelRef.current;
      if (!activeModel || activeModel.rows.length !== state.rows.length) {
        state.raf = null;
        return;
      }
      const elapsed = Math.min(64, Math.max(1, now - state.lastAt));
      state.lastAt = now;
      const alpha = 1 - Math.exp(-elapsed / 118);
      let remaining = 0;
      activeModel.rows.forEach((row, index) => {
        const visual = state.rows[index];
        const target = toLiquidationVisualRow(row);
        visual.long = approach(visual.long, target.long, alpha);
        visual.short = approach(visual.short, target.short, alpha);
        visual.total = approach(visual.total, target.total, alpha);
        visual.intensity = approach(visual.intensity, target.intensity, alpha);
        visual.confidence = approach(visual.confidence, target.confidence, alpha);
        visual.confirmed = approach(visual.confirmed, target.confirmed, alpha);
        remaining = Math.max(
          remaining,
          relativeDistance(visual.long, target.long),
          relativeDistance(visual.short, target.short),
          relativeDistance(visual.total, target.total),
          Math.abs(visual.intensity - target.intensity),
          Math.abs(visual.confidence - target.confidence)
        );
      });
      const startedAt = performance.now();
      drawLiquidationPressureProfile(canvas, size, activeModel, state.rows, marketSymbol.quoteAsset);
      blackCorePerformanceMonitor.recordMetric("chart_docked_lpp.canvas_frame_ms", performance.now() - startedAt, "ms", { symbol: marketSymbol.rawSymbol });
      if (remaining > 0.002 && document.visibilityState === "visible") state.raf = requestAnimationFrame(animate);
      else {
        state.rows = activeModel.rows.map(toLiquidationVisualRow);
        drawLiquidationPressureProfile(canvas, size, activeModel, state.rows, marketSymbol.quoteAsset);
        state.raf = null;
      }
    };
    state.raf = requestAnimationFrame(animate);
    return () => {
      if (state.raf !== null) cancelAnimationFrame(state.raf);
      state.raf = null;
    };
  }, [liquidationModel, liquidationSnapshotForSymbol, marketSymbol.quoteAsset, marketSymbol.rawSymbol, size]);

  useEffect(() => () => {
    if (animationRef.current.raf !== null) cancelAnimationFrame(animationRef.current.raf);
    if (liquidationAnimationRef.current.raf !== null) cancelAnimationFrame(liquidationAnimationRef.current.raf);
  }, []);

  function handlePointerMove(event: ReactMouseEvent<HTMLCanvasElement>) {
    const activeModel = profileMode === "lpp" ? liquidationModel : model;
    if (!activeModel) return setHover(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - bounds.top;
    if (y < activeModel.plotTop || y > activeModel.plotBottom) return setHover(null);
    const row = activeModel.rows.find((candidate) => y >= candidate.top && y <= candidate.top + candidate.height);
    if (!row) return setHover(null);
    const x = Math.min(bounds.width - 150, Math.max(8, event.clientX - bounds.left + 10));
    const tooltipHeight = profileMode === "lpp" ? 164 : 108;
    const tooltipY = Math.min(bounds.height - tooltipHeight, Math.max(42, y + 8));
    if (profileMode === "lpp") setHover({ mode: "lpp", row: row as LiquidationPressureProfileRow, x, y: tooltipY });
    else setHover({ mode: "dom", row: row as ChartDockedDepthRow, x, y: tooltipY });
  }

  const sourceDepth = professionalDepth.subscribedDepth ?? Math.max(professionalDepth.bidLevels, professionalDepth.askLevels);
  const status = profileMode === "lpp"
    ? `BCLIF ${liquidationStatus.state} · ${liquidationStatus.authority ?? liquidationSnapshotForSymbol?.authority ?? "RESOLVING"}`
    : `CLF ${consolidated.status.toUpperCase()} ${consolidated.snapshot?.includedVenues.length ?? 0}V`;
  const activeModel = profileMode === "lpp" ? liquidationModel : model;

  return (
    <aside
      ref={rootRef}
      className={`chart-docked-depth-ladder chart-docked-depth-ladder--${profileMode} chart-docked-depth-ladder--${profileMode === "lpp" ? liquidationStatus.state.toLowerCase() : professionalDepth.state}`}
      data-chart-docked-depth-ladder="true"
      data-viewport-revision={effectiveViewport?.revision ?? -1}
      data-subscribed-depth={sourceDepth}
      data-depth-scale-mode={scaleMode}
      data-depth-view-mode={viewMode}
      data-profile-mode={profileMode}
    >
      <header className="chart-docked-depth-toolbar">
        <div className="chart-docked-depth-mode" role="group" aria-label="Ladder profile mode">
          <button type="button" className={profileMode === "dom" ? "active" : ""} onClick={() => setProfileMode("dom")} aria-pressed={profileMode === "dom"} title="Aggregated multi-venue resting limit-order depth">DOM</button>
          <button type="button" className={profileMode === "lpp" ? "active" : ""} onClick={() => setProfileMode("lpp")} aria-pressed={profileMode === "lpp"} title="Liquidation Pressure Profile: calibrated modeled forced-liquidation exposure">LPP</button>
        </div>
        <button
          type="button"
          className="chart-docked-depth-scale"
          onClick={() => setLockedViewport((current) => current ? null : effectiveViewport ? { ...effectiveViewport } : null)}
          title={scaleMode === "locked"
            ? "Price scale is frozen. Click to resume the selected live range mode."
            : "Freeze the ladder's current price range while keeping live depth updates active."}
          aria-label={`${profileMode === "lpp" ? "Liquidation profile" : "Depth"} scale: ${scaleMode === "locked" ? "scale locked" : viewMode === "book" ? profileMode === "lpp" ? "model fit live" : "book fit live" : viewMode === "chart" ? "chart synchronized" : "26 thousand dollar independent overview"}`}
        >
          {scaleMode === "locked" ? <Lock size={10} /> : <Crosshair size={10} />}
          {scaleMode === "locked" ? "LOCKED" : viewMode === "book" ? profileMode === "lpp" ? "MODEL FIT" : "BOOK LIVE" : viewMode === "chart" ? "CHART SYNC" : "26K OVERVIEW"}
        </button>
        <label className="chart-docked-depth-view" title={profileMode === "lpp" ? "CHART preserves chart confluence. 26K OVERVIEW follows price. MODEL FIT exposes the full BCLIF absolute liquidation-price envelope." : "CHART preserves exact confluence. 26K OVERVIEW is an intentionally independent fixed-range overview. BOOK FIT shows all delivered depth."}>
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
            <option value="range">26K OVERVIEW</option>
            <option value="book">{profileMode === "lpp" ? "MODEL FIT" : "BOOK FIT"}</option>
          </select>
        </label>
        <label title={profileMode === "lpp" ? "Control BCLIF absolute price-bin density. Higher aggregation joins adjacent modeled exposure rows and emphasizes major liquidation-pressure nodes." : "Control consolidated canonical price-bin density. Higher aggregation suppresses ordinary book noise and emphasizes larger structural levels."}>
          AGG:
          <select value={aggregationTicks} onChange={(event) => setAggregationTicks(Number(event.target.value))}>
            {AGGREGATION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <em>{status} · {sourceDepth || "—"}×2</em>
        <button type="button" onClick={onClose} title="Close full-book ladder" aria-label="Close full-book ladder"><X size={12} /></button>
      </header>
      <div className="chart-docked-depth-columns" aria-hidden="true">
        {profileMode === "lpp"
          ? <><span>TOTAL</span><span>LONG LIQ</span><span>SHORT LIQ</span><span>PRICE</span><span>PRESSURE</span></>
          : <><span>SUM</span><span>SIZE</span><span>DELTA</span><span>PRICE</span><span>DEPTH</span></>}
      </div>
      <canvas
        ref={canvasRef}
        className="chart-docked-depth-canvas"
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHover(null)}
        aria-label={profileMode === "lpp" ? `${marketSymbol.rawSymbol} calibrated liquidation pressure profile` : `${marketSymbol.rawSymbol} chart-synchronized full delivered order book`}
      />
      {!effectiveViewport && <div className="chart-docked-depth-awaiting">SYNCHRONIZING FULL-RANGE PRICE SCALE</div>}
      {profileMode === "lpp" && !liquidationModel && effectiveViewport && (
        <div className="chart-docked-depth-awaiting chart-docked-depth-awaiting--lpp">
          <strong>{liquidationStatus.state === "UNAVAILABLE" || liquidationStatus.state === "ERROR" ? "LPP UNAVAILABLE" : "CALIBRATING LIQUIDATION PRESSURE"}</strong>
          <span>{liquidationStatus.message}</span>
        </div>
      )}
      {hover?.mode === "dom" && <DepthTooltip hover={hover} quoteAsset={marketSymbol.quoteAsset} />}
      {hover?.mode === "lpp" && <LiquidationPressureTooltip hover={hover} quoteAsset={marketSymbol.quoteAsset} authority={liquidationSnapshotForSymbol?.authority ?? null} />}
      <footer className="chart-docked-depth-footer">
        <span>{profileMode === "lpp" ? `BYBIT BCLIF ${marketSymbol.rawSymbol}` : `${consolidated.snapshot ? consolidated.snapshot.includedVenues.map((venue) => venue.venue.toUpperCase()).join("+") : "MULTI-VENUE CLF"} ${marketSymbol.rawSymbol}`}</span>
        <span>{activeModel ? `${formatPrice(activeModel.priceMin, activeModel.priceDecimals)}—${formatPrice(activeModel.priceMax, activeModel.priceDecimals)} · ${formatCompact(activeModel.priceSpan)}` : "—"}</span>
        <span>{activeModel ? `${activeModel.hiddenAboveCount}↑ ${activeModel.hiddenBelowCount}↓` : "—"}</span>
        <b>{profileMode === "lpp"
          ? `${liquidationSnapshotForSymbol?.certainty ?? "ESTIMATED"} · MODELED LIQUIDATION EXPOSURE · NOT RESTING ORDERS`
          : `${consolidated.snapshot ? `${Math.round(consolidated.snapshot.coverageRatio * 100)}% VIEWPORT COVERAGE · ` : ""}VISIBLE RESTING LIMIT DEPTH · HIDDEN/RPI EXCLUDED`}</b>
      </footer>
    </aside>
  );
}

function DepthTooltip({ hover, quoteAsset }: { hover: Extract<Exclude<HoverState, null>, { mode: "dom" }>; quoteAsset: string }) {
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

function LiquidationPressureTooltip({
  hover,
  quoteAsset,
  authority
}: {
  hover: Extract<Exclude<HoverState, null>, { mode: "lpp" }>;
  quoteAsset: string;
  authority: LiquidationFieldSnapshot["authority"] | null;
}) {
  const { row } = hover;
  const lifecycle = row.lifecycle;
  return (
    <div className="chart-docked-depth-tooltip chart-docked-depth-tooltip--lpp" style={{ left: hover.x, top: hover.y }}>
      <strong>{formatPrice(row.price, 2)} {quoteAsset} · {row.isExtreme ? "EXTREME NODE" : row.isHeavy ? "HEAVY NODE" : "PRESSURE ROW"}</strong>
      <span>EXPOSURE STATE <b className={`lifecycle lifecycle--${lifecycle.state.toLowerCase()}`}>{liquidationLifecycleLabel(lifecycle.state)}</b></span>
      <span>LONG LIQ / FORCED SELL <b className="ask">{formatCompact(row.longExposure)}</b></span>
      <span>SHORT LIQ / FORCED BUY <b className="bid">{formatCompact(row.shortExposure)}</b></span>
      <span>TOTAL MODELED <b>{formatCompact(row.totalExposure)}</b></span>
      <span>CONFIDENCE <b>{row.confidence.toFixed(0)}%</b></span>
      <span>PERSISTENCE / SURVIVAL <b>{formatPercent(lifecycle.persistence)} · {formatPercent(lifecycle.survivalRatio)}</b></span>
      <span>RECENT PEAK / PRIOR <b>{formatCompact(lifecycle.recentPeakExposure)} · {formatCompact(lifecycle.priorExposure)}</b></span>
      <span>OBSERVED CELL PEAK <b>{formatCompact(lifecycle.observedNotional)} · {lifecycle.observedCount}</b></span>
      <em>{liquidationLifecycleEvidenceNote(lifecycle.state)}</em>
      <em>{authority ?? "RESOLVING AUTHORITY"} · ESTIMATED EXPOSURE, NOT VISIBLE ORDERS</em>
    </div>
  );
}

function drawLiquidationPressureProfile(
  canvas: HTMLCanvasElement,
  size: CanvasSize,
  model: LiquidationPressureProfileModel,
  visualRows: LiquidationVisualRow[],
  quoteAsset: string
) {
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

  const columns = [0, size.width * 0.15, size.width * 0.30, size.width * 0.45, size.width * 0.62, size.width];
  const profileLeft = columns[4];
  const profileRight = size.width - 7;
  const profileWidth = Math.max(1, profileRight - profileLeft);
  const longGradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  longGradient.addColorStop(0, "rgba(68,0,11,0.12)");
  longGradient.addColorStop(0.62, "rgba(152,0,24,0.62)");
  longGradient.addColorStop(1, "rgba(255,18,48,0.98)");
  const shortGradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  shortGradient.addColorStop(0, "rgba(82,87,96,0.10)");
  shortGradient.addColorStop(0.62, "rgba(190,196,205,0.64)");
  shortGradient.addColorStop(1, "rgba(255,255,255,0.98)");
  const depletedGradient = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  depletedGradient.addColorStop(0, "rgba(50,53,59,0.08)");
  depletedGradient.addColorStop(0.62, "rgba(92,97,106,0.44)");
  depletedGradient.addColorStop(1, "rgba(153,158,167,0.78)");
  context.font = '700 7px "IBM Plex Mono", monospace';
  context.textBaseline = "middle";
  context.lineWidth = 1;

  model.rows.forEach((row, index) => {
    const visual = visualRows[index] ?? toLiquidationVisualRow(row);
    const y = row.top;
    const height = row.height;
    const total = Math.max(EPSILON, visual.total);
    const longShare = Math.max(0, visual.long / total);
    const shortShare = Math.max(0, visual.short / total);
    const confidence = Math.max(0, Math.min(1, visual.confidence / 100));
    const lifecycleAlpha = liquidationLifecycleOpacity(row.lifecycle.state);
    const depleted = row.lifecycle.state === "ABSORBED" || row.lifecycle.state === "EXHAUSTED";
    const backgroundAlpha = visual.total > EPSILON
      ? (0.018 + visual.intensity * 0.085) * (0.35 + confidence * 0.65) * lifecycleAlpha
      : 0;
    context.fillStyle = depleted
      ? `rgba(112,117,125,${backgroundAlpha * 0.7})`
      : row.side === "long"
        ? `rgba(105,0,18,${backgroundAlpha})`
        : row.side === "short"
          ? `rgba(224,228,234,${backgroundAlpha * 0.55})`
          : `rgba(116,70,78,${backgroundAlpha * 0.65})`;
    context.fillRect(0, y, size.width, height);

    context.strokeStyle = "rgba(255,255,255,0.035)";
    context.beginPath();
    context.moveTo(0, y + height);
    context.lineTo(size.width, y + height);
    context.stroke();

    if (visual.total > EPSILON) {
      const longWidth = profileWidth * resolveLiquidationNodeWidthRatio(visual.intensity, longShare, row.isHeavy, row.isExtreme);
      const shortWidth = profileWidth * resolveLiquidationNodeWidthRatio(visual.intensity, shortShare, row.isHeavy, row.isExtreme);
      const bothSides = visual.long > EPSILON && visual.short > EPSILON;
      const splitHeight = bothSides ? Math.max(1, (height - 2) / 2) : Math.max(1, height - 2);
      context.save();
      context.globalAlpha = (0.25 + confidence * 0.75) * lifecycleAlpha;
      if (longWidth > 0.5) {
        context.fillStyle = depleted ? depletedGradient : longGradient;
        context.shadowColor = liquidationLifecycleNodeColor(row.lifecycle.state, "long", 0.85);
        context.shadowBlur = (row.isExtreme ? 16 : row.isHeavy ? 10 : 2) * lifecycleAlpha;
        context.fillRect(profileRight - longWidth, y + 1, longWidth, splitHeight);
        if (row.isHeavy) {
          context.fillStyle = liquidationLifecycleNodeColor(row.lifecycle.state, "long", row.isExtreme ? 0.98 : 0.9);
          context.fillRect(profileRight - longWidth, y + 1, row.isExtreme ? 2 : 1, splitHeight);
        }
      }
      if (shortWidth > 0.5) {
        context.fillStyle = depleted ? depletedGradient : shortGradient;
        context.shadowColor = liquidationLifecycleNodeColor(row.lifecycle.state, "short", 0.72);
        context.shadowBlur = (row.isExtreme ? 15 : row.isHeavy ? 9 : 2) * lifecycleAlpha;
        context.fillRect(profileRight - shortWidth, y + (bothSides ? 1 + splitHeight : 1), shortWidth, splitHeight);
        if (row.isHeavy) {
          context.fillStyle = liquidationLifecycleNodeColor(row.lifecycle.state, "short", row.isExtreme ? 1 : 0.94);
          context.fillRect(profileRight - shortWidth, y + (bothSides ? 1 + splitHeight : 1), row.isExtreme ? 2 : 1, splitHeight);
        }
      }
      context.restore();

      const nodeAlpha = Math.min(1, 0.12 + visual.intensity * 0.7 + confidence * 0.18);
      const nodeHeight = Math.max(1, (height - 2) * (0.2 + visual.intensity * 0.8));
      context.save();
      context.globalAlpha = lifecycleAlpha;
      context.shadowBlur = (row.isExtreme ? 15 : row.isHeavy ? 9 : 4) * lifecycleAlpha;
      context.shadowColor = liquidationLifecycleNodeColor(row.lifecycle.state, row.side === "long" ? "long" : "short", 0.96);
      context.fillStyle = liquidationLifecycleNodeColor(row.lifecycle.state, row.side === "long" ? "long" : "short", nodeAlpha);
      context.fillRect(size.width - 7, y + (height - nodeHeight) / 2, row.isExtreme ? 6 : 5, nodeHeight);
      context.restore();
      if (row.isHeavy) {
        context.fillStyle = liquidationLifecycleNodeColor(row.lifecycle.state, row.side === "long" ? "long" : "short", 1);
        context.fillRect(1, y + 1, row.isExtreme ? 3 : 2, Math.max(1, height - 2));
      }
      if (visual.confirmed > EPSILON) {
        context.save();
        context.strokeStyle = "rgba(255,255,255,0.88)";
        context.shadowBlur = 8;
        context.shadowColor = "rgba(255,255,255,0.72)";
        context.beginPath();
        context.arc(profileRight - Math.max(longWidth, shortWidth), y + height / 2, row.isExtreme ? 2.5 : 1.7, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }
    }

    if (row.lifecycle.state !== "EMPTY") {
      context.fillStyle = liquidationLifecycleNodeColor(row.lifecycle.state, row.side === "long" ? "long" : "short", 0.92);
      context.fillRect(columns[3] + 2, y + Math.max(1, height / 2 - 0.5), row.lifecycle.state === "STRENGTHENING" ? 5 : 3, 1);
    }

    drawRightText(context, visual.total > EPSILON ? formatCompact(visual.total) : "·", columns[1] - 4, y + height / 2, "#b5bbc4");
    drawRightText(context, visual.long > EPSILON ? formatCompact(visual.long) : "·", columns[2] - 4, y + height / 2, "#ff1c39");
    drawRightText(context, visual.short > EPSILON ? formatCompact(visual.short) : "·", columns[3] - 4, y + height / 2, "#f2f4f7");
    drawRightText(context, formatPrice(row.price, model.priceDecimals), columns[4] - 5, y + height / 2, row.isCurrentPrice ? "#ffffff" : "#d7dbe1");
  });

  drawCumulativeLiquidationPressureBand(context, model, visualRows, profileLeft, profileRight, "long");
  drawCumulativeLiquidationPressureBand(context, model, visualRows, profileLeft, profileRight, "short");

  for (let index = 1; index < columns.length - 1; index += 1) {
    context.strokeStyle = "rgba(255,255,255,0.075)";
    context.beginPath();
    context.moveTo(columns[index], model.plotTop);
    context.lineTo(columns[index], model.plotBottom);
    context.stroke();
  }

  if (model.currentPriceY !== null) {
    context.save();
    context.strokeStyle = "rgba(255,25,52,0.96)";
    context.shadowBlur = 6;
    context.shadowColor = "rgba(255,0,30,0.78)";
    context.beginPath();
    context.moveTo(0, model.currentPriceY);
    context.lineTo(size.width, model.currentPriceY);
    context.stroke();
    context.restore();
  }

  context.fillStyle = "rgba(132,139,150,0.58)";
  context.font = '700 6px "IBM Plex Mono", monospace';
  context.textAlign = "left";
  context.fillText(`${quoteAsset} · BCLIF LPP · ${model.authority} · ${model.certainty}`, 5, Math.min(size.height - 8, model.plotBottom + 13));
}

function liquidationLifecycleLabel(state: LiquidationPressureProfileRow["lifecycle"]["state"]) {
  if (state === "FORMING") return "FRESH / FORMING";
  if (state === "STRENGTHENING") return "REPLENISHING";
  if (state === "TRIGGERED") return "TESTED / TRIGGERED";
  return state;
}

function liquidationLifecycleEvidenceNote(state: LiquidationPressureProfileRow["lifecycle"]["state"]) {
  if (state === "ABSORBED") return "CONFIRMED LIQUIDATION · RESIDUAL ≤25% OF RECENT PEAK";
  if (state === "EXHAUSTED") return "CONFIRMED LIQUIDATION · RESIDUAL ≤5% OF RECENT PEAK";
  if (state === "TRIGGERED") return "CONFIRMED LIQUIDATION OBSERVED · MATERIAL EXPOSURE REMAINS";
  if (state === "DECAYING") return "UNCONFIRMED CONTRACTION · NOT LABELED AS ABSORPTION";
  if (state === "FORMING") return "NEWLY FORMED INSIDE THE CAUSAL 24-COLUMN WINDOW";
  return "STATE DERIVED FROM CAUSAL EXPOSURE PERSISTENCE AND SURVIVAL";
}

function liquidationLifecycleOpacity(state: LiquidationPressureProfileRow["lifecycle"]["state"]) {
  if (state === "STRENGTHENING") return 1;
  if (state === "FORMING") return 0.92;
  if (state === "TRIGGERED") return 0.84;
  if (state === "DECAYING") return 0.58;
  if (state === "ABSORBED") return 0.46;
  if (state === "EXHAUSTED") return 0.28;
  if (state === "EMPTY") return 0;
  return 0.76;
}

function liquidationLifecycleNodeColor(
  state: LiquidationPressureProfileRow["lifecycle"]["state"],
  side: "long" | "short",
  alpha: number
) {
  const boundedAlpha = Math.max(0, Math.min(1, alpha));
  if (state === "ABSORBED") return `rgba(130,136,145,${boundedAlpha})`;
  if (state === "EXHAUSTED") return `rgba(73,78,86,${boundedAlpha})`;
  if (side === "short") {
    if (state === "DECAYING") return `rgba(154,160,169,${boundedAlpha})`;
    if (state === "FORMING" || state === "STRENGTHENING") return `rgba(255,255,255,${boundedAlpha})`;
    return `rgba(239,243,248,${boundedAlpha})`;
  }
  if (state === "DECAYING") return `rgba(111,15,31,${boundedAlpha})`;
  if (state === "FORMING") return `rgba(255,72,94,${boundedAlpha})`;
  if (state === "STRENGTHENING") return `rgba(255,10,42,${boundedAlpha})`;
  if (state === "TRIGGERED") return `rgba(207,29,55,${boundedAlpha})`;
  return `rgba(255,24,52,${boundedAlpha})`;
}

function drawCumulativeLiquidationPressureBand(
  context: CanvasRenderingContext2D,
  model: LiquidationPressureProfileModel,
  visualRows: LiquidationVisualRow[],
  profileLeft: number,
  profileRight: number,
  side: "long" | "short"
) {
  const band = buildCumulativeLiquidationPressureBand(
    model,
    side,
    visualRows.map((row) => side === "long" ? row.long : row.short)
  );
  if (band.length < 2) return;
  const profileWidth = Math.max(1, profileRight - profileLeft);
  const points = band.map((point) => {
    const row = model.rows[point.rowIndex]!;
    return {
      x: profileRight - Math.pow(point.ratio, 0.56) * profileWidth * 0.97,
      y: row.top + row.height / 2
    };
  });
  context.save();
  context.beginPath();
  context.moveTo(profileRight, points[0]!.y);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(profileRight, points.at(-1)!.y);
  context.closePath();
  const fill = context.createLinearGradient(profileLeft, 0, profileRight, 0);
  if (side === "long") {
    fill.addColorStop(0, "rgba(123,0,20,0.06)");
    fill.addColorStop(0.68, "rgba(210,0,34,0.13)");
    fill.addColorStop(1, "rgba(255,17,47,0.22)");
  } else {
    fill.addColorStop(0, "rgba(151,157,166,0.05)");
    fill.addColorStop(0.68, "rgba(225,229,235,0.11)");
    fill.addColorStop(1, "rgba(255,255,255,0.19)");
  }
  context.fillStyle = fill;
  context.fill();

  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
  context.strokeStyle = side === "long" ? "rgba(255,23,52,0.94)" : "rgba(239,243,248,0.92)";
  context.shadowColor = side === "long" ? "rgba(255,0,35,0.82)" : "rgba(255,255,255,0.62)";
  context.shadowBlur = 7;
  context.lineWidth = 1.2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
  context.restore();
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
    const askRatio = resolveLiquiditySignificance(visual.ask, model.askNoiseFloor, model.askDepthReference);
    const bidRatio = resolveLiquiditySignificance(visual.bid, model.bidNoiseFloor, model.bidDepthReference);
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
      const nodeAlpha = Math.min(1, 0.07 + visual.depth * 0.72 + visual.activity * 0.21);
      context.save();
      context.shadowBlur = 3 + visual.depth * 4 + visual.activity * 9;
      context.shadowColor = row.side === "ask" ? "rgba(255,0,32,0.9)" : "rgba(255,255,255,0.82)";
      context.fillStyle = row.side === "ask" ? `rgba(255,24,52,${nodeAlpha})` : `rgba(245,247,250,${nodeAlpha})`;
      const nodeHeight = Math.max(1, (height - 2) * (0.18 + visual.depth * 0.82));
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
  const scaleLabel = model.scaleMode === "chart" ? "CLF CHART-SYNC" : model.scaleMode === "follow" ? "CLF 26K-OVERVIEW" : model.scaleMode === "book" ? "CLF BOOK-FIT" : "CLF SCALE-LOCKED";
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
  const deliveredTotal = side === "ask" ? model.sourceAskSize : model.sourceBidSize;
  const maximum = Math.max(deliveredTotal, points.at(-1)?.cumulative ?? 0);
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

function toLiquidationVisualRow(row: LiquidationPressureProfileRow): LiquidationVisualRow {
  return {
    long: row.longExposure,
    short: row.shortExposure,
    total: row.totalExposure,
    intensity: row.intensity,
    confidence: row.confidence,
    confirmed: row.confirmedNotional
  };
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
  return `bt:chart-docked-depth-ladder:view:v3:${workspaceId}`;
}

function profileModeStorageKey(workspaceId: string) {
  return `bt:chart-docked-depth-ladder:profile:v1:${workspaceId}`;
}

function readAggregation(workspaceId: string) {
  const stored = Number(localStorage.getItem(aggregationStorageKey(workspaceId)));
  return AGGREGATION_OPTIONS.includes(stored) ? stored : 20;
}

function readViewMode(workspaceId: string): DepthViewMode {
  const stored = localStorage.getItem(viewModeStorageKey(workspaceId));
  return stored === "range" || stored === "book" ? stored : "chart";
}

function readProfileMode(workspaceId: string): LadderProfileMode {
  return localStorage.getItem(profileModeStorageKey(workspaceId)) === "lpp" ? "lpp" : "dom";
}

function normalizeLppSymbol(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function formatPrice(value: number | null, decimals: number) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPercent(value: number) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "—";
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
