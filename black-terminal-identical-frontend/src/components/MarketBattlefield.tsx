import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Volume2, VolumeX, Zap } from "lucide-react";
import type { MarketSymbol } from "../market-data/types";
import { useDomFeed } from "../modules/dom-pro/useDomFeed";
import "../styles/market-battlefield.css";

type MarketBattlefieldProps = {
  marketSymbol: MarketSymbol;
  displaySymbol: string;
  exchangeLabel: string;
  fallbackPrice: number;
};

type BattlefieldTelemetry = {
  buyerShare: number;
  buyerDepth: number;
  sellerDepth: number;
  buyCount: number;
  sellCount: number;
  buyNotional: number;
  sellNotional: number;
  price: number;
  priceChangePercent: number;
};

type Explosion = { x: number; y: number; born: number; size: number; side: "buy" | "sell" };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);
const priceText = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function drawTank(ctx: CanvasRenderingContext2D, x: number, y: number, side: "buy" | "sell", scale: number, moving: number) {
  const direction = side === "buy" ? -1 : 1;
  const color = side === "buy" ? "#3bffad" : "#ff3658";
  const dark = side === "buy" ? "#0a644b" : "#681426";
  ctx.save();
  ctx.translate(x, y + Math.sin(moving * 4 + x) * 1.4);
  ctx.scale(direction * scale, scale);
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fillStyle = "rgba(0,0,0,.75)";
  ctx.beginPath();
  ctx.roundRect(-27, 8, 54, 15, 5);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.roundRect(-22, -4, 42, 18, 4);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.roundRect(-9, -12, 22, 12, 4);
  ctx.fill();
  ctx.fillRect(8, -8, 31, 3);
  ctx.globalAlpha = 1;
  for (let wheel = -18; wheel <= 18; wheel += 12) {
    ctx.fillStyle = "#050708";
    ctx.beginPath();
    ctx.arc(wheel, 18, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSoldier(ctx: CanvasRenderingContext2D, x: number, y: number, side: "buy" | "sell", scale: number, phase: number) {
  const direction = side === "buy" ? -1 : 1;
  const color = side === "buy" ? "#67ffc0" : "#ff5570";
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(direction * scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.35;
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  ctx.arc(0, -8, 2.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.lineTo(0, 5);
  ctx.moveTo(0, -1);
  ctx.lineTo(7, 2);
  ctx.lineTo(12, 1);
  ctx.moveTo(0, 5);
  ctx.lineTo(-4 + Math.sin(phase) * 2, 12);
  ctx.moveTo(0, 5);
  ctx.lineTo(5 - Math.sin(phase) * 2, 12);
  ctx.stroke();
  ctx.restore();
}

function drawJet(ctx: CanvasRenderingContext2D, x: number, y: number, side: "buy" | "sell", scale: number) {
  const direction = side === "buy" ? -1 : 1;
  const color = side === "buy" ? "#72ffd0" : "#ff4b68";
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(direction * scale, scale);
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(24, 0);
  ctx.lineTo(1, -4);
  ctx.lineTo(-14, -16);
  ctx.lineTo(-7, -3);
  ctx.lineTo(-27, 0);
  ctx.lineTo(-7, 3);
  ctx.lineTo(-14, 16);
  ctx.lineTo(1, 4);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.moveTo(-30, 0);
  ctx.lineTo(-130, 0);
  ctx.stroke();
  ctx.restore();
}

function drawBomber(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(205,215,222,.8)";
  ctx.shadowColor = "rgba(255,255,255,.4)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(50, 0);
  ctx.lineTo(8, -7);
  ctx.lineTo(-18, -28);
  ctx.lineTo(-4, -4);
  ctx.lineTo(-47, -2);
  ctx.lineTo(-47, 2);
  ctx.lineTo(-4, 4);
  ctx.lineTo(-18, 28);
  ctx.lineTo(8, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawExplosion(ctx: CanvasRenderingContext2D, explosion: Explosion, now: number) {
  const age = (now - explosion.born) / 900;
  if (age < 0 || age > 1) return;
  const radius = explosion.size * (0.25 + age * 1.25);
  const glow = ctx.createRadialGradient(explosion.x, explosion.y, 0, explosion.x, explosion.y, radius);
  glow.addColorStop(0, `rgba(255,255,224,${1 - age})`);
  glow.addColorStop(0.2, `rgba(255,174,48,${0.95 - age * 0.7})`);
  glow.addColorStop(0.55, `rgba(255,42,30,${0.65 - age * 0.55})`);
  glow.addColorStop(1, "rgba(25,20,18,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(explosion.x, explosion.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = explosion.side === "buy" ? `rgba(83,255,179,${0.55 - age * 0.5})` : `rgba(255,58,87,${0.55 - age * 0.5})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(explosion.x, explosion.y, radius * 1.5, 0, Math.PI * 2);
  ctx.stroke();
}

function paintBattlefield(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  telemetry: BattlefieldTelemetry,
  smoothedShare: number,
  explosions: Explosion[]
) {
  ctx.clearRect(0, 0, width, height);
  const horizon = height * 0.17;
  const frontX = width * (0.72 - smoothedShare * 0.44);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#06080c");
  sky.addColorStop(0.22, "#0b1115");
  sky.addColorStop(1, "#060806");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const haze = ctx.createRadialGradient(frontX, horizon + 80, 10, frontX, horizon + 80, width * 0.55);
  haze.addColorStop(0, "rgba(255,95,55,.13)");
  haze.addColorStop(0.45, "rgba(77,255,178,.035)");
  haze.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#0d1210";
  ctx.beginPath();
  ctx.moveTo(0, horizon + 40);
  for (let x = 0; x <= width + 60; x += 60) {
    ctx.lineTo(x, horizon + 26 + Math.sin(x * 0.011 + time * 0.00008) * 18 + Math.sin(x * 0.024) * 9);
  }
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.fill();

  const groundTop = horizon + 30;
  const sellGround = ctx.createLinearGradient(0, groundTop, width, height);
  sellGround.addColorStop(0, "rgba(87,15,30,.72)");
  sellGround.addColorStop(1, "rgba(27,8,13,.72)");
  ctx.fillStyle = sellGround;
  ctx.beginPath();
  ctx.moveTo(0, groundTop);
  ctx.lineTo(frontX + 24, groundTop);
  ctx.lineTo(frontX - 48, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  const buyGround = ctx.createLinearGradient(width, groundTop, 0, height);
  buyGround.addColorStop(0, "rgba(9,70,52,.75)");
  buyGround.addColorStop(1, "rgba(5,31,25,.74)");
  ctx.fillStyle = buyGround;
  ctx.beginPath();
  ctx.moveTo(frontX + 24, groundTop);
  ctx.lineTo(width, groundTop);
  ctx.lineTo(width, height);
  ctx.lineTo(frontX - 48, height);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = "#b9c4be";
  ctx.lineWidth = 1;
  for (let y = groundTop + 42; y < height; y += 52) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y + (y - groundTop) * 0.1);
    ctx.stroke();
  }
  for (let x = 40; x < width; x += 90) {
    ctx.beginPath();
    ctx.moveTo(width / 2 + (x - width / 2) * 0.28, groundTop);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.restore();

  const roadY = height * 0.68;
  ctx.strokeStyle = "rgba(213,210,189,.12)";
  ctx.lineWidth = 28;
  ctx.beginPath();
  ctx.moveTo(0, roadY + 30);
  ctx.bezierCurveTo(width * 0.28, roadY - 50, width * 0.66, roadY + 42, width, roadY - 58);
  ctx.stroke();
  ctx.strokeStyle = "rgba(245,234,200,.35)";
  ctx.setLineDash([16, 18]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  const pulse = 0.65 + Math.sin(time * 0.006) * 0.2;
  ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
  ctx.shadowColor = smoothedShare >= 0.5 ? "#4dffb2" : "#ff304f";
  ctx.shadowBlur = 18;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(frontX + 24, groundTop);
  ctx.bezierCurveTo(frontX - 20, height * 0.42, frontX + 25, height * 0.7, frontX - 48, height);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const frontPrice = telemetry.price;
  ctx.font = "700 11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  for (let step = -3; step <= 3; step += 1) {
    const y = groundTop + ((step + 3) / 6) * (height - groundTop - 20);
    const stepPrice = frontPrice * (1 + step * 0.00075);
    ctx.fillStyle = "rgba(236,241,238,.48)";
    ctx.fillText(priceText(stepPrice), frontX + Math.sin(step * 1.7) * 20, y);
  }

  for (let i = 0; i < 7; i += 1) {
    const laneY = groundTop + 92 + (i % 4) * Math.max(52, (height - groundTop - 150) / 4);
    const sellerRange = Math.max(80, frontX - 130);
    const buyerRange = Math.max(80, width - frontX - 130);
    const sellerX = Math.min(frontX - 45, 55 + ((time * (0.012 + i * 0.0015) + i * 137) % sellerRange));
    const buyerX = Math.max(frontX + 45, width - 55 - ((time * (0.011 + i * 0.0017) + i * 149) % buyerRange));
    drawTank(ctx, sellerX, laneY + (i % 2) * 24, "sell", clamp(width / 1450, 0.58, 1.04), time * 0.001 + i);
    drawTank(ctx, buyerX, laneY + 20 - (i % 2) * 18, "buy", clamp(width / 1450, 0.58, 1.04), time * 0.001 + i);
  }

  const soldierCount = width < 900 ? 18 : 34;
  for (let i = 0; i < soldierCount; i += 1) {
    const y = groundTop + 72 + ((i * 47) % Math.max(90, height - groundTop - 105));
    const spread = 42 + (i % 7) * 10;
    drawSoldier(ctx, frontX - spread - Math.sin(i * 3.1) * 24, y, "sell", 0.7 + (y / height) * 0.35, time * 0.009 + i);
    drawSoldier(ctx, frontX + spread + Math.cos(i * 2.4) * 24, y + 10, "buy", 0.7 + (y / height) * 0.35, time * 0.009 + i);
  }

  const jetWidth = width + 260;
  drawJet(ctx, -130 + (time * 0.085 % jetWidth), horizon * 0.54, "sell", 0.72);
  drawJet(ctx, width + 130 - (time * 0.105 % jetWidth), horizon * 0.82, "buy", 0.62);
  drawBomber(ctx, -160 + (time * 0.026 % (width + 320)), horizon * 0.28, 0.72);

  for (let i = 0; i < 12; i += 1) {
    const cycle = (time * (0.05 + i * 0.002) + i * 157) % 540;
    const fromBuy = i % 2 === 0;
    const progress = cycle / 540;
    const startX = frontX + (fromBuy ? 130 : -130);
    const endX = frontX + (fromBuy ? -85 : 85);
    const y = groundTop + 80 + (i * 79) % Math.max(120, height - groundTop - 120);
    const x = startX + (endX - startX) * progress;
    ctx.strokeStyle = fromBuy ? "rgba(91,255,190,.52)" : "rgba(255,72,98,.55)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (fromBuy ? 26 : -26), y - 2);
    ctx.stroke();
  }

  explosions.forEach((item) => drawExplosion(ctx, item, time));

  const vignette = ctx.createRadialGradient(width / 2, height * 0.55, height * 0.2, width / 2, height * 0.55, width * 0.72);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.72)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

export function MarketBattlefield({ marketSymbol, displaySymbol, exchangeLabel, fallbackPrice }: MarketBattlefieldProps) {
  const feed = useDomFeed(marketSymbol);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const telemetryRef = useRef<BattlefieldTelemetry | null>(null);
  const smoothedShareRef = useRef(0.5);
  const audioRef = useRef<AudioContext | null>(null);
  const audioTimerRef = useRef<number | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);

  const telemetry = useMemo<BattlefieldTelemetry>(() => {
    const bids = feed.book?.bids.slice(0, 40) ?? [];
    const asks = feed.book?.asks.slice(0, 40) ?? [];
    const buyerDepth = bids.reduce((sum, level) => sum + level.quantity, 0);
    const sellerDepth = asks.reduce((sum, level) => sum + level.quantity, 0);
    const recentCutoff = Math.floor(Date.now() / 1000) - 30;
    const trades = feed.trades.filter((trade) => trade.time >= recentCutoff).slice(0, 120);
    const buyTrades = trades.filter((trade) => trade.side === "buy");
    const sellTrades = trades.filter((trade) => trade.side === "sell");
    const buyNotional = buyTrades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0);
    const sellNotional = sellTrades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0);
    const depthTotal = buyerDepth + sellerDepth;
    const tradeTotal = buyNotional + sellNotional;
    const depthShare = depthTotal > 0 ? buyerDepth / depthTotal : 0.5;
    const tradeShare = tradeTotal > 0 ? buyNotional / tradeTotal : 0.5;
    const buyerShare = clamp(depthShare * 0.68 + tradeShare * 0.32, 0.04, 0.96);
    return {
      buyerShare,
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

  telemetryRef.current = telemetry;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const explosions: Explosion[] = [];
    let frame = 0;
    let width = 1;
    let height = 1;
    let lastExplosionAt = 0;
    let lastFrameAt = performance.now();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (now: number) => {
      const data = telemetryRef.current;
      if (!data) return;
      const elapsed = Math.min(50, now - lastFrameAt);
      lastFrameAt = now;
      const smoothing = 1 - Math.pow(0.985, elapsed / 16.67);
      smoothedShareRef.current += (data.buyerShare - smoothedShareRef.current) * smoothing;
      const intensity = 0.25 + Math.abs(smoothedShareRef.current - 0.5) * 1.3;
      const explosionDelay = reducedMotion ? 2200 : 560 - intensity * 220;
      if (now - lastExplosionAt > explosionDelay) {
        lastExplosionAt = now;
        const frontX = width * (0.72 - smoothedShareRef.current * 0.44);
        explosions.push({
          x: frontX + (Math.random() - 0.5) * Math.min(210, width * 0.24),
          y: height * (0.28 + Math.random() * 0.58),
          born: now,
          size: 12 + Math.random() * 24,
          side: Math.random() < data.buyerShare ? "buy" : "sell"
        });
      }
      while (explosions.length && now - explosions[0].born > 950) explosions.shift();
      paintBattlefield(context, width, height, reducedMotion ? 0 : now, data, smoothedShareRef.current, explosions);
      frame = window.requestAnimationFrame(render);
    };
    frame = window.requestAnimationFrame(render);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);

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
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
    noise.buffer = noiseBuffer;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 520 + Math.random() * 280;
    noiseFilter.Q.value = 0.72;
    noiseGain.gain.setValueAtTime(0.12, now);
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
    audioTimerRef.current = window.setInterval(() => playBoom(), 1150 + Math.random() * 650);
  };

  useEffect(() => () => {
    if (audioTimerRef.current) window.clearInterval(audioTimerRef.current);
    void audioRef.current?.close();
  }, []);

  const buyersAdvancing = telemetry.buyerShare >= 0.5;
  const buyerPercent = telemetry.buyerShare * 100;
  const statusText = feed.book ? `${feed.bookStatus} / ${feed.tradeStatus}` : "AWAITING LIVE ORDER FLOW";

  return (
    <section className="market-battlefield" aria-label={`${displaySymbol} live order-flow battlefield`}>
      <canvas ref={canvasRef} className="battlefield-canvas" aria-hidden="true" />
      <div className="battlefield-scanlines" aria-hidden="true" />

      <header className="battlefield-hud">
        <div className="battlefield-title">
          <span><Radio size={13} /> LIVE MARKET WARFARE</span>
          <strong>{displaySymbol} BATTLEFIELD</strong>
          <small>{exchangeLabel.toUpperCase()} · AGGREGATED ORDER FLOW</small>
        </div>
        <div className="battlefield-price">
          <span>{marketSymbol.baseAsset}/{marketSymbol.quoteAsset}</span>
          <strong>${priceText(telemetry.price)}</strong>
          <small className={telemetry.priceChangePercent >= 0 ? "positive" : "negative"}>
            {telemetry.priceChangePercent >= 0 ? "+" : ""}{telemetry.priceChangePercent.toFixed(2)}% 24H
          </small>
        </div>
        <div className="battlefield-controls">
          <span className={feed.book ? "live" : "waiting"}><i />{statusText}</span>
          <button type="button" onClick={() => void toggleSound()} aria-pressed={soundEnabled} title={soundEnabled ? "Mute battlefield audio" : "Enable battlefield audio"}>
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            {soundEnabled ? "AUDIO ON" : "ENABLE AUDIO"}
          </button>
        </div>
      </header>

      <aside className="battlefield-army seller-army">
        <span>SELLER COMMAND</span>
        <strong>{compact(telemetry.sellerDepth)} {marketSymbol.baseAsset}</strong>
        <dl>
          <div><dt>AGGRESSORS</dt><dd>{telemetry.sellCount}</dd></div>
          <div><dt>30S FIREPOWER</dt><dd>${compact(telemetry.sellNotional)}</dd></div>
          <div><dt>TERRITORY</dt><dd>{(100 - buyerPercent).toFixed(1)}%</dd></div>
        </dl>
      </aside>

      <aside className="battlefield-army buyer-army">
        <span>BUYER COMMAND</span>
        <strong>{compact(telemetry.buyerDepth)} {marketSymbol.baseAsset}</strong>
        <dl>
          <div><dt>AGGRESSORS</dt><dd>{telemetry.buyCount}</dd></div>
          <div><dt>30S FIREPOWER</dt><dd>${compact(telemetry.buyNotional)}</dd></div>
          <div><dt>TERRITORY</dt><dd>{buyerPercent.toFixed(1)}%</dd></div>
        </dl>
      </aside>

      <div className={`battlefield-command ${buyersAdvancing ? "buyers" : "sellers"}`}>
        <Zap size={14} />
        <span>MARKET PRESSURE</span>
        <strong>{buyersAdvancing ? "BUYERS ADVANCING" : "SELLERS ADVANCING"}</strong>
        <small>{Math.abs(buyerPercent - 50).toFixed(1)} pressure points from equilibrium</small>
      </div>

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
