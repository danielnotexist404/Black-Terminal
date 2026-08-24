import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent } from "react";
import type { ChartPriceTransformSnapshot } from "../../../chart-engine/priceTransform";
import type { DomLadderDisplayUnit } from "../domLadderModel";
import { resolveProfessionalDomNodeMotion, type ProfessionalDomLadderModel, type ProfessionalDomRow } from "../domProfessionalLadder";
import { buildChartDockedDepthLadder, type ChartDockedDepthRow } from "../chartDockedDepthLadderModel";
import { domPriceToTopPct, type DomProPriceCamera } from "../domPriceCamera";
import "../domProfessionalLadder.css";

type DomProfessionalLadderProps = {
  model: ProfessionalDomLadderModel;
  baseAsset: string;
  quoteAsset: string;
  displayUnit: DomLadderDisplayUnit;
  maximumVisibleRows: number;
  aggregationTicks: number;
  autoCenter: boolean;
  showWallConfluence: boolean;
  onAggregationChange: (value: number) => void;
  onAutoCenterChange: (value: boolean) => void;
  synchronizedCamera?: DomProPriceCamera;
  synchronizedCursorPrice?: number | null;
  onSynchronizedWheel?: (event: WheelEvent<HTMLDivElement>) => void;
  onSynchronizedMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSynchronizedMouseMove?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSynchronizedMouseLeave?: () => void;
  onSynchronizedDoubleClick?: () => void;
};

const ROW_HEIGHT = 15;
const CHROME_HEIGHT = 70;
const AGGREGATION_OPTIONS = [1, 5, 10, 20, 50, 100];

export function DomProfessionalLadder({
  model,
  baseAsset,
  quoteAsset,
  displayUnit,
  maximumVisibleRows,
  aggregationTicks,
  autoCenter,
  showWallConfluence,
  onAggregationChange,
  onAutoCenterChange,
  synchronizedCamera,
  synchronizedCursorPrice,
  onSynchronizedWheel,
  onSynchronizedMouseDown,
  onSynchronizedMouseMove,
  onSynchronizedMouseLeave,
  onSynchronizedDoubleClick
}: DomProfessionalLadderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(420);
  const [manualOffset, setManualOffset] = useState(0);
  const viewportHeight = Math.max(80, height - CHROME_HEIGHT);
  const visibleRowCount = clamp(Math.floor(viewportHeight / ROW_HEIGHT), 8, clamp(Math.round(maximumVisibleRows), 8, 160));
  const currentIndex = useMemo(() => resolveCurrentIndex(model), [model]);
  const maximumStart = Math.max(0, model.rows.length - visibleRowCount);
  const centeredStart = clamp(currentIndex - Math.floor(visibleRowCount / 2), 0, maximumStart);
  const startIndex = clamp(centeredStart + manualOffset, 0, maximumStart);
  const synchronizedModel = useMemo(() => {
    if (!synchronizedCamera) return null;
    const viewport: ChartPriceTransformSnapshot = {
      revision: hashCameraVersion(synchronizedCamera.version),
      width: 1,
      height: viewportHeight,
      plotLeft: 0,
      plotRight: 1,
      plotTop: 0,
      plotBottom: viewportHeight,
      priceMin: synchronizedCamera.visiblePriceMin,
      priceMax: synchronizedCamera.visiblePriceMax,
      scaleMode: "linear",
      firstIndex: 0,
      lastIndex: 0
    };
    return buildChartDockedDepthLadder({
      depth: model,
      viewport,
      preferredRowHeight: ROW_HEIGHT,
      maximumRows: visibleRowCount,
      scaleMode: "chart"
    });
  }, [model, synchronizedCamera, viewportHeight, visibleRowCount]);
  const visibleRows = useMemo<RenderedProfessionalRow[]>(() => synchronizedModel
    ? synchronizedModel.rows.map((row) => adaptSynchronizedRow(row, model))
    : model.rows.slice(startIndex, startIndex + visibleRowCount).map((row, index) => ({ ...row, top: index * ROW_HEIGHT, height: ROW_HEIGHT })),
  [model, startIndex, synchronizedModel, visibleRowCount]);
  const outlineHeight = synchronizedModel?.plotBottom ?? Math.max(ROW_HEIGHT, visibleRows.length * ROW_HEIGHT);
  const unitLabel = displayUnit === "notional" ? quoteAsset : displayUnit === "contracts" ? "CONTRACTS" : baseAsset;

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setHeight(Math.max(140, element.getBoundingClientRect().height));
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (autoCenter) setManualOffset(0);
  }, [autoCenter, model.identity, visibleRowCount]);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (synchronizedCamera && onSynchronizedWheel) {
      onSynchronizedWheel(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const movement = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 36));
    if (autoCenter) onAutoCenterChange(false);
    setManualOffset((current) => clamp(current + movement, -centeredStart, maximumStart - centeredStart));
  }

  function centerOnMarket() {
    if (synchronizedCamera && onSynchronizedDoubleClick) {
      onSynchronizedDoubleClick();
      return;
    }
    setManualOffset(0);
    if (!autoCenter) onAutoCenterChange(true);
  }

  const askOutline = outlinePoints(visibleRows, "ask");
  const bidOutline = outlinePoints(visibleRows, "bid");

  return (
    <div
      ref={rootRef}
      className={`bt-pro-dom bt-pro-dom--${model.state}`}
      data-professional-dom="true"
      data-book-identity={model.identity}
      data-price-step={model.priceStep}
      data-visible-start={startIndex}
      data-visible-rows={visibleRows.length}
      data-synchronized-camera={synchronizedCamera?.version ?? "independent"}
      data-camera-version={synchronizedCamera?.version}
      data-camera-min={synchronizedCamera?.visiblePriceMin}
      data-camera-max={synchronizedCamera?.visiblePriceMax}
      data-bucket-size={synchronizedModel?.priceStep ?? model.priceStep}
      data-current-price-top={synchronizedCamera && model.currentPrice !== null ? domPriceToTopPct(synchronizedCamera, model.currentPrice) : undefined}
    >
      <div className="bt-pro-dom-toolbar">
        <b>DOM</b>
        <button type="button" className={autoCenter ? "active" : ""} onClick={centerOnMarket} title="Center the ladder on the live market and follow it">◎ {autoCenter ? "LOCK" : "CENTER"}</button>
        <label title="Aggregate this many native venue ticks into one visible price row">
          <span>AGG:</span>
          <select value={aggregationTicks} onChange={(event) => onAggregationChange(Number(event.target.value))}>
            {AGGREGATION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <em>{model.bidLevels}B / {model.askLevels}A</em>
      </div>

      <div className="bt-pro-dom-head" role="row">
        <span>SUM</span><span>SIZE</span><span>DELTA</span><span>PRICE</span><span>DEPTH</span><i />
      </div>

      <div
        className={`bt-pro-dom-viewport ${synchronizedCamera ? "camera-synchronized" : ""}`}
        onWheel={handleWheel}
        onMouseDown={onSynchronizedMouseDown}
        onMouseMove={onSynchronizedMouseMove}
        onMouseLeave={onSynchronizedMouseLeave}
        onDoubleClick={centerOnMarket}
        title={synchronizedCamera ? "IMM-synchronized price scale. Scroll or drag to inspect both panels together; double-click to recenter." : "Scroll to inspect the full live order book. Double-click to recenter."}
      >
        {visibleRows.length === 0 ? (
          <div className="bt-pro-dom-empty">AWAITING AUTHORITATIVE ORDER BOOK</div>
        ) : (
          <>
            <svg className="bt-pro-dom-outline" viewBox={`0 0 100 ${outlineHeight}`} preserveAspectRatio="none" aria-hidden="true">
              {askOutline && <polyline className="ask" points={askOutline} />}
              {bidOutline && <polyline className="bid" points={bidOutline} />}
            </svg>
            <div className={`bt-pro-dom-rows ${synchronizedCamera ? "synchronized" : ""}`} style={{ "--bt-dom-row-height": `${ROW_HEIGHT}px`, height: `${outlineHeight}px` } as CSSProperties}>
              {visibleRows.map((row) => (
                <ProfessionalRow
                  key={row.key}
                  row={row}
                  displayUnit={displayUnit}
                  unitLabel={unitLabel}
                  priceDecimals={model.priceDecimals}
                  showWallConfluence={showWallConfluence}
                  live={model.state === "live"}
                />
              ))}
            </div>
            {synchronizedCamera && model.currentPrice !== null && (
              <div className="bt-pro-dom-synchronized-line current-price" style={{ top: `${domPriceToTopPct(synchronizedCamera, model.currentPrice)}%` }} aria-hidden="true" />
            )}
            {synchronizedCamera && synchronizedCursorPrice !== null && synchronizedCursorPrice !== undefined && Number.isFinite(synchronizedCursorPrice) && (
              <div className="bt-pro-dom-synchronized-line cursor-price" style={{ top: `${domPriceToTopPct(synchronizedCamera, synchronizedCursorPrice)}%` }} aria-hidden="true" />
            )}
          </>
        )}
      </div>

      <div className="bt-pro-dom-foot">
        <span className={`bt-pro-dom-state bt-pro-dom-state--${model.state}`}>{model.state.toUpperCase()}</span>
        <span>{formatPrice(model.coverageMin, model.priceDecimals)}—{formatPrice(model.coverageMax, model.priceDecimals)}</span>
        <span>{unitLabel}</span>
        <span>{startIndex + 1}-{Math.min(model.rows.length, startIndex + visibleRows.length)} / {model.rows.length}</span>
      </div>
    </div>
  );
}

type RenderedProfessionalRow = ProfessionalDomRow & { top: number; height: number; coverage?: "live" | "unavailable" };

function ProfessionalRow({ row, displayUnit, unitLabel, priceDecimals, showWallConfluence, live }: {
  row: RenderedProfessionalRow;
  displayUnit: DomLadderDisplayUnit;
  unitLabel: string;
  priceDecimals: number;
  showWallConfluence: boolean;
  live: boolean;
}) {
  const cumulative = quantityForDisplay(row.cumulativeSize, row.price, displayUnit);
  const signedSize = quantityForDisplay(row.signedSize, row.price, displayUnit);
  const delta = quantityForDisplay(row.delta, row.price, displayUnit);
  const title = [
    `${formatPrice(row.price, priceDecimals)} price bucket`,
    `Resting bid ${formatCompact(quantityForDisplay(row.bidSize, row.price, displayUnit))} ${unitLabel}`,
    `Resting ask ${formatCompact(quantityForDisplay(row.askSize, row.price, displayUnit))} ${unitLabel}`,
    `Snapshot delta ${formatSignedCompact(delta)} ${unitLabel}`,
    row.wall ? `IMM ${row.wall.side} wall / score ${row.wall.score.toFixed(0)} / persistence ${row.wall.persistencePct.toFixed(0)}%` : "No IMM wall confluence"
  ].join("\n");
  const askWidth = row.askSize > 0 ? `${Math.max(2.5, row.depthRatio * 100)}%` : "0%";
  const bidWidth = row.bidSize > 0 ? `${Math.max(2.5, row.depthRatio * 100)}%` : "0%";
  const nodeMotion = resolveProfessionalDomNodeMotion(row, live);
  const motionStyle = {
    top: `${row.top}px`,
    height: `${row.height}px`,
    "--bt-dom-node-activity": nodeMotion.activity.toFixed(3),
    "--bt-dom-node-energy": nodeMotion.energy.toFixed(3),
    "--bt-dom-node-opacity": nodeMotion.opacity.toFixed(3),
    "--bt-dom-node-scale-x": nodeMotion.scaleX.toFixed(3),
    "--bt-dom-node-scale-y": nodeMotion.scaleY.toFixed(3),
    "--bt-dom-node-glow": `${nodeMotion.glowPx.toFixed(2)}px`,
    "--bt-dom-node-brightness": nodeMotion.brightness.toFixed(3)
  } as CSSProperties;

  return (
    <div
      className={`bt-pro-dom-row ${row.side} ${nodeMotion.activity > 0.01 ? "node-active" : "node-steady"} ${row.isCurrentPrice ? "current" : ""} ${row.isBestBid ? "best-bid" : ""} ${row.isBestAsk ? "best-ask" : ""} ${showWallConfluence && row.wall ? `imm-wall ${row.wall.side}` : ""}`}
      style={motionStyle}
      data-price={row.price}
      data-bid-size={row.bidSize}
      data-ask-size={row.askSize}
      data-snapshot-delta={row.delta}
      data-coverage={row.coverage ?? "live"}
      data-node-activity={nodeMotion.activity.toFixed(3)}
      data-node-energy={nodeMotion.energy.toFixed(3)}
      title={title}
      role="row"
    >
      <span className="sum">{row.totalSize > 0 ? formatCompact(cumulative) : "—"}</span>
      <span className={`size ${signClass(signedSize)}`}>{row.totalSize > 0 ? formatSignedCompact(signedSize) : "—"}</span>
      <span className={`delta ${signClass(delta)}`}>{Math.abs(delta) > 1e-12 ? formatSignedCompact(delta) : "·"}</span>
      <span className="price">{formatPrice(row.price, priceDecimals)}{row.isCurrentPrice && <b>NOW</b>}</span>
      <span className="profile" aria-hidden="true">
        {row.askSize > 0 && <i className="ask-bar" style={{ width: askWidth }} />}
        {row.bidSize > 0 && <i className="bid-bar" style={{ width: bidWidth }} />}
        {showWallConfluence && row.wall && <mark>{row.wall.side === "sell" ? "S" : "B"}</mark>}
      </span>
      <i className={`intensity ${row.side}`} aria-hidden="true" />
    </div>
  );
}

function resolveCurrentIndex(model: ProfessionalDomLadderModel) {
  const marked = model.rows.findIndex((row) => row.isCurrentPrice);
  if (marked >= 0) return marked;
  if (model.currentPrice === null || model.rows.length === 0) return Math.floor(model.rows.length / 2);
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  model.rows.forEach((row, index) => {
    const distance = Math.abs(row.price - model.currentPrice!);
    if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
  });
  return nearestIndex;
}

function outlinePoints(rows: ProfessionalDomRow[], side: "ask" | "bid") {
  const points = rows
    .map((row) => row as RenderedProfessionalRow)
    .filter((row) => side === "ask" ? row.askSize > 0 : row.bidSize > 0)
    .map((row) => `${(100 - row.cumulativeRatio * 92).toFixed(2)},${(row.top + row.height / 2).toFixed(2)}`);
  return points.length > 1 ? points.join(" ") : "";
}

function adaptSynchronizedRow(row: ChartDockedDepthRow, model: ProfessionalDomLadderModel): RenderedProfessionalRow {
  const cumulativeSize = row.side === "ask" ? row.askCumulative : row.side === "bid" ? row.bidCumulative : Math.max(row.askCumulative, row.bidCumulative);
  const cumulativeReference = row.side === "ask" ? model.totalAskSize : row.side === "bid" ? model.totalBidSize : Math.max(model.totalAskSize, model.totalBidSize);
  return {
    key: row.key,
    price: row.price,
    priceLow: row.priceLow,
    priceHigh: row.priceHigh,
    bidSize: row.bidSize,
    askSize: row.askSize,
    totalSize: row.totalSize,
    signedSize: row.signedSize,
    delta: row.delta,
    cumulativeSize,
    depthRatio: row.depthRatio,
    cumulativeRatio: cumulativeReference > 1e-12 ? clamp(cumulativeSize / cumulativeReference, 0, 1) : 0,
    side: row.side,
    isCurrentPrice: row.isCurrentPrice,
    isBestBid: model.bestBid !== null && model.bestBid >= row.priceLow && model.bestBid <= row.priceHigh,
    isBestAsk: model.bestAsk !== null && model.bestAsk >= row.priceLow && model.bestAsk <= row.priceHigh,
    wall: row.wall,
    coverage: row.coverage,
    top: row.top,
    height: row.height
  };
}

function hashCameraVersion(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function quantityForDisplay(quantity: number, price: number, unit: DomLadderDisplayUnit) {
  return unit === "notional" ? quantity * price : quantity;
}

function formatPrice(value: number | null, decimals: number) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatCompact(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (absolute >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${trim(value / 1_000)}K`;
  if (absolute >= 10) return trim(value);
  if (absolute >= 1) return value.toFixed(2).replace(/\.00$/, "");
  if (absolute === 0) return "0";
  return value.toPrecision(3);
}

function formatSignedCompact(value: number) {
  if (Math.abs(value) <= 1e-12) return "0";
  return `${value > 0 ? "+" : "−"}${formatCompact(Math.abs(value))}`;
}

function signClass(value: number) {
  return value > 1e-12 ? "positive" : value < -1e-12 ? "negative" : "neutral";
}

function trim(value: number) {
  return Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
