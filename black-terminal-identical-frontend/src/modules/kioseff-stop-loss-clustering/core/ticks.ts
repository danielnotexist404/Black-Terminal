import { assertDecimalStep } from "../../../market-data/symbolMetadata.ts";

export type DecimalStep = {
  source: string;
  value: number;
  numerator: bigint;
  scale: bigint;
};

export function parseDecimalStep(source: string): DecimalStep {
  assertDecimalStep(source, "tickSize");
  const [whole, fraction = ""] = source.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole!) * scale + BigInt(fraction || "0");
  return { source, value: Number(source), numerator, scale };
}

export function pineTickIndex(price: number, tick: DecimalStep) {
  if (!Number.isFinite(price)) throw new Error(`Invalid price for tick indexing: ${price}`);
  // Pine source applies `math.floor(level / syminfo.mintick)` at this exact stage.
  return Math.floor(price / tick.value);
}

export function pineTickPrice(index: number, tick: DecimalStep) {
  if (!Number.isSafeInteger(index)) throw new Error(`Invalid tick index: ${index}`);
  return Number((BigInt(index) * tick.numerator).toString()) / Number(tick.scale);
}

export function stableFloatEqual(left: number, right: number, tolerance = 1e-12) {
  if (Object.is(left, right)) return true;
  return Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

