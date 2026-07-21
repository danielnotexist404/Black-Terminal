import { Candle } from "../types";

export class CandleBuffer {
  private data: Candle[];

  constructor(initial: Candle[]) {
    this.data = initial;
  }

  all() {
    return this.data;
  }

  push(candle: Candle, max = 20000) {
    this.data.push(candle);
    if (this.data.length > max) this.data.splice(0, this.data.length - max);
  }

  prepend(candles: Candle[], max = 20000) {
    if (candles.length === 0) return 0;

    const byTime = new Map<number, Candle>();
    for (const candle of [...candles, ...this.data]) {
      byTime.set(candle.time, candle);
    }

    const nextData = [...byTime.values()].sort((a, b) => a.time - b.time);
    const previousFirstTime = this.data[0]?.time;
    this.data = nextData.length > max ? nextData.slice(nextData.length - max) : nextData;
    return previousFirstTime ? this.data.filter((candle) => candle.time < previousFirstTime).length : this.data.length;
  }

  updateLast(partial: Partial<Candle>) {
    const last = this.data[this.data.length - 1];
    if (!last) return;
    Object.assign(last, partial);
  }

  last() {
    return this.data[this.data.length - 1];
  }

  visible(firstIndex: number, lastIndex: number) {
    return this.data.slice(Math.max(0, firstIndex), Math.min(this.data.length, lastIndex + 1));
  }
}
