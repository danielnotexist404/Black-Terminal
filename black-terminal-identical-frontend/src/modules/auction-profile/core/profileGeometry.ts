import type {
  AuctionProfileGeometry,
  AuctionProfilePlacement,
  AuctionProfileRow,
  AuctionProfileSettings,
  AuctionProfileSnapshot
} from "./types.ts";

export const AUCTION_PROFILE_RENDERER_KIND = "RANGE_PRICE_PROFILE" as const;

export interface AuctionProfileSegment {
  startTime: number;
  endTime: number;
  value: number;
  deltaValue: number;
  cumulativeValue: number;
  normalizedWidth: number;
  finalized: boolean;
  sourceCount: number;
}

export interface AuctionProfileDisplayBlock extends AuctionProfileSegment {}

export interface AuctionProfileRowProjection {
  rowIndex: number;
  priceLow: number;
  priceHigh: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  netCvd: number;
  absoluteCvd: number;
  cvdEfficiency: number;
  rawWidthValue: number;
  normalizedWidth: number;
  normalizedBuyWidth: number;
  normalizedSellWidth: number;
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  inValueArea: boolean;
  timeSegments: AuctionProfileSegment[];
}

export interface AuctionProfilePlacementBounds {
  left: number;
  right: number;
  center: number;
  width: number;
}

export interface AuctionProfileBarSpan {
  left: number;
  right: number;
  role: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}

function percentile(sorted: readonly number[], percent: number) {
  if (!sorted.length) return 1;
  const index = Math.max(0, Math.min(sorted.length - 1, percent / 100 * (sorted.length - 1)));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

export function auctionProfileRowMetric(row: AuctionProfileRow, settings: AuctionProfileSettings) {
  const delta = row.buyQuantity - row.sellQuantity;
  switch (settings.rendering.profileWidthMetric) {
    case "ABSOLUTE_CVD": return Math.abs(delta);
    case "BUY_VOLUME": return row.buyQuantity;
    case "SELL_VOLUME": return row.sellQuantity;
    case "TOTAL_VOLUME": return row.totalQuantity;
    case "CVD_EFFICIENCY": return row.cvdEfficiency;
    case "IMBALANCE_RATIO": return delta / Math.max(row.buyQuantity + row.sellQuantity, Number.EPSILON);
    case "SELECTED_ENGINE": return row.value;
    case "CVD_ACTIVITY": return Math.abs(delta);
    case "NET_CVD":
    default: return delta;
  }
}

function normalized(value: number, maximum: number, settings: AuctionProfileSettings) {
  const absolute = Math.abs(value);
  if (settings.rendering.normalizationMode === "LOGARITHMIC") return Math.log1p(absolute) / Math.max(Math.log1p(maximum), Number.EPSILON);
  if (settings.rendering.normalizationMode === "SQUARE_ROOT") return Math.sqrt(absolute) / Math.max(Math.sqrt(maximum), Number.EPSILON);
  return Math.min(1, absolute / Math.max(maximum, Number.EPSILON));
}

export function buildAuctionProfileRows(snapshot: AuctionProfileSnapshot, settings: AuctionProfileSettings) {
  const needsCells = settings.rendering.profileBodyStyle === "HDLX_CVD_BLOCKS" || settings.rendering.timeSegmentsMode !== "OFF" || settings.rendering.profileWidthMetric === "CVD_ACTIVITY";
  const cellsByRow = new Map<number, typeof snapshot.matrix.cells>();
  if (needsCells) {
    for (const cell of snapshot.matrix.cells) {
      const cells = cellsByRow.get(cell.rowIndex);
      if (cells) cells.push(cell);
      else cellsByRow.set(cell.rowIndex, [cell]);
    }
    for (const cells of cellsByRow.values()) cells.sort((left, right) => left.startTime - right.startTime || left.blockIndex - right.blockIndex);
  }
  const values = snapshot.rows.map(row => settings.rendering.profileWidthMetric === "CVD_ACTIVITY"
    ? (cellsByRow.get(row.index) ?? []).reduce((sum, cell) => sum + Math.abs(cell.rawValue), 0)
    : auctionProfileRowMetric(row, settings));
  const sorted = values.map(Math.abs).filter(value => value > 0).sort((a, b) => a - b);
  const maximum = settings.rendering.normalizationMode === "ABSOLUTE_FIXED"
    ? settings.rendering.absoluteFixedScale
    : settings.rendering.normalizationMode === "ROBUST_PERCENTILE"
      ? percentile(sorted, settings.rendering.robustUpperPercentile)
      : settings.rendering.normalizationMode === "PERCENTILE"
        ? percentile(sorted, 95)
        : sorted.at(-1) ?? 1;
  const buyMaximum = Math.max(...snapshot.rows.map(row => row.buyQuantity), Number.EPSILON);
  const sellMaximum = Math.max(...snapshot.rows.map(row => row.sellQuantity), Number.EPSILON);
  const segmentLimit = settings.rendering.timeSegmentsMode === "LATEST_N" || settings.rendering.timeSegmentsMode === "CUSTOM"
    ? settings.rendering.latestSegmentCount
    : Number.POSITIVE_INFINITY;
  return snapshot.rows.map((row, index): AuctionProfileRowProjection => {
    const rawWidthValue = values[index]!;
    let cumulativeValue = 0;
    const completeSegments = (cellsByRow.get(row.index) ?? []).map((cell): AuctionProfileSegment => {
      cumulativeValue += cell.rawValue;
      return {
        startTime: cell.startTime,
        endTime: cell.endTime,
        value: settings.rendering.profileBlockValueMode === "CUMULATIVE_CVD" ? cumulativeValue : cell.rawValue,
        deltaValue: cell.rawValue,
        cumulativeValue,
        normalizedWidth: normalized(cell.rawValue, maximum, settings),
        finalized: cell.isFinalized,
        sourceCount: 1
      };
    });
    const rowSegments = Number.isFinite(segmentLimit) ? completeSegments.slice(-segmentLimit) : completeSegments;
    const netCvd = row.buyQuantity - row.sellQuantity;
    return {
      rowIndex: row.index,
      priceLow: row.low,
      priceHigh: row.high,
      buyVolume: row.buyQuantity,
      sellVolume: row.sellQuantity,
      totalVolume: row.totalQuantity,
      netCvd,
      absoluteCvd: Math.abs(netCvd),
      cvdEfficiency: row.cvdEfficiency,
      rawWidthValue,
      normalizedWidth: normalized(rawWidthValue, maximum, settings),
      normalizedBuyWidth: row.buyQuantity / buyMaximum,
      normalizedSellWidth: row.sellQuantity / sellMaximum,
      direction: netCvd > 0 ? "POSITIVE" : netCvd < 0 ? "NEGATIVE" : "NEUTRAL",
      inValueArea: row.inValueArea,
      timeSegments: needsCells ? rowSegments : []
    };
  });
}

export function compressAuctionProfileSegments(
  segments: readonly AuctionProfileSegment[],
  maximumBlocks: number,
  mode: AuctionProfileSettings["rendering"]["profileBlockValueMode"]
): AuctionProfileDisplayBlock[] {
  const cap = Math.max(1, Math.floor(maximumBlocks));
  if (segments.length <= cap) return segments.map(segment => ({ ...segment }));
  const result: AuctionProfileDisplayBlock[] = [];
  for (let index = 0; index < cap; index += 1) {
    const start = Math.floor(index * segments.length / cap);
    const end = Math.floor((index + 1) * segments.length / cap);
    const group = segments.slice(start, Math.max(start + 1, end));
    const first = group[0]!;
    const last = group.at(-1)!;
    const deltaValue = group.reduce((sum, segment) => sum + segment.deltaValue, 0);
    const sourceCount = group.reduce((sum, segment) => sum + segment.sourceCount, 0);
    result.push({
      startTime: first.startTime,
      endTime: last.endTime,
      value: mode === "CUMULATIVE_CVD" ? last.cumulativeValue : deltaValue,
      deltaValue,
      cumulativeValue: last.cumulativeValue,
      normalizedWidth: Math.max(...group.map(segment => segment.normalizedWidth)),
      finalized: group.every(segment => segment.finalized),
      sourceCount
    });
  }
  return result;
}

export function resolveAuctionProfilePlacement(
  placement: AuctionProfilePlacement,
  plotWidth: number,
  rangeLeft: number,
  rangeRight: number,
  widthPercent: number
): AuctionProfilePlacementBounds {
  const requestedWidth = Math.max(36, plotWidth * Math.max(5, Math.min(100, widthPercent)) / 100);
  let left: number;
  let right: number;
  if (placement === "LEFT") {
    left = 0;
    right = Math.min(plotWidth, requestedWidth);
  } else if (placement === "OVERLAY") {
    left = Math.max(0, (plotWidth - requestedWidth) / 2);
    right = Math.min(plotWidth, left + requestedWidth);
  } else if (placement === "INSIDE_RANGE") {
    right = Math.max(0, Math.min(plotWidth, rangeRight));
    left = Math.max(0, right - Math.min(requestedWidth, Math.max(36, rangeRight - rangeLeft)));
  } else if (placement === "RANGE_START") {
    left = Math.max(0, Math.min(plotWidth, rangeLeft));
    right = Math.min(plotWidth, left + requestedWidth);
  } else {
    right = plotWidth;
    left = Math.max(0, right - requestedWidth);
  }
  return { left, right, center: (left + right) / 2, width: Math.max(1, right - left) };
}

export function auctionProfileBarSpans(
  row: AuctionProfileRowProjection,
  geometry: AuctionProfileGeometry,
  bounds: AuctionProfilePlacementBounds
): AuctionProfileBarSpan[] {
  const half = bounds.width / 2;
  const center = bounds.center;
  const width = row.normalizedWidth * bounds.width;
  const directionalHalf = row.normalizedWidth * half;
  if (geometry === "BIDIRECTIONAL_DELTA") {
    return row.direction === "NEGATIVE"
      ? [{ left: center - directionalHalf, right: center, role: "NEGATIVE" }]
      : [{ left: center, right: center + directionalHalf, role: row.direction }];
  }
  if (geometry === "POSITIVE_NEGATIVE_SPLIT") {
    return [
      { left: center - row.normalizedSellWidth * half, right: center, role: "NEGATIVE" },
      { left: center, right: center + row.normalizedBuyWidth * half, role: "POSITIVE" }
    ];
  }
  if (geometry === "MIRRORED") {
    return [
      { left: center - directionalHalf, right: center, role: row.direction },
      { left: center, right: center + directionalHalf, role: row.direction }
    ];
  }
  if (geometry === "SINGLE_SIDED_LEFT") return [{ left: bounds.right - width, right: bounds.right, role: row.direction }];
  if (geometry === "CENTERED") return [{ left: center - width / 2, right: center + width / 2, role: row.direction }];
  return [{ left: bounds.left, right: bounds.left + width, role: row.direction }];
}
