import type { AuctionProfileSnapshot } from "../core/types.ts";

export type PineGoldenRow = { low: number; high: number; cvd: number; total: number };

export function comparePineGolden(snapshot: AuctionProfileSnapshot, golden: readonly PineGoldenRow[], tolerance = 1e-6) {
  const differences: Array<{ row: number; field: string; actual: number; expected: number }> = [];
  const count = Math.min(snapshot.rows.length, golden.length);
  for (let index = 0; index < count; index += 1) {
    const actual = snapshot.rows[index]!;
    const expected = golden[index]!;
    const fields: Array<[string, number, number]> = [
      ["low", actual.low, expected.low],
      ["high", actual.high, expected.high],
      ["cvd", actual.value, expected.cvd],
      ["total", actual.totalQuantity, expected.total]
    ];
    fields.forEach(([field, left, right]) => {
      if (Math.abs(left - right) > tolerance * Math.max(1, Math.abs(right))) differences.push({ row: index, field, actual: left, expected: right });
    });
  }
  return { comparableRows: count, rowCountMatches: snapshot.rows.length === golden.length, differences };
}
