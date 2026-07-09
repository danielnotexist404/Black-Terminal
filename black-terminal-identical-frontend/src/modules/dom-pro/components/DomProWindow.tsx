import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Maximize2, Minus, Settings, X } from "lucide-react";
import { blackCoreConnectionManager } from "../../../connectivity/connectionManager";
import { readActiveExecutionVenueId } from "../../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../../connectivity/types";
import { submitOrder } from "../../../execution/executionEngine";
import type { MarginMode, OrderSide, OrderType, TimeInForce } from "../../../execution/types";
import type { MarketSymbol } from "../../../market-data/types";
import type { PortfolioAccount } from "../../../portfolio/types";
import { defaultRiskControls } from "../../../risk/types";
import { DomAggregationEngine } from "../domAggregationEngine";
import { readDomSettings, updateModeSettings, writeDomSettings } from "../domSettingsStore";
import { useDomFeed } from "../useDomFeed";
import type { AggregatedDomSnapshot, DomMode, DomSettings, DomVisibleRange } from "../types";

type DomProWindowProps = {
  marketSymbol: MarketSymbol;
  lastPrice: number;
  exchangeLabel: string;
  workspaceId: string;
  onClose: () => void;
};

const orderTypes: OrderType[] = ["limit", "market", "twap", "iceberg"];
const visibleRanges: Array<{ value: DomVisibleRange; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "0.25", label: "+/-0.25%" },
  { value: "0.5", label: "+/-0.5%" },
  { value: "1", label: "+/-1%" },
  { value: "2", label: "+/-2%" },
  { value: "5", label: "+/-5%" },
  { value: "custom", label: "Custom" }
];
const modes: DomMode[] = ["micro", "scalper", "standard", "swing", "macro", "custom"];

export function DomProWindow({ marketSymbol, lastPrice, exchangeLabel, workspaceId, onClose }: DomProWindowProps) {
  const symbolKey = `${marketSymbol.exchange}:${marketSymbol.marketKind}:${marketSymbol.rawSymbol}`;
  const feed = useDomFeed(marketSymbol);
  const engineRef = useRef(new DomAggregationEngine());
  const frameRef = useRef<number | null>(null);
  const lastRenderAtRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const [settings, setSettings] = useState<DomSettings>(() => readDomSettings(workspaceId, symbolKey));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AggregatedDomSnapshot>(() =>
    engineRef.current.aggregate({
      marketSymbol,
      book: feed.book,
      ticker: feed.ticker,
      trades: feed.trades,
      settings,
      subscriptionCount: feed.subscriptionCount
    })
  );
  const [connections, setConnections] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const activeConnections = useMemo(() => connections.filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status)), [connections]);
  const selectedConnection = useMemo(() => {
    const activeVenueId = readActiveExecutionVenueId();
    return activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  }, [activeConnections]);
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [executionStatus, setExecutionStatus] = useState("");

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    const next = readDomSettings(workspaceId, symbolKey);
    setSettings(next);
    engineRef.current = new DomAggregationEngine();
  }, [workspaceId, symbolKey]);

  useEffect(() => {
    writeDomSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (frameRef.current !== null) return;
    const now = performance.now();
    const minFrameMs = 1000 / Math.max(1, settings.fpsCap);
    const elapsed = now - lastRenderAtRef.current;
    if (elapsed < minFrameMs) {
      droppedFramesRef.current += 1;
      frameRef.current = window.setTimeout(() => {
        frameRef.current = null;
        renderSnapshot();
      }, minFrameMs - elapsed) as unknown as number;
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      renderSnapshot();
    });
  }, [feed.updatedAt, settings]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      window.clearTimeout(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!price && snapshot.lastPrice) setPrice(String(Number(snapshot.lastPrice.toFixed(2))));
  }, [snapshot.lastPrice, price]);

  function renderSnapshot() {
    const started = performance.now();
    const next = engineRef.current.aggregate({
      marketSymbol,
      book: feed.book,
      ticker: feed.ticker,
      trades: feed.trades,
      settings,
      renderStats: {
        renderFps: lastRenderAtRef.current ? 1000 / Math.max(1, performance.now() - lastRenderAtRef.current) : 0,
        droppedFrames: droppedFramesRef.current,
        lastRenderMs: 0
      },
      subscriptionCount: feed.subscriptionCount
    });
    next.renderStats.lastRenderMs = performance.now() - started;
    lastRenderAtRef.current = performance.now();
    setSnapshot(next);
  }

  function patchSettings(patch: Partial<DomSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  async function submitQuickOrder(targetSide: OrderSide) {
    setExecutionStatus("");
    const parsedQuantity = Number(quantity);
    const parsedPrice = Number(price || snapshot.lastPrice || lastPrice || 0);
    if (!selectedConnection) {
      setExecutionStatus("CONNECT ACCOUNT IN POSITIONS");
      return;
    }
    if (selectedConnection.category === "wallet") {
      setExecutionStatus("WALLET SIGNER NEEDS A PROTOCOL ROUTER");
      return;
    }
    if (!selectedConnection.accountId) {
      setExecutionStatus("CONNECTED VENUE HAS NO ACCOUNT ID");
      return;
    }
    if (selectedConnection.category === "protocol" && selectedConnection.metadata.executionReady !== true) {
      setExecutionStatus(String(selectedConnection.metadata.readinessReason || "PROTOCOL RELAY IS NOT READY").toUpperCase());
      return;
    }
    if (!parsedQuantity || parsedQuantity <= 0) {
      setExecutionStatus("ENTER VALID SIZE");
      return;
    }

    try {
      const update = await submitOrder({
        accountId: selectedConnection.accountId,
        exchange: selectedConnection.provider as MarketSymbol["exchange"],
        symbol: marketSymbol.rawSymbol.toUpperCase(),
        marketKind: marketSymbol.marketKind,
        side: targetSide,
        type: orderType,
        quantity: parsedQuantity,
        sizingMethod: "quantity",
        limitPrice: orderType === "limit" || orderType === "iceberg" || orderType === "twap" ? parsedPrice : undefined,
        referencePrice: parsedPrice,
        reduceOnly,
        postOnly,
        marginMode,
        timeInForce,
        source: "order-ticket",
        destinations: ["personal-portfolio"]
      }, buildExecutionAccount(selectedConnection), parsedPrice || 1);
      setExecutionStatus(`${update.status.toUpperCase()}: ${update.reason || update.orderId}`);
    } catch (error) {
      setExecutionStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  const priceRows = snapshot.buckets;
  const maxTotal = Math.max(...priceRows.map((row) => row.totalSize), 1);
  const cvdData = engineRef.current.cvdData();

  return (
    <div className="dom-pro-shell" role="dialog" aria-label="DOM Pro plus institutional order flow terminal">
      <div className="dom-pro-window">
        <header className="dom-pro-header">
          <div>
            <b>DOM PRO+</b>
            <span>Institutional Depth & Order Flow Terminal</span>
          </div>
          <div className="dom-pro-window-controls">
            <button type="button" title="Detach DOM"><ExternalLink size={15} /></button>
            <button type="button" title="Minimize"><Minus size={15} /></button>
            <button type="button" title="Maximize"><Maximize2 size={15} /></button>
            <button type="button" title="Close DOM Pro+" onClick={onClose}><X size={16} /></button>
          </div>
        </header>

        <section className="dom-pro-stats">
          <Stat label="Symbol" value={`${marketSymbol.rawSymbol} ${marketSymbol.marketKind.toUpperCase()}`} />
          <Stat label="Last Price" value={formatPrice(snapshot.lastPrice ?? lastPrice)} />
          <Stat label="24H Change" value={signed(snapshot.ticker?.priceChangePercent, "%")} />
          <Stat label="24H High" value={formatPrice(snapshot.ticker?.highPrice)} />
          <Stat label="24H Low" value={formatPrice(snapshot.ticker?.lowPrice)} />
          <Stat label="24H Volume" value={formatCompact(snapshot.ticker?.quoteVolume ?? snapshot.ticker?.volume)} />
          <label>
            <span>DOM Mode</span>
            <select value={settings.mode} onChange={(event) => setSettings(updateModeSettings(settings, event.target.value as DomMode))}>
              {modes.map((mode) => <option key={mode} value={mode}>{mode.toUpperCase()}</option>)}
            </select>
          </label>
          <label>
            <span>Bucket</span>
            <select value={String(settings.bucketMultiplier)} onChange={(event) => patchSettings({ bucketMultiplier: event.target.value === "custom" ? "custom" : Number(event.target.value) as DomSettings["bucketMultiplier"] })}>
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((item) => <option key={item} value={item}>{item}x</option>)}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Visible Range</span>
            <select value={settings.visibleRange} onChange={(event) => patchSettings({ visibleRange: event.target.value as DomVisibleRange })}>
              {visibleRanges.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
            </select>
          </label>
          <Stat label="FPS Cap" value={`${settings.fpsCap} FPS`} />
          <button type="button" className="dom-pro-settings-btn" onClick={() => setSettingsOpen((value) => !value)}><Settings size={15} /> Settings</button>
        </section>

        {settingsOpen && (
          <section className="dom-pro-settings-panel">
            <Toggle label="Volume Profile" checked={settings.showVolumeProfile} onChange={(value) => patchSettings({ showVolumeProfile: value })} />
            <Toggle label="Heatmap" checked={settings.showHeatmap} onChange={(value) => patchSettings({ showHeatmap: value })} />
            <Toggle label="Wall Detection" checked={settings.showWallDetection} onChange={(value) => patchSettings({ showWallDetection: value })} />
            <Toggle label="CVD" checked={settings.showCvd} onChange={(value) => patchSettings({ showCvd: value })} />
            <Toggle label="Execution" checked={settings.showExecutionPanel} onChange={(value) => patchSettings({ showExecutionPanel: value })} />
            <Toggle label="Diagnostics" checked={settings.showDiagnostics} onChange={(value) => patchSettings({ showDiagnostics: value })} />
            <Field label="FPS" value={settings.fpsCap} min={5} max={30} onChange={(value) => patchSettings({ fpsCap: value })} />
            <Field label="Max Buckets" value={settings.maxVisibleBuckets} min={20} max={180} onChange={(value) => patchSettings({ maxVisibleBuckets: value })} />
            <Field label="Heatmap History" value={settings.maxHeatmapHistory} min={20} max={240} onChange={(value) => patchSettings({ maxHeatmapHistory: value })} />
            <Field label="Liquidity Threshold" value={settings.liquidityThreshold} min={1} max={8} step={0.1} onChange={(value) => patchSettings({ liquidityThreshold: value })} />
            {settings.bucketMultiplier === "custom" && <Field label="Custom Bucket" value={settings.customBucketSize} min={0.01} max={10000} step={0.01} onChange={(value) => patchSettings({ customBucketSize: value })} />}
          </section>
        )}

        <main className="dom-pro-grid">
          <section className="dom-pro-panel dom-pro-ladder">
            <PanelTitle title="Aggregated DOM Ladder" status={snapshot.statusMessage} />
            {snapshot.status === "awaiting-book" ? <EmptyState text="Awaiting live orderbook stream." /> : (
              <>
                <div className="dom-pro-ladder-head"><span>Price ({marketSymbol.quoteAsset})</span><span>Bid Size ({marketSymbol.baseAsset})</span><span>Ask Size ({marketSymbol.baseAsset})</span></div>
                <div className="dom-pro-ladder-rows">
                  {priceRows.map((row) => (
                    <div className={`dom-pro-ladder-row ${row.isCurrentPrice ? "current" : ""}`} key={row.price}>
                      <span>{formatPrice(row.price)}</span>
                      <span>{formatSize(row.bidSize)}</span>
                      <span className="red">{formatSize(row.askSize)}</span>
                      <i className="bid-depth" style={{ transform: `scaleX(${row.bidSize / maxTotal})` }} />
                      <i className="ask-depth" style={{ transform: `scaleX(${row.askSize / maxTotal})` }} />
                    </div>
                  ))}
                </div>
                <div className="dom-pro-mid">
                  <b>{formatPrice(snapshot.lastPrice)}</b>
                  <span>Spread {formatPrice(snapshot.spread ?? 0)}</span>
                  <em>Mid {formatPrice(snapshot.midPrice)}</em>
                </div>
              </>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-profile">
            <PanelTitle title="Volume Profile" status={settings.profileSource.toUpperCase()} />
            {!settings.showVolumeProfile ? <EmptyState text="Volume profile hidden in DOM settings." /> : snapshot.volumeProfile.length === 0 ? <EmptyState text="Awaiting live orderbook stream." /> : (
              <div className="dom-pro-profile-rows">
                {snapshot.volumeProfile.map((node) => (
                  <div className={`dom-pro-profile-row ${node.kind}`} key={node.price}>
                    <span>{formatPrice(node.price)}</span>
                    <i style={{ width: `${Math.max(2, node.volume / Math.max(...snapshot.volumeProfile.map((item) => item.volume), 1) * 100)}%` }} />
                    <b>{node.kind.toUpperCase()}</b>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-heatmap">
            <PanelTitle title="Liquidity Heatmap" status="LOW -> HIGH" />
            {!settings.showHeatmap ? <EmptyState text="Liquidity heatmap hidden in DOM settings." /> : snapshot.heatmap.length === 0 ? <EmptyState text="Liquidity heatmap requires depth history." /> : (
              <div className="dom-pro-heatmap-canvas">
                {snapshot.heatmap.slice(-60).map((frame, frameIndex) => frame.cells.slice(0, 90).map((cell, cellIndex) => (
                  <span
                    key={`${frame.time}-${cell.price}-${cellIndex}`}
                    className={cell.side}
                    style={{
                      left: `${(frameIndex / 60) * 100}%`,
                      top: `${(cellIndex / Math.max(1, frame.cells.length)) * 100}%`,
                      opacity: Math.max(0.08, cell.intensity),
                      width: "1.8%",
                      height: "1.2%"
                    }}
                  />
                )))}
                <b style={{ top: "50%" }} />
              </div>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-walls">
            <PanelTitle title="Wall Detection" status="HEURISTIC" />
            {!settings.showWallDetection ? <EmptyState text="Wall detection hidden in DOM settings." /> : snapshot.walls.length === 0 ? <EmptyState text="No persistent liquidity wall detected." /> : (
              snapshot.walls.map((wall) => (
                <div className={`dom-pro-wall ${wall.side}`} key={wall.id}>
                  <b>{wall.side === "sell" ? "SELL WALL" : "BUY WALL"}</b>
                  <span>{formatPrice(wall.price)}</span>
                  <em>{formatSize(wall.size)} {marketSymbol.baseAsset}</em>
                  <small>{Math.round(wall.persistenceMs / 1000)}s / score {wall.score.toFixed(0)}</small>
                </div>
              ))
            )}
          </section>

          <section className="dom-pro-panel dom-pro-tape">
            <PanelTitle title="Trade Tape" status={feed.tradeStatus} />
            {snapshot.trades.length === 0 ? <EmptyState text="Trade stream unavailable for this venue." /> : (
              <>
                <div className="dom-pro-tape-head"><span>Time</span><span>Price</span><span>Size</span><span>Side</span></div>
                {snapshot.trades.slice(0, 22).map((trade) => (
                  <div className={`dom-pro-tape-row ${trade.side}`} key={trade.tradeId}>
                    <span>{formatTime(trade.time)}</span>
                    <span>{formatPrice(trade.price)}</span>
                    <span>{formatSize(trade.quantity)}</span>
                    <span>{trade.side === "buy" ? "B" : trade.side === "sell" ? "S" : "-"}</span>
                  </div>
                ))}
              </>
            )}
          </section>

          <section className="dom-pro-panel dom-pro-metrics">
            <PanelTitle title="DOM Metrics" status={exchangeLabel.toUpperCase()} />
            <Metric label="Orderbook Imbalance" value={`${snapshot.metrics.orderBookImbalance.toFixed(2)}%`} note={snapshot.metrics.orderBookImbalance >= 0 ? "BID HEAVY" : "ASK HEAVY"} />
            <Metric label="Depth Imbalance" value={`${snapshot.metrics.depthImbalance.toFixed(1)}%`} note="VISIBLE" />
            <Metric label="Liquidity Score" value={`${snapshot.metrics.liquidityScore.toFixed(0)} / 100`} note="STRUCTURE" />
            <Metric label="Absorption" value={snapshot.absorption.detected ? "DETECTED" : "NONE"} note={snapshot.absorption.label} hot={snapshot.absorption.detected} />
            <Metric label="Pulling / Stacking" value={snapshot.metrics.bidStacked + snapshot.metrics.askStacked >= snapshot.metrics.bidPulled + snapshot.metrics.askPulled ? "STACKING" : "PULLING"} note="NET LIQUIDITY" hot />
            <Metric label="Large Trades (1m)" value={String(snapshot.metrics.largeTradesLastMinute)} note="LAST 60S" />
            <Metric label="Est. Icebergs" value={`${snapshot.iceberg.estimatedCount}`} note={`${snapshot.iceberg.probability.toUpperCase()} PROBABILITY`} hot={snapshot.iceberg.probability !== "low"} />
            <Metric label="Latency" value={`${snapshot.metrics.latencyMs.toFixed(0)} ms`} note={feed.bookStatus} />
          </section>

          <section className="dom-pro-panel dom-pro-depth-chart">
            <PanelTitle title="Depth Chart" status="AGGREGATED" />
            <div className="dom-pro-depth-bars">
              {snapshot.bids.slice(0, 35).reverse().map((bucket) => <i className="bid" key={`b-${bucket.price}`} style={{ height: `${Math.max(2, bucket.bidSize / maxTotal * 100)}%` }} />)}
              {snapshot.asks.slice(0, 35).map((bucket) => <i className="ask" key={`a-${bucket.price}`} style={{ height: `${Math.max(2, bucket.askSize / maxTotal * 100)}%` }} />)}
            </div>
          </section>

          <section className="dom-pro-panel dom-pro-flow">
            <PanelTitle title="Liquidity Flow Delta" status="PULL / STACK" />
            <div className="dom-pro-flow-bars">
              {snapshot.liquidityDelta.slice(0, 80).map((delta) => (
                <i key={delta.price} className={delta.net >= 0 ? "positive" : "negative"} style={{ height: `${Math.min(100, Math.abs(delta.net) / Math.max(maxTotal, 1) * 160)}%` }} />
              ))}
            </div>
          </section>

          {settings.showCvd && (
            <section className="dom-pro-panel dom-pro-cvd">
              <PanelTitle title="CVD" status="CUMULATIVE VOLUME DELTA" />
              <div className="dom-pro-cvd-line">
                {cvdData.length === 0 ? <EmptyState text="Trade stream unavailable for this venue." /> : cvdData.map((point, index) => (
                  <i key={`${point.time}-${index}`} style={{ left: `${index / Math.max(1, cvdData.length - 1) * 100}%`, bottom: `${50 + normalizeCvd(point.value, cvdData) * 42}%` }} />
                ))}
              </div>
            </section>
          )}

          {settings.showDiagnostics && (
            <section className="dom-pro-panel dom-pro-performance">
              <PanelTitle title="Performance" status={snapshot.renderStats.lastRenderMs > 12 ? "LOAD HIGH" : "OK"} />
              <Metric label="DOM Updates / Sec" value={snapshot.renderStats.updateRate.toFixed(1)} />
              <Metric label="DOM Render FPS" value={snapshot.renderStats.renderFps.toFixed(1)} />
              <Metric label="Visible Buckets" value={String(snapshot.renderStats.visibleBuckets)} />
              <Metric label="Bucket Size" value={`${formatPrice(snapshot.renderStats.bucketSize)} ${marketSymbol.quoteAsset}`} />
              <Metric label="Dropped Frames" value={String(snapshot.renderStats.droppedFrames)} />
              <Metric label="Last Render" value={`${snapshot.renderStats.lastRenderMs.toFixed(2)} ms`} />
              <Metric label="Memory Estimate" value={`${snapshot.renderStats.memoryEstimateKb} KB`} />
              <Metric label="Subscriptions" value={String(snapshot.renderStats.subscriptionCount)} />
              {snapshot.renderStats.lastRenderMs > 12 && <div className="dom-pro-warning">DOM Pro+ render load high. Increase bucket size or reduce FPS.</div>}
            </section>
          )}

          {settings.showExecutionPanel && (
            <section className="dom-pro-panel dom-pro-execution">
              <PanelTitle title="Execution" status={selectedConnection ? selectedConnection.label.toUpperCase() : "NO ACCOUNT"} />
              <div className="dom-pro-order-types">
                {orderTypes.map((type) => <button key={type} type="button" className={orderType === type ? "active" : ""} onClick={() => setOrderType(type)}>{type.toUpperCase()}</button>)}
              </div>
              <div className="dom-pro-side-buttons">
                <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>BUY</button>
                <button type="button" className={side === "sell" ? "active sell" : "sell"} onClick={() => setSide("sell")}>SELL</button>
              </div>
              <label><span>Qty ({marketSymbol.baseAsset})</span><input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" /></label>
              <label><span>Price ({marketSymbol.quoteAsset})</span><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /></label>
              <label><span>Margin</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}><option value="cross">Cross</option><option value="isolated">Isolated</option></select></label>
              <label><span>TIF</span><select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}><option value="gtc">GTC</option><option value="ioc">IOC</option><option value="fok">FOK</option></select></label>
              <div className="dom-pro-checks">
                <label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post Only</label>
                <label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce Only</label>
              </div>
              <div className="dom-pro-submit-row">
                <button type="button" onClick={() => submitQuickOrder("buy")}>Place Buy</button>
                <button type="button" className="sell" onClick={() => submitQuickOrder("sell")}>Place Sell</button>
              </div>
              <p>{executionStatus || "Orders route through OMS / EMS / Risk."}</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function PanelTitle({ title, status }: { title: string; status?: string }) {
  return <div className="dom-pro-panel-title"><span>{title}</span>{status && <b>{status}</b>}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="dom-pro-stat"><span>{label}</span><b>{value}</b></div>;
}

function Metric({ label, value, note, hot }: { label: string; value: string; note?: string; hot?: boolean }) {
  return <div className="dom-pro-metric"><span>{label}</span><b className={hot ? "hot" : ""}>{value}</b>{note && <em>{note}</em>}</div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="dom-pro-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
}

function Field({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="dom-pro-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="dom-pro-empty">{text}</div>;
}

function buildExecutionAccount(connection: ConnectionDiagnostics): PortfolioAccount {
  return {
    id: connection.accountId || connection.id,
    exchange: connection.provider as MarketSymbol["exchange"],
    label: connection.label,
    accountName: connection.label,
    permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
    isPaper: false,
    connectedAt: connection.createdAt,
    lastValidatedAt: connection.updatedAt,
    status: connection.status === "connected" ? "connected" : "degraded",
    apiHealth: connection.metadata.executionReady === true ? "healthy" : "warning",
    latencyMs: connection.health.latencyMs,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: 0,
    availableMargin: 0,
    buyingPower: 0,
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls: defaultRiskControls
  };
}

function formatPrice(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatSize(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function formatCompact(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return "--";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Number(value));
}

function signed(value?: number, suffix = "") {
  if (!Number.isFinite(value ?? NaN)) return "--";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}${suffix}`;
}

function formatTime(time: number) {
  return new Date(time * 1000).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeCvd(value: number, points: Array<{ value: number }>) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0;
  return ((value - min) / (max - min) - 0.5) * 2;
}
