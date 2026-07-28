/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from “Stop Loss Clustering (Breakouts) [Kioseff Trading]”
 * © KioseffTrading. See reference/pine/kioseff-stop-loss-clustering-v6.pine.
 */
import type { Timeframe } from "../../../market-data/types";
import type { KioseffChartBarInput, NormalizedCandle } from "../data/types.ts";
import { kioseffTimeframeSeconds } from "../data/timeframes.ts";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION,
  canonicalClusterId,
  canonicalizeSnapshot,
  type CanonicalCluster,
  type CanonicalDiagnostic,
  type KioseffSnapshot
} from "./canonical.ts";
import {
  pineBinarySearchLeftmost,
  pineBinarySearchRightmost,
  pineSortedInsertRightmost
} from "./pineCollections.ts";
import type { KioseffCalculationEngine, KioseffEngineContext } from "./engineTypes.ts";
import { nearestFromCluster, ratioModel, sideForSignedVolume } from "./outputModel.ts";
import { PineAtr, PineSma } from "./pineSeries.ts";
import { pinePercentileNearestRank } from "./pineStatistics.ts";
import { pineTimeframeDayChange } from "./pineTime.ts";
import { parseDecimalStep, pineTickIndex } from "./ticks.ts";

type VolTime = {
  volume: number;
  time: number;
  creationTime: number;
  violationTime: number | null;
  sequence: number;
  sourceCount: number;
};
type BarStat = { high: number; low: number; time: number };
type HigherState = {
  active: Map<number, VolTime>;
  activeKeys: number[];
  removed: Map<number, VolTime>;
  removedKeys: number[];
  sequence: number;
};
type LowerState = {
  levels: number[];
  active: VolTime[];
  removed: VolTime[];
  frozenWidth: number | null;
  sequence: number;
};
export type VolatilityAtEntryEngineState = {
  bars: NormalizedCandle[];
  barStats: BarStat[];
  previousIntrabarClose: number | null;
  intrabarAtr: ReturnType<PineAtr["snapshot"]>;
  chartAtr: ReturnType<PineAtr["snapshot"]>;
  widthSma: number[];
  buyAverageSma: number[];
  sellAverageSma: number[];
  higher: HigherState;
  lower: LowerState;
  cumulativeBuyRemoved: number;
  cumulativeSellRemoved: number;
  pane: KioseffSnapshot["pane"];
  alerts: KioseffSnapshot["alerts"];
  lastAlertBuyTime: number | null;
  lastAlertSellTime: number | null;
  committedThrough: number | null;
};

type DisplayCell = {
  priceLow: number;
  priceHigh: number;
  volume: number;
  startTime: number;
  endTime: number | null;
  violationTime: number | null;
  sourceCount: number;
  sequence: number;
  priceKey: string | number;
};

const TOTAL_FACTORS = 18;

function blankVolTime(sequence: number): VolTime {
  return {
    volume: 0,
    time: 0,
    creationTime: 0,
    violationTime: null,
    sequence,
    sourceCount: 0
  };
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function sign(value: number) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function topFiveThreshold(values: readonly number[]) {
  const top = [0, 0, 0, 0, 0];
  for (const value of values) {
    if (value > top[0]!) {
      const insertion = pineBinarySearchRightmost(top, value);
      top.splice(insertion, 0, value);
      top.shift();
    }
  }
  return top[0]!;
}

function copyVolTime(value: VolTime): VolTime {
  return { ...value };
}

export class VolatilityAtEntryEngine
  implements KioseffCalculationEngine<VolatilityAtEntryEngineState>
{
  private context: KioseffEngineContext;
  private tick: ReturnType<typeof parseDecimalStep>;
  private factors: number[];
  private intrabarAtr = new PineAtr(14);
  private chartAtr = new PineAtr(14);
  private widthSma = new PineSma(50);
  private buyAverageSma = new PineSma(50);
  private sellAverageSma = new PineSma(50);
  private state!: VolatilityAtEntryEngineState;
  private lastSnapshot!: KioseffSnapshot;

  constructor(context: KioseffEngineContext) {
    this.context = context;
    this.tick = parseDecimalStep(context.metadata.tickSize);
    const scalingSeconds = kioseffTimeframeSeconds(
      context.settings.volatilityAtEntry.timeScaledVolatilityTimeframe as Timeframe
    );
    const t0 = scalingSeconds / 60;
    this.factors = [1, 5, 15, 30, 60, 240].flatMap((minutes) =>
      [1, 1.5, 2].map((multiplier) => Math.sqrt(minutes / t0) * multiplier)
    );
    if (this.factors.length !== TOTAL_FACTORS) throw new Error("VAE factor contract is not 18.");
    this.reset();
  }

  reset() {
    this.intrabarAtr = new PineAtr(14);
    this.chartAtr = new PineAtr(14);
    this.widthSma = new PineSma(50);
    this.buyAverageSma = new PineSma(50);
    this.sellAverageSma = new PineSma(50);
    this.state = {
      bars: [],
      barStats: [],
      previousIntrabarClose: null,
      intrabarAtr: this.intrabarAtr.snapshot(),
      chartAtr: this.chartAtr.snapshot(),
      widthSma: [],
      buyAverageSma: [],
      sellAverageSma: [],
      higher: {
        active: new Map(),
        activeKeys: [],
        removed: new Map(),
        removedKeys: [],
        sequence: 0
      },
      lower: { levels: [], active: [], removed: [], frozenWidth: null, sequence: 0 },
      cumulativeBuyRemoved: 0,
      cumulativeSellRemoved: 0,
      pane: [],
      alerts: [],
      lastAlertBuyTime: null,
      lastAlertSellTime: null,
      committedThrough: null
    };
    this.lastSnapshot = this.buildSnapshot(null, null, 0, 0, []);
  }

  private deleteDirection(keys: readonly number[], close: number, higher: boolean) {
    let direction = -1;
    if (keys.length > 1000) {
      const bottom = keys.reduce((minimum, value) => Math.min(minimum, value), Infinity);
      const top = keys.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
      const topPrice = higher ? Math.floor(top * this.tick.value) : top;
      const bottomPrice = higher ? Math.floor(bottom * this.tick.value) : bottom;
      if (Math.abs(topPrice - close) <= Math.abs(close - bottomPrice)) direction = 0;
    }
    return direction;
  }

  private pruneHigher(
    map: Map<number, VolTime>,
    keys: number[],
    direction: number,
    sort: boolean
  ) {
    if (keys.length <= 25_000) return;
    if (sort) keys.sort((left, right) => left - right);
    while (keys.length > 20_000) {
      const index = direction < 0 ? keys.length - 1 : 0;
      const key = keys[index]!;
      map.delete(key);
      keys.splice(index, 1);
    }
  }

  private moveHigherCrossed(
    low: number,
    high: number,
    barTime: number
  ) {
    const state = this.state.higher;
    const lowKey = pineTickIndex(low, this.tick);
    const highKey = pineTickIndex(high, this.tick);
    let getLow = pineBinarySearchRightmost(state.activeKeys, lowKey);
    let getHigh = pineBinarySearchLeftmost(state.activeKeys, highKey) + 1;
    getLow = Math.max(0, Math.min(state.activeKeys.length, getLow));
    getHigh = Math.max(0, Math.min(state.activeKeys.length, getHigh));
    let buyHit = 0;
    let sellHit = 0;
    if (getHigh > getLow) {
      for (let index = getHigh - 1; index >= getLow; index -= 1) {
        const key = state.activeKeys[index]!;
        const record = state.active.get(key);
        if (!record) continue;
        state.active.delete(key);
        if (barTime > record.time) {
          if (!state.removed.has(key)) state.removedKeys.push(key);
          state.removed.set(key, {
            ...record,
            violationTime: barTime
          });
        }
        if (sign(record.volume) === -1) {
          buyHit += record.volume;
          this.state.cumulativeBuyRemoved += record.volume;
        } else if (sign(record.volume) === 1) {
          sellHit += record.volume;
          this.state.cumulativeSellRemoved += record.volume;
        }
        state.activeKeys.splice(index, 1);
      }
    }
    return { buyHit, sellHit };
  }

  private processHigherIntrabar(
    intrabar: NormalizedCandle,
    atr: number,
    signedVolume: number,
    barTime: number
  ) {
    const direction = sign(signedVolume);
    const hlc3 = (intrabar.high + intrabar.low + intrabar.close) / 3;
    for (const factor of this.factors) {
      const projected = hlc3 + atr * factor * direction;
      const key = pineTickIndex(projected, this.tick);
      let record = this.state.higher.active.get(key);
      if (!record) {
        pineSortedInsertRightmost(this.state.higher.activeKeys, key);
        record = {
          volume: signedVolume / TOTAL_FACTORS,
          time: barTime,
          creationTime: barTime,
          violationTime: null,
          sequence: this.state.higher.sequence++,
          sourceCount: 1
        };
        this.state.higher.active.set(key, record);
      } else {
        record.volume += signedVolume / TOTAL_FACTORS;
        record.time = barTime;
        record.sourceCount += 1;
      }
    }
    return this.moveHigherCrossed(intrabar.low, intrabar.high, barTime);
  }

  private extendLower(
    projected: number,
    intrabar: NormalizedCandle,
    barTime: number
  ) {
    const lower = this.state.lower;
    const width = lower.frozenWidth!;
    let addedLower = 0;
    let addedHigher = 0;
    let highest = lower.levels.at(-1)!;
    let lowest = lower.levels[0]!;
    while (Math.max(intrabar.high, projected) >= highest) {
      highest += width;
      const sequence = lower.sequence++;
      lower.levels.push(highest);
      lower.active.push(blankVolTime(sequence));
      lower.removed.push(blankVolTime(sequence));
      addedHigher += 1;
    }
    while (Math.min(intrabar.low, projected) <= lowest) {
      lowest -= width;
      const sequence = lower.sequence++;
      lower.levels.unshift(lowest);
      lower.active.unshift(blankVolTime(sequence));
      lower.removed.unshift(blankVolTime(sequence));
      addedLower += 1;
    }
    this.findAddedStarts(addedLower, true, barTime);
    this.findAddedStarts(addedHigher, false, barTime);
  }

  private findAddedStarts(count: number, unshift: boolean, barTime: number) {
    if (!count) return;
    const lower = this.state.lower;
    const width = lower.frozenWidth!;
    const start = unshift ? 0 : lower.active.length - count;
    const end = unshift ? count - 1 : lower.active.length - 1;
    const barEnd = Math.max(0, this.state.barStats.length - 1000);
    for (let index = start; index <= end; index += 1) {
      const record = lower.active[index]!;
      const level = lower.levels[index]!;
      record.time = barTime;
      record.creationTime = barTime;
      for (let barIndex = this.state.barStats.length - 1; barIndex >= barEnd; barIndex -= 1) {
        const candidate = this.state.barStats[barIndex]!;
        record.time = candidate.time;
        record.creationTime = candidate.time;
        if (Math.max(candidate.low, level) <= Math.min(candidate.high, level + width)) break;
      }
    }
  }

  private moveLowerCrossed(low: number, high: number, barTime: number) {
    const lower = this.state.lower;
    let getLow = pineBinarySearchRightmost(lower.levels, low);
    let getHigh = pineBinarySearchLeftmost(lower.levels, high) + 1;
    getLow = Math.max(0, Math.min(lower.levels.length, getLow));
    getHigh = Math.max(0, Math.min(lower.levels.length, getHigh));
    let buyHit = 0;
    let sellHit = 0;
    if (getHigh > getLow) {
      for (let index = getHigh - 1; index >= getLow; index -= 1) {
        const active = lower.active[index]!;
        lower.removed[index] = { ...active, violationTime: barTime };
        if (sign(active.volume) === -1) {
          buyHit += active.volume;
          this.state.cumulativeBuyRemoved += active.volume;
        } else if (sign(active.volume) === 1) {
          sellHit += active.volume;
          this.state.cumulativeSellRemoved += active.volume;
        }
        active.time = barTime;
        active.volume = 0;
        active.sourceCount = 0;
      }
    }
    return { buyHit, sellHit };
  }

  private processLowerIntrabar(
    intrabar: NormalizedCandle,
    atr: number,
    signedVolume: number,
    barTime: number
  ) {
    const lower = this.state.lower;
    const direction = sign(signedVolume);
    const hlc3 = (intrabar.high + intrabar.low + intrabar.close) / 3;
    for (const factor of this.factors) {
      const projected = hlc3 + atr * factor * direction;
      this.extendLower(projected, intrabar, barTime);
      let index = pineBinarySearchLeftmost(lower.levels, projected);
      index = Math.max(0, Math.min(lower.levels.length - 1, index));
      const record = lower.active[index]!;
      record.volume += signedVolume / TOTAL_FACTORS;
      record.sourceCount += 1;
      if (record.creationTime === 0) record.creationTime = barTime;
    }
    return this.moveLowerCrossed(intrabar.low, intrabar.high, barTime);
  }

  private pruneLower(direction: number) {
    const lower = this.state.lower;
    while (lower.levels.length > 2500) {
      const index = direction < 0 ? lower.levels.length - 1 : 0;
      lower.levels.splice(index, 1);
      lower.active.splice(index, 1);
      lower.removed.splice(index, 1);
    }
  }

  private dailyGap(
    bar: NormalizedCandle,
    previous: NormalizedCandle | undefined,
    granularity: "higher" | "lower"
  ) {
    if (!previous || !pineTimeframeDayChange(bar.time, previous.time)) return { buyHit: 0, sellHit: 0 };
    if (!(bar.open > previous.high || bar.open < previous.low)) return { buyHit: 0, sellHit: 0 };
    const low = bar.open > previous.high ? previous.high : bar.open;
    const high = bar.open > previous.high ? bar.open : previous.low;
    return granularity === "higher"
      ? this.moveHigherCrossed(low, high, bar.time)
      : this.moveLowerCrossed(low, high, bar.time);
  }

  processBar(input: KioseffChartBarInput, emitSnapshot = true) {
    const bar = input.chartBar;
    const previousBar = this.state.bars.at(-1);
    this.state.bars.push(bar);
    this.state.barStats.push({ high: bar.high, low: bar.low, time: bar.time });
    const chartAtr = this.chartAtr.update(bar.high, bar.low, bar.close);
    const widthProxy = this.widthSma.update(chartAtr);
    const granularity = this.context.settings.volatilityAtEntry.granularity;
    if (
      granularity === "lower" &&
      this.state.lower.frozenWidth === null &&
      widthProxy !== undefined
    ) {
      const width = widthProxy / 4;
      this.state.lower.frozenWidth = width;
      this.state.lower.levels = [bar.open - width, bar.open, bar.open + width];
      this.state.lower.active = [0, 1, 2].map(() => blankVolTime(this.state.lower.sequence++));
      this.state.lower.removed = [0, 1, 2].map(() => blankVolTime(this.state.lower.sequence++));
    }
    const activeDirection =
      granularity === "higher"
        ? this.deleteDirection(this.state.higher.activeKeys, bar.close, true)
        : this.deleteDirection(this.state.lower.levels, bar.close, false);
    const removedDirection =
      granularity === "higher"
        ? this.deleteDirection(this.state.higher.removedKeys, bar.close, true)
        : -1;
    let buyHit = 0;
    let sellHit = 0;
    for (const intrabar of input.intrabars) {
      const atr = this.intrabarAtr.update(intrabar.high, intrabar.low, intrabar.close);
      const signedVolume =
        this.state.previousIntrabarClose === null
          ? 0
          : intrabar.volume * sign(intrabar.close - this.state.previousIntrabarClose) * -1;
      this.state.previousIntrabarClose = intrabar.close;
      if (atr === undefined) continue;
      if (granularity === "higher") {
        const hit = this.processHigherIntrabar(intrabar, atr, signedVolume, bar.time);
        buyHit += hit.buyHit;
        sellHit += hit.sellHit;
      } else if (this.state.lower.frozenWidth !== null) {
        const hit = this.processLowerIntrabar(intrabar, atr, signedVolume, bar.time);
        buyHit += hit.buyHit;
        sellHit += hit.sellHit;
      }
    }
    if (granularity === "higher") {
      this.pruneHigher(this.state.higher.active, this.state.higher.activeKeys, activeDirection, false);
      this.pruneHigher(this.state.higher.removed, this.state.higher.removedKeys, removedDirection, true);
    } else if (this.state.lower.frozenWidth !== null) {
      this.pruneLower(activeDirection);
    }
    const gapHit = this.dailyGap(bar, previousBar, granularity);
    buyHit += gapHit.buyHit;
    sellHit += gapHit.sellHit;
    const buyAverage = this.buyAverageSma.update(buyHit);
    const sellAverage = this.sellAverageSma.update(sellHit);
    const radiateBuy = buyAverage !== undefined && buyHit <= buyAverage;
    const radiateSell = sellAverage !== undefined && sellHit >= sellAverage;
    if (radiateBuy && this.state.lastAlertBuyTime !== bar.time) {
      this.state.alerts.push({
        id: `buy:${bar.time}`,
        time: bar.time,
        side: "buy-stop",
        title: "Large Buy-Stop Cluster Triggered",
        message: "Large Buy-Stop Cluster Triggered"
      });
      this.state.lastAlertBuyTime = bar.time;
    }
    if (radiateSell && this.state.lastAlertSellTime !== bar.time) {
      this.state.alerts.push({
        id: `sell:${bar.time}`,
        time: bar.time,
        side: "sell-stop",
        title: "Large Sell-Stop Cluster Triggered",
        message: "Large Sell-Stop Cluster Triggered"
      });
      this.state.lastAlertSellTime = bar.time;
    }
    this.state.pane.push({
      time: bar.time,
      buyStopsHit: buyHit === 0 ? null : buyHit,
      sellStopsHit: sellHit === 0 ? null : sellHit,
      buyAverage: buyAverage ?? null,
      sellAverage: sellAverage ?? null,
      radiateBuy,
      radiateSell
    });
    this.state.committedThrough = input.chartBarClosed ? bar.time : this.state.committedThrough;
    this.state.intrabarAtr = this.intrabarAtr.snapshot();
    this.state.chartAtr = this.chartAtr.snapshot();
    this.state.widthSma = this.widthSma.snapshot();
    this.state.buyAverageSma = this.buyAverageSma.snapshot();
    this.state.sellAverageSma = this.sellAverageSma.snapshot();
    const diagnostics: CanonicalDiagnostic[] = [];
    if (!input.quality.complete) {
      diagnostics.push({
        code: "incomplete-intrabar-coverage",
        severity: "error",
        message: "VAE calculation received incomplete one-minute coverage.",
        barTime: bar.time,
        data: { actual: input.quality.actualCount, expected: input.quality.expectedCount }
      });
    }
    if (emitSnapshot) {
      this.lastSnapshot = this.buildSnapshot(
        bar.time,
        input.chartBarClosed ? null : bar.time,
        buyHit,
        sellHit,
        diagnostics
      );
    }
    return this.lastSnapshot;
  }

  private higherCells(map: Map<number, VolTime>, keysSource: readonly number[], removed: boolean) {
    const keys = [...keysSource].sort((left, right) => left - right);
    if (!keys.length) return [];
    const binCount = removed ? 450 : 495;
    const bottom = keys[0]! * this.tick.value;
    const top = keys.at(-1)! * this.tick.value;
    const distance = (top - bottom) / binCount || this.tick.value;
    const cells: DisplayCell[] = [];
    for (let index = 0; index <= binCount; index += 1) {
      const priceLow = bottom + distance * index;
      const priceHigh = bottom + distance * (index + 1);
      const lowKey = pineTickIndex(priceLow, this.tick);
      const highKey = pineTickIndex(priceHigh, this.tick);
      const records = keys
        .filter((key) => key >= lowKey && key <= highKey)
        .map((key) => map.get(key)!)
        .filter(Boolean);
      if (!records.length) continue;
      cells.push({
        priceLow,
        priceHigh,
        volume: sum(records.map((record) => Math.abs(record.volume))),
        startTime: Math.min(...records.map((record) => record.time)),
        endTime: removed ? Math.max(...records.map((record) => record.time)) : null,
        violationTime: removed
          ? Math.max(...records.map((record) => record.violationTime ?? record.time))
          : null,
        sourceCount: sum(records.map((record) => record.sourceCount)),
        sequence: Math.min(...records.map((record) => record.sequence)),
        priceKey: `${lowKey}-${highKey}`
      });
    }
    return cells;
  }

  private lowerActiveCells(close: number) {
    const lower = this.state.lower;
    if (!lower.levels.length || lower.frozenWidth === null) return [];
    let closest = pineBinarySearchLeftmost(lower.levels, close);
    closest = Math.max(0, Math.min(lower.levels.length - 1, closest));
    let up = closest;
    let down = closest;
    const cells: DisplayCell[] = [];
    while (cells.length < 495 && (up < lower.levels.length || down >= 0)) {
      if (up === down && up < lower.levels.length) {
        cells.push(this.lowerCell(up, false)!);
        up += 1;
        down -= 1;
      } else {
        if (up < lower.levels.length && cells.length < 495) cells.push(this.lowerCell(up++, false)!);
        if (down >= 0 && cells.length < 495) cells.unshift(this.lowerCell(down--, false)!);
      }
    }
    return cells;
  }

  private lowerCell(index: number, removed: boolean): DisplayCell | null {
    const lower = this.state.lower;
    if (lower.frozenWidth === null) return null;
    const record = (removed ? lower.removed : lower.active)[index];
    const priceLow = lower.levels[index];
    if (!record || priceLow === undefined) return null;
    return {
      priceLow,
      priceHigh: priceLow + lower.frozenWidth,
      volume: record.volume,
      startTime: record.time,
      endTime: removed ? record.time : null,
      violationTime: removed ? record.violationTime : null,
      sourceCount: record.sourceCount,
      sequence: record.sequence,
      priceKey: priceLow.toString()
    };
  }

  private lowerRemovedCells() {
    if (!this.context.settings.volatilityAtEntry.showHistoricalTriggers) return [];
    const lower = this.state.lower;
    return lower.removed
      .map((record, index) => ({ record, index }))
      .sort((left, right) => Math.abs(right.record.volume) - Math.abs(left.record.volume))
      .slice(0, 450)
      .map(({ index }) => this.lowerCell(index, true))
      .filter((cell): cell is DisplayCell => cell !== null);
  }

  private canonicalCells(cells: DisplayCell[], state: "active" | "violated", close: number) {
    const p95 = pinePercentileNearestRank(cells.map((cell) => Math.abs(cell.volume)), 95) ?? 0;
    const hotThreshold = topFiveThreshold(cells.map((cell) => Math.abs(cell.volume)));
    return cells
      .filter((cell) => cell.volume !== 0)
      .map((cell): CanonicalCluster => {
        const price = (cell.priceLow + cell.priceHigh) / 2;
        const side = price < close ? "buy-stop" : "sell-stop";
        const signedVolume =
          this.context.settings.volatilityAtEntry.granularity === "higher"
            ? side === "buy-stop"
              ? -Math.abs(cell.volume)
              : Math.abs(cell.volume)
            : cell.volume;
        return {
          id: canonicalClusterId({
            model: "volatility-at-entry",
            side,
            priceKey: cell.priceKey,
            creationTime: cell.startTime,
            creationSequence: cell.sequence
          }),
          side,
          state,
          signedVolume,
          price,
          priceLow: cell.priceLow,
          priceHigh: cell.priceHigh,
          tickIndex:
            this.context.settings.volatilityAtEntry.granularity === "higher"
              ? pineTickIndex(price, this.tick)
              : null,
          creationTime: cell.startTime,
          startTime: cell.startTime || null,
          violationTime: cell.violationTime,
          endTime: cell.endTime,
          strength: Math.abs(cell.volume) >= p95 ? "strong" : "weak",
          hot: Math.abs(cell.volume) >= hotThreshold,
          sourceCount: cell.sourceCount,
          opacity: null
        };
      });
  }

  private buildSnapshot(
    barTime: number | null,
    provisionalBarTime: number | null,
    buyHit: number,
    sellHit: number,
    diagnostics: CanonicalDiagnostic[]
  ) {
    const close = this.state.bars.at(-1)?.close ?? 0;
    const granularity = this.context.settings.volatilityAtEntry.granularity;
    const activeCells =
      granularity === "higher"
        ? this.higherCells(this.state.higher.active, this.state.higher.activeKeys, false)
        : this.lowerActiveCells(close);
    const removedCells =
      granularity === "higher"
        ? this.higherCells(this.state.higher.removed, this.state.higher.removedKeys, true)
        : this.lowerRemovedCells();
    const active = this.canonicalCells(activeCells, "active", close);
    const violated = this.canonicalCells(removedCells, "violated", close);
    const activeBuyTotal = sum(active.filter((cluster) => cluster.price < close).map((cluster) => Math.abs(cluster.signedVolume)));
    const activeSellTotal = sum(active.filter((cluster) => cluster.price >= close).map((cluster) => Math.abs(cluster.signedVolume)));
    const violatedBuyTotal = this.state.cumulativeBuyRemoved;
    const violatedSellTotal = this.state.cumulativeSellRemoved;
    const hotBuy = active
      .filter((cluster) => cluster.hot && cluster.price < close)
      .sort((left, right) => right.price - left.price)[0];
    const hotSell = active
      .filter((cluster) => cluster.hot && cluster.price >= close)
      .sort((left, right) => left.price - right.price)[0];
    const nearestBuy = nearestFromCluster(hotBuy, null, activeBuyTotal);
    const nearestSell = nearestFromCluster(hotSell, null, activeSellTotal);
    const latestPane = this.state.pane.at(-1);
    return canonicalizeSnapshot({
      schemaVersion: KIOSEFF_SCHEMA_VERSION,
      engineVersion: KIOSEFF_ENGINE_VERSION,
      model: "volatility-at-entry",
      granularity,
      symbol: {
        exchange: this.context.metadata.exchange,
        rawSymbol: this.context.metadata.rawSymbol,
        assetClass: this.context.metadata.assetClass,
        tickSize: this.context.metadata.tickSize
      },
      timeframe: this.context.timeframe,
      sourceVersion: this.context.sourceVersion,
      committedThrough: this.state.committedThrough,
      provisionalBarTime,
      activeClusters: active,
      violatedClusters: violated,
      qCurves: [],
      outputs: {
        buyStopsHit: buyHit === 0 ? null : buyHit,
        sellStopsHit: sellHit === 0 ? null : sellHit,
        buyStopsAverage: latestPane?.buyAverage ?? null,
        sellStopsAverage: latestPane?.sellAverage ?? null,
        nearestBuy,
        nearestSell,
        activeBuyTotal,
        activeSellTotal,
        violatedBuyTotal,
        violatedSellTotal,
        typicalBuyMove: null,
        typicalSellMove: null,
        radiateBuy: latestPane?.radiateBuy ?? false,
        radiateSell: latestPane?.radiateSell ?? false
      },
      pane: this.state.pane,
      alerts: this.state.alerts,
      summary: { nearestBuy, nearestSell },
      ratioMeter: ratioModel({
        activeBuy: activeBuyTotal,
        activeSell: activeSellTotal,
        violatedBuy: violatedBuyTotal,
        violatedSell: violatedSellTotal
      }),
      diagnostics,
    });
  }

  exportState() {
    return structuredClone(this.state);
  }

  importState(state: VolatilityAtEntryEngineState) {
    this.state = structuredClone(state);
    this.intrabarAtr.restore(this.state.intrabarAtr);
    this.chartAtr.restore(this.state.chartAtr);
    this.widthSma.restore(this.state.widthSma);
    this.buyAverageSma.restore(this.state.buyAverageSma);
    this.sellAverageSma.restore(this.state.sellAverageSma);
    this.lastSnapshot = this.buildSnapshot(
      this.state.bars.at(-1)?.time ?? null,
      null,
      0,
      0,
      []
    );
  }

  snapshot() {
    return this.lastSnapshot;
  }
}
