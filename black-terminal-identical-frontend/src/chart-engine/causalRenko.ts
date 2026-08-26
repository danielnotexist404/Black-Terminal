import type { Candle } from "./types";

export type CausalRenkoAuthority = "SOURCE_CANDLE_CLOSES" | "MIXED_LIVE_TRADES";

export type CausalRenkoSnapshot = {
  candles: Candle[];
  completedCount: number;
  brickSize: number;
  authority: CausalRenkoAuthority;
  epochId: string;
};

const MAX_COMPLETED_BRICKS = 20_000;
const MAX_TRADE_IDENTITIES = 4_096;
const TIME_EPSILON_SECONDS = 0.000_001;

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function timeframeBrickFraction(seconds: number) {
  if (seconds <= 1) return 0.000_2;
  if (seconds <= 10) return 0.000_3;
  if (seconds <= 30) return 0.000_4;
  if (seconds <= 60) return 0.000_6;
  if (seconds <= 180) return 0.000_8;
  if (seconds <= 900) return 0.001_2;
  if (seconds <= 3_600) return 0.002;
  if (seconds <= 14_400) return 0.003_5;
  if (seconds <= 43_200) return 0.005;
  return 0.007_5;
}

function niceStep(raw: number) {
  const safe = finitePositive(raw, 0.01);
  const magnitude = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function inferInitialInterval(candles: readonly Candle[]) {
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index]!.time - candles[index - 1]!.time;
    if (Number.isFinite(delta) && delta > 0) return delta;
  }
  return 60;
}

export function causalRenkoBrickSize(candles: readonly Candle[]) {
  const first = candles[0];
  const reference = finitePositive(first?.open ?? first?.close ?? 0, 1);
  return niceStep(reference * timeframeBrickFraction(inferInitialInterval(candles)));
}

/**
 * Append-only Renko state for the active chart session.
 *
 * The brick size is fixed when the epoch is created. Completed bricks are
 * emitted only from information available at that event and never rewritten
 * by a later ATR/window calculation. Historical bootstrap is explicitly
 * candle-close derived; genuine public trades upgrade only the live tail.
 */
export class CausalRenkoStream {
  private completed: Candle[] = [];
  private brickSize = 1;
  private anchor = 0;
  private direction: -1 | 0 | 1 = 0;
  private forming: Candle | null = null;
  private volumeBucket = 0;
  private authority: CausalRenkoAuthority = "SOURCE_CANDLE_CLOSES";
  private epochId = "renko:empty";
  private lastEventTime = 0;
  private liveTradeSeen = false;
  private seenTradeIds = new Set<string>();
  private seenTradeOrder: string[] = [];

  resetFromCandles(candles: readonly Candle[]) {
    this.completed = [];
    this.direction = 0;
    this.forming = null;
    this.volumeBucket = 0;
    this.authority = "SOURCE_CANDLE_CLOSES";
    this.liveTradeSeen = false;
    this.seenTradeIds.clear();
    this.seenTradeOrder = [];
    this.lastEventTime = 0;

    const first = candles[0];
    if (!first) {
      this.brickSize = 1;
      this.anchor = 0;
      this.epochId = "renko:empty";
      return;
    }

    this.brickSize = causalRenkoBrickSize(candles);
    this.anchor = finitePositive(first.open, finitePositive(first.close, 1));
    this.epochId = `renko:${first.time}:${this.anchor}:${this.brickSize}`;

    // The final source candle is always treated as developing. This keeps the
    // Script Compiler contract intact: candles.at(-2) is the latest confirmed
    // input and candles.at(-1) can never fire a finalized alert.
    for (let index = 0; index < Math.max(0, candles.length - 1); index += 1) {
      const candle = candles[index]!;
      this.consumePrice(candle.close, candle.time, candle.volume);
    }
    const developing = candles.at(-1)!;
    this.observeForming(developing.close, developing.time, developing.volume);
  }

  ingestSourceCandleClose(candle: Candle) {
    if (this.liveTradeSeen) {
      this.observeForming(candle.close, candle.time, candle.volume);
      return false;
    }
    return this.consumePrice(candle.close, candle.time, candle.volume);
  }

  observeSourceCandle(candle: Candle) {
    this.observeForming(candle.close, candle.time, candle.volume);
  }

  ingestTrade(price: number, quantity: number, time: number, identity?: string) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return false;
    if (identity) {
      if (this.seenTradeIds.has(identity)) return false;
      this.seenTradeIds.add(identity);
      this.seenTradeOrder.push(identity);
      if (this.seenTradeOrder.length > MAX_TRADE_IDENTITIES) {
        const expired = this.seenTradeOrder.shift();
        if (expired) this.seenTradeIds.delete(expired);
      }
    }
    this.liveTradeSeen = true;
    this.authority = "MIXED_LIVE_TRADES";
    return this.consumePrice(price, time, Math.max(0, Number.isFinite(quantity) ? quantity : 0));
  }

  hasLiveTrades() {
    return this.liveTradeSeen;
  }

  snapshot(): CausalRenkoSnapshot {
    const candles = this.forming ? [...this.completed, { ...this.forming }] : this.completed.map((candle) => ({ ...candle }));
    return {
      candles,
      completedCount: this.completed.length,
      brickSize: this.brickSize,
      authority: this.authority,
      epochId: this.epochId
    };
  }

  private consumePrice(price: number, time: number, volume: number) {
    if (!Number.isFinite(price) || price <= 0) return false;
    this.volumeBucket += Math.max(0, Number.isFinite(volume) ? volume : 0);
    let emitted = false;
    let guard = 0;

    while (guard < 500) {
      let nextDirection: -1 | 0 | 1 = 0;
      let open = this.anchor;
      let close = this.anchor;

      if (this.direction === 0) {
        if (price >= this.anchor + this.brickSize) {
          nextDirection = 1;
          close = this.anchor + this.brickSize;
        } else if (price <= this.anchor - this.brickSize) {
          nextDirection = -1;
          close = this.anchor - this.brickSize;
        }
      } else if (this.direction === 1) {
        if (price >= this.anchor + this.brickSize) {
          nextDirection = 1;
          close = this.anchor + this.brickSize;
        } else if (price <= this.anchor - 2 * this.brickSize) {
          nextDirection = -1;
          open = this.anchor - this.brickSize;
          close = this.anchor - 2 * this.brickSize;
        }
      } else if (price <= this.anchor - this.brickSize) {
        nextDirection = -1;
        close = this.anchor - this.brickSize;
      } else if (price >= this.anchor + 2 * this.brickSize) {
        nextDirection = 1;
        open = this.anchor + this.brickSize;
        close = this.anchor + 2 * this.brickSize;
      }

      if (nextDirection === 0) break;
      const eventTime = this.uniqueTime(time);
      this.completed.push({
        time: eventTime,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: this.volumeBucket
      });
      if (this.completed.length > MAX_COMPLETED_BRICKS) this.completed.shift();
      this.anchor = close;
      this.direction = nextDirection;
      this.volumeBucket = 0;
      this.forming = null;
      emitted = true;
      guard += 1;
    }

    this.observeForming(price, time, 0);
    return emitted;
  }

  private observeForming(price: number, time: number, volume: number) {
    if (!Number.isFinite(price) || price <= 0) return;
    const formingTime = Math.max(Number.isFinite(time) ? time : 0, this.lastEventTime + TIME_EPSILON_SECONDS);
    if (!this.forming) {
      this.forming = {
        time: formingTime,
        open: this.anchor,
        high: Math.max(this.anchor, price),
        low: Math.min(this.anchor, price),
        close: price,
        volume: Math.max(this.volumeBucket, volume)
      };
      return;
    }
    this.forming = {
      ...this.forming,
      time: formingTime,
      high: Math.max(this.forming.high, price),
      low: Math.min(this.forming.low, price),
      close: price,
      volume: Math.max(this.forming.volume, this.volumeBucket, volume)
    };
  }

  private uniqueTime(time: number) {
    const candidate = Math.max(Number.isFinite(time) ? time : 0, this.lastEventTime + TIME_EPSILON_SECONDS);
    this.lastEventTime = candidate;
    return candidate;
  }
}
