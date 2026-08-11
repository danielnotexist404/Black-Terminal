import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Layers3, Radio, Volume2, VolumeX, Zap } from "lucide-react";
import { BattlefieldScene, type BattlefieldTelemetry } from "../battlefield/BattlefieldScene";
import type { MarketSymbol, OrderBookLevel, TradeTick } from "../market-data/types";
import { useDomFeed } from "../modules/dom-pro/useDomFeed";
import "../styles/market-battlefield.css";

type MarketBattlefieldProps = {
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  fallbackPrice: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);
const priceText = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function buildDepthPath(levels: OrderBookLevel[], side: "bid" | "ask") {
  const sample = levels.slice(0, 24);
  let running = 0;
  const cumulative = sample.map((level) => {
    running += level.quantity;
    return running;
  });
  const maximum = Math.max(1, ...cumulative);
  const points = cumulative.map((value, index) => {
    const progress = index / Math.max(1, cumulative.length - 1);
    const x = side === "bid" ? 128 - progress * 124 : 132 + progress * 124;
    const y = 67 - (value / maximum) * 58;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const start = side === "bid" ? "128,67" : "132,67";
  return [start, ...points].join(" ");
}

function tradeMessage(trade: TradeTick, baseAsset: string) {
  const notional = trade.price * trade.quantity;
  const force = notional >= 250_000 ? "HEAVY STRIKE" : notional >= 50_000 ? "ARMORED PUSH" : "FRONT HIT";
  return `${force} · ${compact(trade.quantity)} ${baseAsset} · $${compact(notional)}`;
}

export function MarketBattlefield({ marketSymbol, displaySymbol, exchangeLabel, fallbackPrice }: MarketBattlefieldProps) {
  const feed = useDomFeed(marketSymbol);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<BattlefieldScene | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const audioTimerRef = useRef<number | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [depthOpen, setDepthOpen] = useState(true);
  const [feedOpen, setFeedOpen] = useState(true);
  const [sceneError, setSceneError] = useState("");

  const telemetry = useMemo<BattlefieldTelemetry>(() => {
    const bids = feed.book?.bids.slice(0, 48) ?? [];
    const asks = feed.book?.asks.slice(0, 48) ?? [];
    const buyerDepth = bids.reduce((sum, level) => sum + level.quantity, 0);
    const sellerDepth = asks.reduce((sum, level) => sum + level.quantity, 0);
    const recentCutoff = Math.floor(Date.now() / 1000) - 30;
    const trades = feed.trades.filter((trade) => trade.time >= recentCutoff).slice(0, 160);
    const buyTrades = trades.filter((trade) => trade.side === "buy");
    const sellTrades = trades.filter((trade) => trade.side === "sell");
    const buyNotional = buyTrades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0);
    const sellNotional = sellTrades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0);
    const depthTotal = buyerDepth + sellerDepth;
    const tradeTotal = buyNotional + sellNotional;
    const depthShare = depthTotal > 0 ? buyerDepth / depthTotal : 0.5;
    const tradeShare = tradeTotal > 0 ? buyNotional / tradeTotal : 0.5;
    return {
      buyerShare: clamp(depthShare * 0.68 + tradeShare * 0.32, 0.04, 0.96),
      buyerDepth,
      sellerDepth,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      buyNotional,
      sellNotional,
      price: feed.ticker?.lastPrice ?? feed.trades[0]?.price ?? fallbackPrice,
      priceChangePercent: feed.ticker?.priceChangePercent ?? 0
    };
  }, [feed.book, feed.ticker, feed.trades, fallbackPrice]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: BattlefieldScene;
    try {
      scene = new BattlefieldScene(canvas, telemetry, setSceneError);
    } catch (error) {
      setSceneError(error instanceof Error ? error.message : "The 3D renderer could not be initialized on this device.");
      return;
    }
    sceneRef.current = scene;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      scene.resize(bounds.width, bounds.height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    scene.start();
    return () => {
      observer.disconnect();
      scene.dispose();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setTelemetry(telemetry);
  }, [telemetry]);

  const playBoom = () => {
    const audio = audioRef.current;
    if (!audio || audio.state !== "running") return;
    const now = audio.currentTime;
    const gain = audio.createGain();
    const oscillator = audio.createOscillator();
    const filter = audio.createBiquadFilter();
    const noiseBuffer = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.55), audio.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noiseData.length; index += 1) {
      const decay = 1 - index / noiseData.length;
      noiseData[index] = (Math.random() * 2 - 1) * decay * decay;
    }
    const noise = audio.createBufferSource();
    const noiseFilter = audio.createBiquadFilter();
    const noiseGain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(72 + Math.random() * 28, now);
    oscillator.frequency.exponentialRampToValueAtTime(28, now + 0.55);
    filter.type = "lowpass";
    filter.frequency.value = 190;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
    noise.buffer = noiseBuffer;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 520 + Math.random() * 280;
    noiseFilter.Q.value = 0.72;
    noiseGain.gain.setValueAtTime(0.11, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    oscillator.connect(filter).connect(gain).connect(audio.destination);
    noise.connect(noiseFilter).connect(noiseGain).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.75);
    noise.start(now);
    noise.stop(now + 0.56);
  };

  const toggleSound = async () => {
    if (soundEnabled) {
      setSoundEnabled(false);
      if (audioTimerRef.current) window.clearInterval(audioTimerRef.current);
      audioTimerRef.current = null;
      await audioRef.current?.suspend();
      return;
    }
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const audio = audioRef.current ?? new AudioContextCtor();
    audioRef.current = audio;
    await audio.resume();
    setSoundEnabled(true);
    playBoom();
    audioTimerRef.current = window.setInterval(() => playBoom(), 1050 + Math.random() * 750);
  };

  useEffect(() => () => {
    if (audioTimerRef.current) window.clearInterval(audioTimerRef.current);
    void audioRef.current?.close();
  }, []);

  const buyersAdvancing = telemetry.buyerShare >= 0.5;
  const buyerPercent = telemetry.buyerShare * 100;
  const statusText = feed.book ? `${feed.bookStatus} / ${feed.tradeStatus}` : "AWAITING LIVE ORDER FLOW";
  const liveTrades = feed.trades.slice(0, 5);

  return (
    <section className="market-battlefield" aria-label={`${displaySymbol} live 3D order-flow battlefield`}>
      <canvas ref={canvasRef} className={sceneError ? "battlefield-canvas failed" : "battlefield-canvas"} aria-hidden="true" />
      <div className="battlefield-scanlines" aria-hidden="true" />
      {sceneError && (
        <div className="battlefield-render-error" role="alert">
          <strong>3D RENDERER OFFLINE</strong>
          <span>{sceneError}</span>
          <small>Return to the chart or enable hardware acceleration, then try again.</small>
        </div>
      )}

      <header className="battlefield-hud">
        <div className="battlefield-title">
          <span><Radio size={13} /> LIVE 3D MARKET WARFARE</span>
          <strong>{displaySymbol} BATTLEFIELD</strong>
          <small>{exchangeLabel.toUpperCase()} · ORDER BOOK + AGGRESSOR FLOW</small>
        </div>
        <div className="battlefield-price">
          <span>{marketSymbol.baseAsset}/{marketSymbol.quoteAsset} · LIVE MID</span>
          <strong>${priceText(telemetry.price)}</strong>
          <small className={telemetry.priceChangePercent >= 0 ? "positive" : "negative"}>
            {telemetry.priceChangePercent >= 0 ? "+" : ""}{telemetry.priceChangePercent.toFixed(2)}% 24H
          </small>
        </div>
        <div className="battlefield-controls">
          <span className={feed.book ? "live" : "waiting"}><i />{statusText}</span>
          <button type="button" onClick={() => sceneRef.current?.recenter()} title="Recenter 3D battlefield"><Crosshair size={16} /><em>RECENTER</em></button>
          <button type="button" onClick={() => void toggleSound()} aria-pressed={soundEnabled} title={soundEnabled ? "Mute battlefield audio" : "Enable battlefield audio"}>
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <em>{soundEnabled ? "AUDIO ON" : "AUDIO"}</em>
          </button>
        </div>
      </header>

      <aside className="battlefield-army seller-army">
        <span>SELLER COMMAND</span>
        <strong>{compact(telemetry.sellerDepth)} {marketSymbol.baseAsset}</strong>
        <dl>
          <div><dt>AGGRESSORS · 30S</dt><dd>{telemetry.sellCount}</dd></div>
          <div><dt>FIREPOWER</dt><dd>${compact(telemetry.sellNotional)}</dd></div>
          <div><dt>TERRITORY</dt><dd>{(100 - buyerPercent).toFixed(1)}%</dd></div>
        </dl>
      </aside>

      <aside className="battlefield-army buyer-army">
        <span>BUYER COMMAND</span>
        <strong>{compact(telemetry.buyerDepth)} {marketSymbol.baseAsset}</strong>
        <dl>
          <div><dt>AGGRESSORS · 30S</dt><dd>{telemetry.buyCount}</dd></div>
          <div><dt>FIREPOWER</dt><dd>${compact(telemetry.buyNotional)}</dd></div>
          <div><dt>TERRITORY</dt><dd>{buyerPercent.toFixed(1)}%</dd></div>
        </dl>
      </aside>

      <div className={`battlefield-command ${buyersAdvancing ? "buyers" : "sellers"}`}>
        <Zap size={14} />
        <span>MARKET PRESSURE</span>
        <strong>{buyersAdvancing ? "BUYERS ADVANCING" : "SELLERS ADVANCING"}</strong>
        <small>{Math.abs(buyerPercent - 50).toFixed(1)} pressure points from equilibrium</small>
      </div>

      <aside className={`battlefield-data-panel depth-panel ${depthOpen ? "open" : "collapsed"}`}>
        <button type="button" onClick={() => setDepthOpen((value) => !value)} aria-expanded={depthOpen}>
          <span><Layers3 size={12} /> ORDER BOOK DEPTH</span><b>{exchangeLabel.toUpperCase()}</b>
        </button>
        {depthOpen && (
          <div className="depth-visualization">
            <svg viewBox="0 0 260 72" role="img" aria-label="Live bid and ask depth curves">
              <defs>
                <linearGradient id="battleBidFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#45ffad" stopOpacity=".38"/><stop offset="1" stopColor="#45ffad" stopOpacity="0"/></linearGradient>
                <linearGradient id="battleAskFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff3558" stopOpacity=".38"/><stop offset="1" stopColor="#ff3558" stopOpacity="0"/></linearGradient>
              </defs>
              <polyline className="bid-depth-line" points={buildDepthPath(feed.book?.bids ?? [], "bid")} />
              <polyline className="ask-depth-line" points={buildDepthPath(feed.book?.asks ?? [], "ask")} />
              <line x1="130" y1="3" x2="130" y2="69" />
              <text x="6" y="68">BIDS {compact(telemetry.buyerDepth)} {marketSymbol.baseAsset}</text>
              <text x="254" y="68" textAnchor="end">ASKS {compact(telemetry.sellerDepth)} {marketSymbol.baseAsset}</text>
            </svg>
          </div>
        )}
      </aside>

      <aside className={`battlefield-data-panel feed-panel ${feedOpen ? "open" : "collapsed"}`}>
        <button type="button" onClick={() => setFeedOpen((value) => !value)} aria-expanded={feedOpen}>
          <span><Radio size={12} /> MARKET COMBAT FEED</span><b>LIVE</b>
        </button>
        {feedOpen && (
          <ol>
            {liveTrades.length ? liveTrades.map((trade) => (
              <li key={trade.tradeId} className={trade.side}>
                <i />
                <span>{tradeMessage(trade, marketSymbol.baseAsset)}</span>
                <time>{new Date(trade.time * 1000).toLocaleTimeString(undefined, { hour12: false, minute: "2-digit", second: "2-digit" })}</time>
              </li>
            )) : <li className="waiting"><i /><span>Establishing live combat telemetry...</span></li>}
          </ol>
        )}
      </aside>

      <div className="battlefield-camera-help"><b>DRAG</b> ROTATE · <b>SCROLL</b> ZOOM · <b>RIGHT DRAG</b> PAN · LIVE STRUCTURE, NOT A PREDICTION</div>

      <footer className="battlefield-meter">
        <div className="seller-meter" style={{ width: `${100 - buyerPercent}%` }} />
        <div className="buyer-meter" style={{ width: `${buyerPercent}%` }} />
        <span className="seller-label">SELL WALL {(100 - buyerPercent).toFixed(1)}%</span>
        <b>FRONT LINE · ${priceText(telemetry.price)}</b>
        <span className="buyer-label">BUY WALL {buyerPercent.toFixed(1)}%</span>
      </footer>
    </section>
  );
}
