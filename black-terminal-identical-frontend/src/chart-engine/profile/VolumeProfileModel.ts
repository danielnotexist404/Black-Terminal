import type { Candle, VolumeProfileSettings } from "../types";

export type VolumeProfileRow = {
  index: number;
  priceLow: number;
  priceHigh: number;
  price: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  valueArea: boolean;
  supplyDemand: "supply" | "demand" | null;
  profileGap: boolean;
};

export type HdlxPoint = {
  index: number;
  value: number;
};

export type DevelopingPocPoint = {
  index: number;
  price: number;
};

export type VolumeProfileResult = {
  rows: VolumeProfileRow[];
  startIndex: number;
  endIndex: number;
  profileHigh: number;
  profileLow: number;
  pocIndex: number;
  pocPrice: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  totalVolume: number;
  averageVolume: number;
  developingPoc: DevelopingPocPoint[];
  hdlx: HdlxPoint[];
};

export class VolumeProfileModel {
  calculate(
    candles: Candle[],
    visibleFirstIndex: number,
    visibleLastIndex: number,
    settings: VolumeProfileSettings,
    fixedWindow?: { startIndex: number; endIndex: number }
  ): VolumeProfileResult | null {
    if (candles.length < 2) return null;

    const endIndex = fixedWindow
      ? Math.max(0, Math.min(candles.length - 1, fixedWindow.endIndex))
      : settings.rangeMode === "visible"
        ? Math.max(0, Math.min(candles.length - 1, visibleLastIndex))
        : candles.length - 1;
    const rangeLength = Math.max(10, Math.min(20000, Math.round(settings.fixedRangeLength)));
    const startIndex = fixedWindow
      ? Math.max(0, Math.min(fixedWindow.startIndex, endIndex))
      : settings.rangeMode === "visible"
        ? Math.max(0, Math.min(visibleFirstIndex, endIndex))
        : Math.max(0, endIndex - rangeLength + 1);
    if (endIndex <= startIndex) return null;

    const profileCandles = candles.slice(startIndex, endIndex + 1);
    const profileHigh = Math.max(...profileCandles.map((candle) => candle.high));
    const profileLow = Math.min(...profileCandles.map((candle) => candle.low));
    const range = Math.max(profileHigh - profileLow, Math.max(profileHigh, 1) * 0.00001);
    const rowsCount = Math.max(10, Math.min(150, Math.round(settings.rows)));
    const rowStep = range / rowsCount;
    const rows: VolumeProfileRow[] = Array.from({ length: rowsCount }, (_, index) => {
      const priceLow = profileLow + rowStep * index;
      const priceHigh = index === rowsCount - 1 ? profileHigh : priceLow + rowStep;
      return {
        index,
        priceLow,
        priceHigh,
        price: (priceLow + priceHigh) / 2,
        totalVolume: 0,
        buyVolume: 0,
        sellVolume: 0,
        delta: 0,
        valueArea: false,
        supplyDemand: null,
        profileGap: false
      };
    });

    const developingPoc: DevelopingPocPoint[] = [];
    const runningVolumes = Array.from({ length: rowsCount }, () => 0);
    profileCandles.forEach((candle, offset) => {
      this.distributeCandle(rows, candle, profileLow, rowStep, settings, runningVolumes);
      let developingPocIndex = 0;
      let developingMaxVolume = 0;
      for (let index = 0; index < runningVolumes.length; index++) {
        if (runningVolumes[index] > developingMaxVolume) {
          developingMaxVolume = runningVolumes[index];
          developingPocIndex = index;
        }
      }
      developingPoc.push({ index: startIndex + offset, price: rows[developingPocIndex]?.price ?? candle.close });
    });

    let totalVolume = 0;
    let maxVolume = 0;
    let pocIndex = 0;
    for (const row of rows) {
      row.sellVolume = Math.max(0, row.totalVolume - row.buyVolume);
      row.delta = row.buyVolume - row.sellVolume;
      totalVolume += row.totalVolume;
      if (row.totalVolume > maxVolume) {
        maxVolume = row.totalVolume;
        pocIndex = row.index;
      }
    }

    const targetValueArea = totalVolume * (Math.max(0, Math.min(100, settings.valueAreaPercent)) / 100);
    let valueVolume = rows[pocIndex]?.totalVolume ?? 0;
    let lowIndex = pocIndex;
    let highIndex = pocIndex;
    let guard = rows.length * 2;
    while (valueVolume < targetValueArea && guard-- > 0) {
      if (lowIndex <= 0 && highIndex >= rows.length - 1) break;
      const nextHigh = highIndex < rows.length - 1 ? rows[highIndex + 1].totalVolume : -1;
      const nextLow = lowIndex > 0 ? rows[lowIndex - 1].totalVolume : -1;
      if (nextHigh >= nextLow) {
        highIndex += 1;
        valueVolume += Math.max(0, nextHigh);
      } else {
        lowIndex -= 1;
        valueVolume += Math.max(0, nextLow);
      }
    }

    for (let index = lowIndex; index <= highIndex; index++) {
      rows[index].valueArea = true;
    }

    const threshold = Math.max(0, Math.min(41, settings.supplyDemandThreshold)) / 100;
    const gapWindow = Math.max(1, Math.round(rows.length * (Math.max(0, Math.min(100, settings.nodeDetectionPercent)) / 100)));
    for (const row of rows) {
      if (maxVolume > 0 && row.totalVolume / maxVolume < threshold) {
        row.supplyDemand = row.index > pocIndex ? "supply" : "demand";
      }

      if (this.isProfileGap(rows, row.index, gapWindow)) {
        row.profileGap = true;
      }
    }

    return {
      rows,
      startIndex,
      endIndex,
      profileHigh,
      profileLow,
      pocIndex,
      pocPrice: rows[pocIndex]?.price ?? profileLow,
      valueAreaHigh: rows[Math.min(rows.length - 1, highIndex)]?.priceHigh ?? profileHigh,
      valueAreaLow: rows[Math.max(0, lowIndex)]?.priceLow ?? profileLow,
      totalVolume,
      averageVolume: totalVolume / Math.max(1, profileCandles.length),
      developingPoc,
      hdlx: settings.hdlxOscillator || settings.hdlxEnableBarColoring
        ? this.calculateHdlx(candles, startIndex, endIndex, settings)
        : []
    };
  }

  private distributeCandle(
    rows: VolumeProfileRow[],
    candle: Candle,
    profileLow: number,
    rowStep: number,
    settings: VolumeProfileSettings,
    runningVolumes?: number[]
  ) {
    const candleHigh = Math.max(candle.high, candle.low);
    const candleLow = Math.min(candle.high, candle.low);
    const candleRange = Math.max(candleHigh - candleLow, rowStep, Math.max(candle.close, 1) * 0.00001);
    const startRow = Math.max(0, Math.min(rows.length - 1, Math.floor((candleLow - profileLow) / rowStep)));
    const endRow = Math.max(0, Math.min(rows.length - 1, Math.floor((candleHigh - profileLow) / rowStep)));
    const isBuying = settings.polarityMethod === "pressure"
      ? candle.close - candle.low > candle.high - candle.close
      : candle.close > candle.open;

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
      const row = rows[rowIndex];
      const overlapLow = Math.max(candleLow, row.priceLow);
      const overlapHigh = Math.min(candleHigh, row.priceHigh);
      const overlap = Math.max(0, overlapHigh - overlapLow);
      const portion = Math.max(0.0001, Math.min(1, overlap / candleRange));
      const volume = candle.volume * portion;
      row.totalVolume += volume;
      if (runningVolumes) runningVolumes[rowIndex] += volume;
      if (isBuying) row.buyVolume += volume;
    }
  }

  private isProfileGap(rows: VolumeProfileRow[], index: number, window: number) {
    const row = rows[index];
    if (!row || row.totalVolume < 0) return false;
    let neighborTotal = 0;
    let neighborCount = 0;
    for (let offset = -window; offset <= window; offset++) {
      if (offset === 0) continue;
      const neighbor = rows[index + offset];
      if (!neighbor) continue;
      neighborTotal += neighbor.totalVolume;
      neighborCount += 1;
    }
    if (neighborCount === 0) return false;
    const neighborAverage = neighborTotal / neighborCount;
    return row.totalVolume < neighborAverage * 0.42;
  }

  private calculateHdlx(candles: Candle[], startIndex: number, endIndex: number, settings: VolumeProfileSettings) {
    const lookback = Math.max(20, Math.min(5000, Math.round(settings.hdlxLookback)));
    const smooth = Math.max(1, Math.min(50, Math.round(settings.hdlxSmooth)));
    const source = candles.map((candle) => this.priceSource(candle, settings.hdlxPriceSource));
    const alpha = 2 / (smooth + 1);
    const logDeviation: number[] = [];
    const values: HdlxPoint[] = [];
    let priceVolumeSum = 0;
    let volumeSum = 0;
    let logSum = 0;
    let logSquareSum = 0;
    let ema = 0;

    for (let index = 0; index <= endIndex; index++) {
      const weight = Math.max(0, candles[index].volume);
      priceVolumeSum += source[index] * weight;
      volumeSum += weight;

      const expiredPriceIndex = index - lookback;
      if (expiredPriceIndex >= 0) {
        const expiredWeight = Math.max(0, candles[expiredPriceIndex].volume);
        priceVolumeSum -= source[expiredPriceIndex] * expiredWeight;
        volumeSum -= expiredWeight;
      }

      const vwma = volumeSum > 0 ? priceVolumeSum / volumeSum : source[index];
      const logValue = vwma > 0 && source[index] > 0 ? Math.log(source[index] / vwma) : 0;
      logDeviation[index] = logValue;
      logSum += logValue;
      logSquareSum += logValue * logValue;

      const expiredLogIndex = index - lookback;
      if (expiredLogIndex >= 0) {
        const expiredLog = logDeviation[expiredLogIndex] ?? 0;
        logSum -= expiredLog;
        logSquareSum -= expiredLog * expiredLog;
      }

      const windowSize = Math.min(index + 1, lookback);
      const mean = logSum / Math.max(1, windowSize);
      const variance = Math.max(0, logSquareSum / Math.max(1, windowSize) - mean * mean);
      const deviation = Math.sqrt(variance);
      const rawZ = deviation > 0 ? logValue / deviation : 0;
      ema = index === 0 ? rawZ : rawZ * alpha + ema * (1 - alpha);

      if (index >= startIndex) values.push({ index, value: ema });
    }
    return values;
  }

  private priceSource(candle: Candle, source: VolumeProfileSettings["hdlxPriceSource"]) {
    if (source === "hl2") return (candle.high + candle.low) / 2;
    if (source === "hlc3") return (candle.high + candle.low + candle.close) / 3;
    if (source === "ohlc4") return (candle.open + candle.high + candle.low + candle.close) / 4;
    return candle.close;
  }
}
