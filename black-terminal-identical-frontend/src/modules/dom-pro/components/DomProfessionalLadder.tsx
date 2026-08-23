import { useEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent } from "react";
import type { DomLadderDisplayUnit } from "../domLadderModel";
import type { ProfessionalDomLadderModel, ProfessionalDomRow } from "../domProfessionalLadder";
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
  onAutoCenterChange
}: DomProfessionalLadderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(420);
  const [manualOffset, setManualOffset] = useState(0);
  const visibleRowCount = clamp(Math.floor((height - CHROME_HEIGHT) / ROW_HEIGHT), 8, clamp(Math.round(maximumVisibleRows), 8, 160));
  const currentIndex = useMemo(() => resolveCurrentIndex(model), [model]);
  const maximumStart = Math.max(0, model.rows.length - visibleRowCount);
  const centeredStart = clamp(currentIndex - Math.floor(visibleRowCount / 2), 0, maximumStart);
  const startIndex = clamp(centeredStart + manualOffset, 0, maximumStart);
  const visibleRows = model.rows.slice(startIndex, startIndex + visibleRowCount);
  const outlineHeight = Math.max(ROW_HEIGHT, visibleRows.length * ROW_HEIGHT);
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
    event.preventDefault();
    event.stopPropagation();
    const movement = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 36));
    if (autoCenter) onAutoCenterChange(false);
    setManualOffset((current) => clamp(current + movement, -centeredStart, maximumStart - centeredStart));
  }

  function centerOnMarket() {
    setManualOffset(0);
    if (!autoCenter) onAutoCenterChange(true);
  }

  const askOutline = outlinePoints(visibleRows, "ask");
  const bidOutline = outlinePoints(visibleRows, "bid");

  return (
    <div
      ref={rootRef}
      className={`bt-pro-dom ${model.state}`}
      data-professional-dom="true"
      data-book-identity={model.identity}
      data-price-step={model.priceStep}
      data-visible-start={startIndex}
      data-visible-rows={visibleRows.length}
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

      <div className="bt-pro-dom-viewport" onWheel={handleWheel} onDoubleClick={centerOnMarket} title="Scroll to inspect the full live order book. Double-click to recenter.">
        {visibleRows.length === 0 ? (
          <div className="bt-pro-dom-empty">AWAITING AUTHORITATIVE ORDER BOOK</div>
        ) : (
          <>
            <svg className="bt-pro-dom-outline" viewBox={`0 0 100 ${outlineHeight}`} preserveAspectRatio="none" aria-hidden="true">
              {askOutline && <polyline className="ask" points={askOutline} />}
              {bidOutline && <polyline className="bid" points={bidOutline} />}
            </svg>
            <div className="bt-pro-dom-rows" style={{ "--bt-dom-row-height": `${ROW_HEIGHT}px` } as CSSProperties}>
              {visibleRows.map((row) => (
                <ProfessionalRow
                  key={row.key}
                  row={row}
                  displayUnit={displayUnit}
                  unitLabel={unitLabel}
                  priceDecimals={model.priceDecimals}
                  showWallConfluence={showWallConfluence}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="bt-pro-dom-foot">
        <span className={model.state}>{model.state.toUpperCase()}</span>
        <span>{formatPrice(model.coverageMin, model.priceDecimals)}—{formatPrice(model.coverageMax, model.priceDecimals)}</span>
        <span>{unitLabel}</span>
        <span>{startIndex + 1}-{Math.min(model.rows.length, startIndex + visibleRows.length)} / {model.rows.length}</span>
      </div>
    </div>
  );
}

function ProfessionalRow({ row, displayUnit, unitLabel, priceDecimals, showWallConfluence }: {
  row: ProfessionalDomRow;
  displayUnit: DomLadderDisplayUnit;
  unitLabel: string;
  priceDecimals: number;
  showWallConfluence: boolean;
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

  return (
    <div
      className={`bt-pro-dom-row ${row.side} ${row.isCurrentPrice ? "current" : ""} ${row.isBestBid ? "best-bid" : ""} ${row.isBestAsk ? "best-ask" : ""} ${showWallConfluence && row.wall ? `imm-wall ${row.wall.side}` : ""}`}
      data-price={row.price}
      data-bid-size={row.bidSize}
      data-ask-size={row.askSize}
      data-snapshot-delta={row.delta}
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
      <i className={`intensity ${row.side}`} style={{ opacity: row.totalSize > 0 ? Math.max(0.14, row.depthRatio) : 0.05 }} aria-hidden="true" />
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
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => side === "ask" ? row.askSize > 0 : row.bidSize > 0)
    .map(({ row, index }) => `${(100 - row.cumulativeRatio * 92).toFixed(2)},${((index + 0.5) * ROW_HEIGHT).toFixed(2)}`);
  return points.length > 1 ? points.join(" ") : "";
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
