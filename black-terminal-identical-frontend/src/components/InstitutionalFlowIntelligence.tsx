import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketSymbol } from "../market-data/types";
import { getMarketDataEngineAdapter } from "../market-data/engine/marketDataEngine";
import { fetchInstitutionalFlow } from "../institutional-flow/institutionalFlowClient";
import { nearestHistoricalCoinPrice, oscillatorHoverIndex, type HistoricalCoinPricePoint } from "../institutional-flow/oscillatorHoverModel";
import type { InstitutionalFlowPoint, InstitutionalFlowSnapshot } from "../institutional-flow/types";

type InstitutionalFlowIntelligenceProps = {
  marketSymbol: MarketSymbol;
};

const POLL_INTERVAL_MS = 30_000;

type HistoricalCoinSeries = {
  state: "idle" | "loading" | "ready" | "unavailable";
  points: HistoricalCoinPricePoint[];
  intervalSeconds: number;
  source: string;
};

const EMPTY_COIN_SERIES: HistoricalCoinSeries = { state: "idle", points: [], intervalSeconds: 60, source: "" };

export function InstitutionalFlowIntelligence({ marketSymbol }: InstitutionalFlowIntelligenceProps) {
  const [snapshot, setSnapshot] = useState<InstitutionalFlowSnapshot | null>(null);
  const lastSuccessfulRef = useRef<InstitutionalFlowSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "live" | "degraded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [coinSeries, setCoinSeries] = useState<HistoricalCoinSeries>(EMPTY_COIN_SERIES);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await fetchInstitutionalFlow(marketSymbol.baseAsset, controller.signal);
        if (disposed) return;
        lastSuccessfulRef.current = next;
        setSnapshot(next);
        setStatus(next.state === "live" ? "live" : "degraded");
        setError(next.staleReason || null);
      } catch (cause) {
        if (disposed || controller.signal.aborted) return;
        setStatus(lastSuccessfulRef.current ? "degraded" : "error");
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    setStatus("loading");
    setError(null);
    lastSuccessfulRef.current = null;
    setSnapshot(null);
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [marketSymbol.baseAsset]);

  const oscillatorStart = snapshot?.oscillator[0]?.time ?? 0;
  const oscillatorEnd = snapshot?.oscillator.at(-1)?.time ?? 0;

  useEffect(() => {
    if (!oscillatorStart || !oscillatorEnd) {
      setCoinSeries(EMPTY_COIN_SERIES);
      return;
    }
    const controller = new AbortController();
    setCoinSeries((current) => ({ ...current, state: "loading", points: [] }));

    const load = async () => {
      let adapter;
      try {
        adapter = getMarketDataEngineAdapter(marketSymbol.exchange);
      } catch {
        setCoinSeries({ state: "unavailable", points: [], intervalSeconds: 60, source: `${marketSymbol.exchange.toUpperCase()} HISTORY UNAVAILABLE` });
        return;
      }
      const from = Math.max(0, Math.floor(oscillatorStart / 1_000) - 600);
      const to = Math.floor(oscillatorEnd / 1_000) + 600;
      let lastError: unknown;
      for (const timeframe of ["1m", "5m"] as const) {
        try {
          const candles = await adapter.getHistoricalCandles({
            exchange: marketSymbol.exchange,
            symbol: marketSymbol.rawSymbol,
            marketKind: marketSymbol.marketKind,
            timeframe,
            from,
            to,
            limit: 1_000,
            signal: controller.signal
          });
          if (controller.signal.aborted) return;
          const points = candles
            .filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.close > 0)
            .map((candle) => ({ time: candle.time, close: candle.close }))
            .sort((left, right) => left.time - right.time);
          if (!points.length) throw new Error("Historical coin-price window is empty.");
          setCoinSeries({
            state: "ready",
            points,
            intervalSeconds: timeframe === "1m" ? 60 : 300,
            source: `${adapter.label.toUpperCase()} ${timeframe.toUpperCase()} CLOSE`
          });
          return;
        } catch (cause) {
          if (controller.signal.aborted) return;
          lastError = cause;
        }
      }
      void lastError;
      setCoinSeries({ state: "unavailable", points: [], intervalSeconds: 60, source: `${marketSymbol.exchange.toUpperCase()} HISTORY UNAVAILABLE` });
    };

    void load();
    return () => controller.abort();
  }, [marketSymbol.exchange, marketSymbol.rawSymbol, marketSymbol.marketKind, oscillatorStart, oscillatorEnd]);

  const basket = snapshot?.basket;
  const pressure = basket?.pressureScore ?? 0;
  const pressureClass = pressure > 4 ? "positive" : pressure < -4 ? "negative" : "neutral";
  const freshness = snapshot ? freshnessLabel(snapshot) : status === "loading" ? "SYNCING" : "UNAVAILABLE";

  return (
    <section className="institutional-flow panel-block" aria-label="Institutional flow intelligence">
      <div className="institutional-flow-head">
        <div>
          <b>ETF FLOW INTELLIGENCE</b>
          <span>{snapshot?.asset || marketSymbol.baseAsset.toUpperCase()} INSTITUTIONAL TAPE</span>
        </div>
        <em className={status}>{freshness}</em>
      </div>

      {snapshot?.state === "unsupported" ? (
        <div className="institutional-flow-empty">
          <b>NO SUPPORTED U.S. SPOT ETP BASKET</b>
          <span>This chart asset has no verified institutional fund universe.</span>
        </div>
      ) : !basket || !snapshot ? (
        <div className="institutional-flow-empty">
          <b>{status === "loading" ? "SYNCHRONIZING FUND TAPES" : "DATA SOURCE UNAVAILABLE"}</b>
          <span>{error || "Waiting for authenticated market data."}</span>
        </div>
      ) : (
        <>
          <div className="institutional-flow-summary">
            <Metric label="LIVE PRESSURE" value={signed(pressure)} tone={pressureClass} title="AUM-weighted signed ETF return scaled by relative trading volume. This is a secondary-market pressure score, not fund inflow." />
            <Metric label="BREADTH" value={`${Math.round(basket.breadthPct)}%`} tone={basket.breadthPct > 0 ? "positive" : basket.breadthPct < 0 ? "negative" : "neutral"} title="Net share of tracked funds trading higher versus lower." />
            <Metric label="TURNOVER" value={compactUsd(basket.totalTurnoverUsd)} tone="neutral" title="Last price multiplied by traded share volume across the basket. Turnover is not an ETF creation/redemption flow." />
            <Metric label="REPORTED FLOW" value={snapshot.reporting.reportedNetFlowUsd == null ? "EOD PENDING" : compactUsd(snapshot.reporting.reportedNetFlowUsd)} tone="pending" title="Reserved exclusively for issuer-reported creations/redemptions or shares-outstanding changes. Intraday exchange volume is never substituted here." />
          </div>

          <PressureOscillator points={snapshot.oscillator} current={pressure} marketSymbol={marketSymbol} coinSeries={coinSeries} />

          <div className="institutional-fund-table">
            <div className="institutional-fund-head"><span>FUND</span><span>LIVE</span><span>RVOL</span><span>PRESSURE</span></div>
            {snapshot.funds.map((fund) => (
              <a className="institutional-fund-row" href={fund.sourceUrl} target="_blank" rel="noreferrer" key={fund.ticker} title={`${fund.name}\n${fund.sourceTimestamp}`}>
                <span><b>{fund.ticker}</b><small>{fund.manager}</small></span>
                <span className={fund.percentChange > 0 ? "positive" : fund.percentChange < 0 ? "negative" : "neutral"}>{signed(fund.percentChange, "%")}</span>
                <span>{fund.relativeVolume.toFixed(2)}x</span>
                <span className={fund.pressureScore > 0 ? "positive" : fund.pressureScore < 0 ? "negative" : "neutral"}>{signed(fund.pressureScore)}</span>
              </a>
            ))}
          </div>

          <div className="institutional-flow-foot">
            <span title="Strategy is a corporate bitcoin treasury reporting through periodic filings; it is not an ETF and has no tick-by-tick fund flow.">STRATEGY · TREASURY / PERIODIC 8-K</span>
            <span title="Vanguard currently has no native spot crypto fund in this basket and is intentionally not assigned fabricated flow.">VANGUARD · NO NATIVE FUND</span>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone: string; title: string }) {
  return <div className="institutional-flow-metric" title={title}><span>{label}</span><b className={tone}>{value}</b></div>;
}

function PressureOscillator({
  points,
  current,
  marketSymbol,
  coinSeries
}: {
  points: InstitutionalFlowPoint[];
  current: number;
  marketSymbol: MarketSymbol;
  coinSeries: HistoricalCoinSeries;
}) {
  const model = useMemo(() => oscillatorModel(points), [points]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hovered = hoverIndex == null ? null : model.samples[hoverIndex] ?? null;
  const historicalPrice = hovered
    ? nearestHistoricalCoinPrice(coinSeries.points, hovered.point.time, coinSeries.intervalSeconds * 2)
    : null;
  const hoverLeft = hovered ? Math.min(70, Math.max(30, (hovered.x / 320) * 100)) : 50;

  useEffect(() => setHoverIndex(null), [points]);

  return (
    <div className="institutional-pressure" aria-label="Black Core institutional pressure oscillator. White and silver are positive secondary-market pressure; blood red is negative. Primary ETF flow is not inferred.">
      <div className="institutional-pressure-label"><span>INSTITUTIONAL PRESSURE OSCILLATOR</span><b className={current >= 0 ? "positive" : "negative"}>{signed(current)}</b></div>
      <svg
        viewBox="0 0 320 92"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Institutional pressure ${current.toFixed(1)}`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setHoverIndex(oscillatorHoverIndex(event.clientX, bounds.left, bounds.width, model.samples.length));
        }}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="institutional-pressure-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f3f5f7" stopOpacity="0.3" />
            <stop offset="0.5" stopColor="#8b9199" stopOpacity="0.03" />
            <stop offset="1" stopColor="#a40019" stopOpacity="0.34" />
          </linearGradient>
          <filter id="institutional-pressure-glow"><feGaussianBlur stdDeviation="1.35" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect x="0" y="0" width="320" height="46" fill="rgba(255,255,255,0.012)" />
        <rect x="0" y="46" width="320" height="46" fill="rgba(130,0,18,0.09)" />
        <line x1="0" x2="320" y1="46" y2="46" stroke="rgba(255,255,255,0.18)" strokeDasharray="2 3" />
        <line x1="0" x2="320" y1="23" y2="23" stroke="rgba(255,255,255,0.05)" />
        <line x1="0" x2="320" y1="69" y2="69" stroke="rgba(255,0,35,0.12)" />
        {model.bars.map((bar) => <rect key={bar.key} x={bar.x} y={Math.min(46, bar.y)} width={bar.width} height={Math.max(1, Math.abs(bar.y - 46))} fill={bar.value >= 0 ? "rgba(218,222,228,0.12)" : "rgba(219,0,28,0.22)"} />)}
        <path d={model.area} fill="url(#institutional-pressure-fill)" />
        <path d={model.signal} fill="none" stroke="rgba(142,148,157,0.65)" strokeWidth="1" />
        <path d={model.pressure} fill="none" stroke={current >= 0 ? "#f2f4f6" : "#e00022"} strokeWidth="1.5" filter="url(#institutional-pressure-glow)" />
        {hovered ? (
          <g className="institutional-pressure-crosshair" aria-hidden="true">
            <line x1={hovered.x} x2={hovered.x} y1="12" y2="83" />
            <circle cx={hovered.x} cy={hovered.y} r="2.6" />
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <dl className="institutional-pressure-hover" style={{ left: `${hoverLeft}%` }}>
          <div><dt>TIME</dt><dd>{formatHistoricalTime(hovered.point.time)}</dd></div>
          <div><dt>HISTORICAL COIN PRICE</dt><dd>{historicalPrice ? `${formatCoinPrice(historicalPrice.close, marketSymbol.pricePrecision)} ${marketSymbol.quoteAsset}` : coinSeries.state === "loading" ? "SYNCING" : "UNAVAILABLE"}</dd></div>
          <div><dt>PRESSURE</dt><dd className={hovered.point.pressure >= 0 ? "positive" : "negative"}>{signed(hovered.point.pressure)}</dd></div>
          <div><dt>SIGNAL</dt><dd>{signed(hovered.point.signal)}</dd></div>
          <div><dt>SOURCE</dt><dd>{coinSeries.source || `${marketSymbol.exchange.toUpperCase()} HISTORY`}</dd></div>
        </dl>
      ) : null}
      <div className="institutional-pressure-scale"><span>SELL PRESSURE</span><b>0</b><span>BUY PRESSURE</span></div>
    </div>
  );
}

function oscillatorModel(points: InstitutionalFlowPoint[]) {
  const safe = points.length > 1 ? points : [{ time: 0, pressure: 0, signal: 0 }, { time: 1, pressure: points[0]?.pressure || 0, signal: points[0]?.signal || 0 }];
  const width = 320;
  const center = 46;
  const scale = 0.42;
  const coordinate = (value: number) => center - Math.max(-100, Math.min(100, value)) * scale;
  const path = (field: "pressure" | "signal") => safe.map((point, index) => `${index ? "L" : "M"}${(index / (safe.length - 1) * width).toFixed(2)},${coordinate(point[field]).toFixed(2)}`).join(" ");
  const pressure = path("pressure");
  const latestY = coordinate(safe[safe.length - 1].pressure);
  const area = `${pressure} L${width},${center} L0,${center} Z`;
  const tail = safe.slice(-48);
  const barWidth = width / Math.max(1, tail.length);
  const bars = tail.map((point, index) => ({ key: `${point.time}-${index}`, x: index * barWidth, y: coordinate(point.pressure), width: Math.max(1, barWidth - 0.7), value: point.pressure }));
  const samples = safe.map((point, index) => ({ point, x: index / (safe.length - 1) * width, y: coordinate(point.pressure) }));
  void latestY;
  return { pressure, signal: path("signal"), area, bars, samples };
}

function signed(value: number, suffix = "") {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe > 0 ? "+" : ""}${safe.toFixed(1)}${suffix}`;
}

function compactUsd(value: number) {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
  return `${sign}$${absolute.toFixed(0)}`;
}

function formatHistoricalTime(time: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false
  }).format(new Date(time)).toUpperCase() + " UTC";
}

function formatCoinPrice(value: number, precision?: number) {
  const digits = Math.min(8, Math.max(2, precision ?? (value >= 1_000 ? 2 : value >= 1 ? 4 : 6)));
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function freshnessLabel(snapshot: InstitutionalFlowSnapshot) {
  if (snapshot.state === "stale") return `STALE ${Math.max(1, Math.round(snapshot.ageMs / 60_000))}M`;
  if (snapshot.state === "degraded") return `LIVE · ${snapshot.sourceFailures} SOURCE DOWN`;
  if (snapshot.state === "unsupported") return "NO BASKET";
  return snapshot.basket?.marketStatus?.toUpperCase() || "LIVE";
}
