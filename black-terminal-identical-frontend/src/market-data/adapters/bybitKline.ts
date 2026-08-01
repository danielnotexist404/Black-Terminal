import type { Candle } from "../../chart-engine/types.ts";
import type { CandleQuery } from "../types.ts";

function parseNumber(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Bybit numeric value: ${value}`);
  }
  return parsed;
}

export function parseBybitKlineRows(rows: readonly string[][]): Candle[] {
  const candles = rows.map((row) => {
    if (row.length < 6) throw new Error("Bybit kline row is incomplete");
    return {
      time: Math.floor(parseNumber(row[0]!) / 1000),
      open: parseNumber(row[1]!),
      high: parseNumber(row[2]!),
      low: parseNumber(row[3]!),
      close: parseNumber(row[4]!),
      volume: parseNumber(row[5]!)
    };
  });
  return candles.sort((left, right) => left.time - right.time);
}

export function assertBybitCandleQuery(query: CandleQuery) {
  if (query.exchange !== "bybit") {
    throw new Error(
      `adapter-symbol-category-mismatch: expected bybit exchange, received ${query.exchange}`
    );
  }
  const normalized = query.symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized || !/^[A-Z0-9]+$/.test(normalized)) {
    throw new Error(
      `adapter-symbol-category-mismatch: invalid Bybit symbol ${query.symbol}`
    );
  }
  for (const [name, value] of [
    ["from", query.from],
    ["to", query.to]
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value > 10_000_000_000) {
      throw new Error(
        `invalid-timestamp-units: Bybit ${name} must use integer seconds`
      );
    }
  }
  if (
    query.from !== undefined &&
    query.to !== undefined &&
    query.from > query.to
  ) {
    throw new Error("missing-request-range: Bybit history start exceeds end");
  }
}
