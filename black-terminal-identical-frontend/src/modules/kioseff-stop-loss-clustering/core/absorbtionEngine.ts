/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from “Stop Loss Clustering (Breakouts) [Kioseff Trading]”
 * © KioseffTrading. See reference/pine/kioseff-stop-loss-clustering-v6.pine.
 */
import type { NormalizedCandle, KioseffChartBarInput } from "../data/types.ts";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION,
  canonicalClusterId,
  canonicalizeSnapshot,
  type CanonicalCluster,
  type CanonicalCurve,
  type CanonicalDiagnostic,
  type KioseffSnapshot
} from "./canonical.ts";
import type { KioseffCalculationEngine, KioseffEngineContext } from "./engineTypes.ts";
import { nearestFromCluster, ratioModel } from "./outputModel.ts";
import { PineAtr, PineSma } from "./pineSeries.ts";
import { pineMedian, pinePercentileNearestRank } from "./pineStatistics.ts";
import { pineBarDistance, pineTimestampIndex } from "./pineTime.ts";
import { parseDecimalStep } from "./ticks.ts";

type SwingPoint = { price: number; time: number };
type SwingRecord = {
  id: string;
  side: "buy-stop" | "sell-stop";
  volume: number;
  p: number;
  p2: number;
  time: number;
  violationTime: number | null;
  intrabarMove: number | null;
  sourceCount: number;
  sequence: number;
};
type SideState = {
  active: SwingRecord[];
  violated: SwingRecord[];
  pivotFills: number[];
  sequence: number;
};
export type AbsorbtionEngineState = {
  bars: NormalizedCandle[];
  priorPoint: SwingPoint | null;
  extremePoint: SwingPoint | null;
  previousEvaluatedPrior: SwingPoint | null;
  direction: -1 | 0 | 1;
  pivotPrices: number[];
  pivotTimes: number[];
  sell: SideState;
  buy: SideState;
  previousIntrabarClose: number | null;
  atr: ReturnType<PineAtr["snapshot"]>;
  sellPercentileSma: number[];
  buyPercentileSma: number[];
  buyHits: number[];
  sellHits: number[];
  similarBuys: number[];
  similarSells: number[];
  pane: KioseffSnapshot["pane"];
  alerts: KioseffSnapshot["alerts"];
  lastAlertBuyTime: number | null;
  lastAlertSellTime: number | null;
  committedThrough: number | null;
};

function emptySide(): SideState {
  return { active: [], violated: [], pivotFills: [], sequence: 0 };
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function sign(value: number) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function sortedSimilarity(records: readonly SwingRecord[]) {
  return records
    .filter((record) => record.intrabarMove !== null && Math.abs(record.volume) > 0)
    .map((record) => ({ size: Math.log(Math.abs(record.volume)), move: record.intrabarMove! }))
    .sort((left, right) => left.size - right.size);
}

function typicalMove(
  records: readonly SwingRecord[],
  targetVolume: number | undefined,
  force: boolean
) {
  if (targetVolume === undefined || Math.abs(targetVolume) === 0) return null;
  const values = sortedSimilarity(records);
  if (!values.length) return null;
  const target = Math.log(Math.abs(targetVolume));
  let selected: number[] = [];
  if (force) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const value of values) {
      const distance = Math.abs(target - value.size);
      if (distance < bestDistance) {
        bestDistance = distance;
        selected = [value.move];
      } else if (distance === bestDistance) {
        selected.push(value.move);
      }
    }
  } else {
    const differences: number[] = [];
    for (let index = 1; index < values.length; index += 1) {
      differences.push(values[index]!.size - values[index - 1]!.size);
    }
    const window = pinePercentileNearestRank(differences, 75);
    if (window === undefined) return null;
    selected = values
      .filter((value) => value.size >= target - window && value.size <= target + window)
      .map((value) => value.move);
  }
  return pineMedian(selected) ?? null;
}

export class AbsorbtionExtremesEngine
  implements KioseffCalculationEngine<AbsorbtionEngineState>
{
  private context: KioseffEngineContext;
  private tick: ReturnType<typeof parseDecimalStep>;
  private atr = new PineAtr(14);
  private sellPercentileSma = new PineSma(50);
  private buyPercentileSma = new PineSma(50);
  private state!: AbsorbtionEngineState;
  private lastSnapshot!: KioseffSnapshot;

  constructor(context: KioseffEngineContext) {
    this.context = context;
    this.tick = parseDecimalStep(context.metadata.tickSize);
    this.reset();
  }

  reset() {
    this.atr = new PineAtr(14);
    this.sellPercentileSma = new PineSma(50);
    this.buyPercentileSma = new PineSma(50);
    this.state = {
      bars: [],
      priorPoint: null,
      extremePoint: null,
      previousEvaluatedPrior: null,
      direction: 0,
      pivotPrices: [],
      pivotTimes: [],
      sell: emptySide(),
      buy: emptySide(),
      previousIntrabarClose: null,
      atr: this.atr.snapshot(),
      sellPercentileSma: [],
      buyPercentileSma: [],
      buyHits: [],
      sellHits: [],
      similarBuys: [],
      similarSells: [],
      pane: [],
      alerts: [],
      lastAlertBuyTime: null,
      lastAlertSellTime: null,
      committedThrough: null
    };
    this.lastSnapshot = this.buildSnapshot(null, null, 0, 0, []);
  }

  private updateIqzz(bar: NormalizedCandle, atr: number) {
    if (!this.state.extremePoint || !this.state.priorPoint) {
      const point = { price: bar.close, time: bar.time };
      this.state.extremePoint = { ...point };
      this.state.priorPoint = { ...point };
      this.state.previousEvaluatedPrior = { ...point };
      return false;
    }
    const evaluatedPrior = { ...this.state.priorPoint };
    let appended = false;
    if (
      this.state.previousEvaluatedPrior &&
      evaluatedPrior.price !== this.state.previousEvaluatedPrior.price
    ) {
      this.state.pivotPrices.push(evaluatedPrior.price);
      this.state.pivotTimes.push(evaluatedPrior.time);
      appended = true;
    }
    this.state.previousEvaluatedPrior = evaluatedPrior;
    const update = (continuation: boolean, price: number) => {
      const extreme = this.state.extremePoint!;
      if (continuation) {
        this.state.priorPoint = { time: extreme.time, price: this.state.priorPoint!.price };
      } else {
        this.state.priorPoint = { ...extreme };
      }
      this.state.extremePoint = { time: bar.time, price };
    };
    const extreme = this.state.extremePoint;
    if (this.state.direction === 1) {
      const price = Math.max(extreme.price, bar.high);
      if (price === bar.high) update(true, bar.high);
      if (bar.low <= this.state.extremePoint!.price - atr && bar.high !== this.state.extremePoint!.price) {
        this.state.direction = -1;
        update(false, bar.low);
      }
    } else if (this.state.direction === -1) {
      const price = Math.min(bar.low, extreme.price);
      if (price === bar.low) update(true, bar.low);
      if (bar.high >= this.state.extremePoint!.price + atr && bar.low !== this.state.extremePoint!.price) {
        this.state.direction = 1;
        update(false, bar.high);
      }
    } else if (bar.high >= extreme.price + atr) {
      this.state.direction = 1;
      update(false, bar.high);
    } else if (bar.low <= extreme.price - atr) {
      this.state.direction = -1;
      update(false, bar.low);
    }
    return appended;
  }

  private violate(side: SideState, bar: NormalizedCandle, direction: "Down" | "Up") {
    let hit = 0;
    for (let index = side.active.length - 1; index >= 0; index -= 1) {
      const record = side.active[index]!;
      const crossed = direction === "Down" ? bar.high >= record.p2 : bar.low <= record.p2;
      if (!crossed) continue;
      side.active.splice(index, 1);
      record.violationTime = bar.time;
      record.intrabarMove =
        direction === "Down"
          ? Math.abs(bar.high / Math.min(record.p, record.p2) - 1)
          : Math.abs(bar.low / Math.max(record.p, record.p2) - 1);
      side.violated.unshift(record);
      hit += record.volume;
    }
    if (side.active.length && side.pivotFills.length) {
      side.active[0]!.volume += side.pivotFills[0]!;
    }
    return hit;
  }

  private createCluster(
    side: SideState,
    clusterSide: "buy-stop" | "sell-stop",
    bar: NormalizedCandle,
    atr: number,
    pointChanged: boolean
  ) {
    if (!pointChanged || this.state.pivotPrices.length <= 1 || !side.pivotFills.length) return;
    const last = this.state.pivotPrices.at(-1)!;
    const prior = this.state.pivotPrices.at(-2)!;
    const condition = clusterSide === "sell-stop" ? last > prior : last < prior;
    if (!condition) return;
    const pivotTime = this.state.pivotTimes.at(-1)!;
    const barsDiff = pineBarDistance({
      assetClass: this.context.metadata.assetClass,
      currentTime: bar.time,
      pivotTime,
      chartBarMilliseconds: this.timeframeSeconds(),
      currentBarIndex: this.state.bars.length - 1,
      barTimes: this.state.bars.map((item) => item.time)
    });
    if (barsDiff < 0 || barsDiff > side.pivotFills.length) return;
    const historical = this.state.bars[this.state.bars.length - 1 - barsDiff];
    if (!historical) return;
    const volume = sum(side.pivotFills.slice(0, barsDiff));
    const level =
      clusterSide === "sell-stop" ? historical.high + this.tick.value : historical.low - this.tick.value;
    const level2 = clusterSide === "sell-stop" ? level + atr / 4 : level - atr / 4;
    if (side.active.length) side.active[0]!.volume -= volume;
    const sequence = side.sequence++;
    side.active.unshift({
      id: canonicalClusterId({
        model: "absorbtion-extremes",
        side: clusterSide,
        priceKey: level.toString(),
        creationTime: historical.time,
        creationSequence: sequence
      }),
      side: clusterSide,
      volume,
      p: level,
      p2: level2,
      time: historical.time,
      violationTime: null,
      intrabarMove: null,
      sourceCount: barsDiff,
      sequence
    });
    side.pivotFills.length = 0;
  }

  private timeframeSeconds() {
    const unit = this.context.timeframe;
    const map: Record<string, number> = {
      "1s": 1, "10s": 10, "30s": 30, "1m": 60, "3m": 180, "5m": 300,
      "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
      "6h": 21600, "8h": 28800, "12h": 43200, "1d": 86400, "1w": 604800
    };
    return map[unit]!;
  }

  processBar(input: KioseffChartBarInput, emitSnapshot = true) {
    const diagnostics: CanonicalDiagnostic[] = [];
    const bar = input.chartBar;
    this.state.bars.push(bar);
    const chartAtr = this.atr.update(bar.high, bar.low, bar.close);
    const atr = chartAtr ?? bar.high - bar.low;
    let positiveFill = 0;
    let negativeFill = 0;
    for (const intrabar of input.intrabars) {
      const signed =
        this.state.previousIntrabarClose === null
          ? 0
          : intrabar.volume * sign(intrabar.close - this.state.previousIntrabarClose);
      this.state.previousIntrabarClose = intrabar.close;
      if (sign(signed) === 1) positiveFill += signed;
      else if (sign(signed) === -1) negativeFill += signed;
    }
    if (input.intrabars.length) {
      this.state.buy.pivotFills.unshift(positiveFill);
      this.state.sell.pivotFills.unshift(negativeFill);
    }
    const pointChanged = this.updateIqzz(bar, atr * 2);
    const sellHitRaw = this.violate(this.state.sell, bar, "Down");
    const buyHitRaw = this.violate(this.state.buy, bar, "Up");
    this.createCluster(this.state.sell, "sell-stop", bar, atr, pointChanged);
    this.createCluster(this.state.buy, "buy-stop", bar, atr, pointChanged);
    const buyHit = buyHitRaw * -1;
    const sellHit = sellHitRaw * -1;
    if (buyHitRaw !== 0) this.state.buyHits.push(buyHit);
    if (sellHitRaw !== 0) this.state.sellHits.push(sellHit);
    const buyThreshold = this.buyPercentileSma.update(
      pinePercentileNearestRank(this.state.buyHits, 25)
    );
    const sellThreshold = this.sellPercentileSma.update(
      pinePercentileNearestRank(this.state.sellHits, 75)
    );
    const radiateBuy = buyThreshold !== undefined && buyHit <= buyThreshold;
    const radiateSell = sellThreshold !== undefined && sellHit >= sellThreshold;
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
      buyAverage: buyThreshold ?? null,
      sellAverage: sellThreshold ?? null,
      radiateBuy,
      radiateSell
    });
    if (!input.quality.complete) {
      diagnostics.push({
        code: "incomplete-intrabar-coverage",
        severity: "error",
        message: "Absorbtion calculation received incomplete lower-timeframe coverage.",
        barTime: bar.time,
        data: { actual: input.quality.actualCount, expected: input.quality.expectedCount }
      });
    }
    this.state.committedThrough = input.chartBarClosed ? bar.time : this.state.committedThrough;
    this.state.atr = this.atr.snapshot();
    this.state.sellPercentileSma = this.sellPercentileSma.snapshot();
    this.state.buyPercentileSma = this.buyPercentileSma.snapshot();
    if (emitSnapshot) {
      this.lastSnapshot = this.buildSnapshot(bar.time, input.chartBarClosed ? null : bar.time, buyHit, sellHit, diagnostics);
    }
    return this.lastSnapshot;
  }

  private canonicalRecord(record: SwingRecord, state: "active" | "violated"): CanonicalCluster {
    const priceLow = Math.min(record.p, record.p2);
    const priceHigh = Math.max(record.p, record.p2);
    return {
      id: record.id,
      side: record.side,
      state,
      signedVolume: record.volume,
      price: (record.p + record.p2) / 2,
      priceLow,
      priceHigh,
      tickIndex: null,
      creationTime: record.time,
      startTime: record.time,
      violationTime: record.violationTime,
      endTime: state === "violated" ? record.violationTime : null,
      strength: null,
      hot: false,
      sourceCount: record.sourceCount,
      opacity: null
    };
  }

  private curves(barTime: number | null) {
    if (barTime === null) return [];
    const curves: CanonicalCurve[] = [];
    const all = [...this.state.sell.active, ...this.state.buy.active];
    const times = this.state.bars.map((bar) => bar.time);
    for (const record of all) {
      const startIndex = pineTimestampIndex(times, record.time);
      const pivotIndex = this.state.pivotTimes.findIndex((time) => time > record.time);
      const endTime = pivotIndex >= 0 ? this.state.pivotTimes[pivotIndex]! : barTime;
      const endPrice =
        pivotIndex >= 0
          ? this.state.pivotPrices[pivotIndex]!
          : this.state.bars.at(-1)!.low;
      const endIndex = pineTimestampIndex(times, endTime);
      const count = Math.round(endIndex - startIndex);
      if (count === 0) continue;
      const coefficient = (endPrice - record.p) / count ** 2;
      const points: CanonicalCurve["points"] = [];
      for (let index = startIndex; index <= endIndex; index += 1) {
        if (!times[index]) continue;
        const curvedProgress = ((index - startIndex) / count) ** 2.5;
        let price = record.p + coefficient * (curvedProgress * count) ** 2;
        price =
          record.side === "sell-stop" ? Math.max(price, endPrice) : Math.min(price, endPrice);
        points.push({ time: times[index]!, price });
      }
      curves.push({
        id: `q:${record.id}`,
        side: record.side,
        startTime: record.time,
        endTime,
        dashed: true,
        points
      });
    }
    return curves.slice(-50);
  }

  private buildSnapshot(
    barTime: number | null,
    provisionalBarTime: number | null,
    buyHit: number,
    sellHit: number,
    diagnostics: CanonicalDiagnostic[]
  ) {
    const active = [
      ...this.state.sell.active.map((record) => this.canonicalRecord(record, "active")),
      ...this.state.buy.active.map((record) => this.canonicalRecord(record, "active"))
    ];
    const violated = [
      ...this.state.sell.violated.map((record) => this.canonicalRecord(record, "violated")),
      ...this.state.buy.violated.map((record) => this.canonicalRecord(record, "violated"))
    ];
    const activeBuyTotal = sum(this.state.buy.active.map((record) => record.volume));
    const activeSellTotal = sum(this.state.sell.active.map((record) => record.volume));
    const violatedBuyTotal = sum(this.state.buy.violated.map((record) => record.volume));
    const violatedSellTotal = sum(this.state.sell.violated.map((record) => record.volume));
    const nearestBuyCluster = this.state.buy.active[0]
      ? this.canonicalRecord(this.state.buy.active[0], "active")
      : undefined;
    const nearestSellCluster = this.state.sell.active[0]
      ? this.canonicalRecord(this.state.sell.active[0], "active")
      : undefined;
    const typicalBuy = typicalMove(
      this.state.buy.violated,
      nearestBuyCluster?.signedVolume,
      this.context.settings.forceTypicalMove
    );
    const typicalSell = typicalMove(
      this.state.sell.violated,
      nearestSellCluster?.signedVolume,
      this.context.settings.forceTypicalMove
    );
    const nearestBuy = nearestFromCluster(nearestBuyCluster, typicalBuy, activeBuyTotal);
    const nearestSell = nearestFromCluster(nearestSellCluster, typicalSell, activeSellTotal);
    const latestPane = this.state.pane.at(-1);
    return canonicalizeSnapshot({
      schemaVersion: KIOSEFF_SCHEMA_VERSION,
      engineVersion: KIOSEFF_ENGINE_VERSION,
      model: "absorbtion-extremes",
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
      qCurves: this.curves(barTime),
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
        typicalBuyMove: typicalBuy,
        typicalSellMove: typicalSell,
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
      diagnostics
    });
  }

  exportState() {
    return structuredClone(this.state);
  }

  importState(state: AbsorbtionEngineState) {
    this.state = structuredClone(state);
    this.atr.restore(this.state.atr);
    this.sellPercentileSma.restore(this.state.sellPercentileSma);
    this.buyPercentileSma.restore(this.state.buyPercentileSma);
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
