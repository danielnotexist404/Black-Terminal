import type { PineValue } from "./pineValue.ts";

export class PineHistorySeries<T> {
  private values: T[] = [];

  push(value: T) {
    this.values.push(value);
  }

  current(): PineValue<T> {
    return this.values.at(-1);
  }

  history(offset: number): PineValue<T> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`Pine history offset must be a non-negative integer: ${offset}`);
    }
    return this.values[this.values.length - 1 - offset];
  }

  replaceCurrent(value: T) {
    if (!this.values.length) this.values.push(value);
    else this.values[this.values.length - 1] = value;
  }

  snapshot() {
    return [...this.values];
  }

  restore(values: readonly T[]) {
    this.values = [...values];
  }

  get length() {
    return this.values.length;
  }
}

export class PineSma {
  private values: number[] = [];
  private readonly lengthValue: number;

  constructor(length: number) {
    if (!Number.isInteger(length) || length <= 0) throw new RangeError(`Invalid SMA length: ${length}`);
    this.lengthValue = length;
  }

  update(value: PineValue<number>): PineValue<number> {
    if (value !== undefined) {
      this.values.push(value);
      if (this.values.length > this.lengthValue) this.values.shift();
    }
    if (this.values.length < this.lengthValue) return undefined;
    return this.values.reduce((sum, item) => sum + item, 0) / this.lengthValue;
  }

  snapshot() {
    return [...this.values];
  }

  restore(values: readonly number[]) {
    this.values = [...values].slice(-this.lengthValue);
  }
}

export class PineRma {
  private seed: number[] = [];
  private value: PineValue<number>;
  private readonly lengthValue: number;

  constructor(length: number) {
    if (!Number.isInteger(length) || length <= 0) throw new RangeError(`Invalid RMA length: ${length}`);
    this.lengthValue = length;
  }

  update(source: PineValue<number>): PineValue<number> {
    if (source === undefined) return this.value;
    if (this.value === undefined) {
      this.seed.push(source);
      if (this.seed.length < this.lengthValue) return undefined;
      this.value = this.seed.reduce((sum, item) => sum + item, 0) / this.lengthValue;
      this.seed = [];
      return this.value;
    }
    this.value = (source + (this.lengthValue - 1) * this.value) / this.lengthValue;
    return this.value;
  }

  snapshot() {
    return { seed: [...this.seed], value: this.value };
  }

  restore(snapshot: { seed: number[]; value: PineValue<number> }) {
    this.seed = [...snapshot.seed];
    this.value = snapshot.value;
  }
}

export class PineAtr {
  private previousClose: PineValue<number>;
  private rma: PineRma;

  constructor(length = 14) {
    this.rma = new PineRma(length);
  }

  update(high: number, low: number, close: number): PineValue<number> {
    const trueRange =
      this.previousClose === undefined
        ? high - low
        : Math.max(
            high - low,
            Math.abs(high - this.previousClose),
            Math.abs(low - this.previousClose)
          );
    this.previousClose = close;
    return this.rma.update(trueRange);
  }

  snapshot() {
    return { previousClose: this.previousClose, rma: this.rma.snapshot() };
  }

  restore(snapshot: ReturnType<PineAtr["snapshot"]>) {
    this.previousClose = snapshot.previousClose;
    this.rma.restore(snapshot.rma);
  }
}
