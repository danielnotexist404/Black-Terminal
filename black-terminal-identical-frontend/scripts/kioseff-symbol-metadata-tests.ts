import assert from "node:assert/strict";
import {
  assertDecimalStep,
  createSymbolMetadata,
  decimalPlaces,
  requireSymbolMetadata
} from "../src/market-data/symbolMetadata.ts";

for (const tickSize of ["0.5", "0.05", "0.0005", "2.5"]) {
  const metadata = createSymbolMetadata({
    exchange: "bybit",
    rawSymbol: "FIXTUREUSDT",
    normalizedSymbol: "FIXTUREUSDT",
    marketKind: "perpetual",
    tickSize,
    quantityStep: "0.001",
    source: "structural-fixture"
  });
  assert.equal(metadata.tickSize, tickSize);
  assert.equal(metadata.pricePrecision, decimalPlaces(tickSize));
  assert.equal(requireSymbolMetadata(metadata), metadata);
}

assert.equal(decimalPlaces("0.1000"), 1);
assert.equal(decimalPlaces("5"), 0);
assert.throws(() => assertDecimalStep("0", "tickSize"), /Invalid authoritative tickSize/);
assert.throws(() => assertDecimalStep("-0.1", "tickSize"), /Invalid authoritative tickSize/);
assert.throws(() => assertDecimalStep("not-a-step", "tickSize"), /Invalid authoritative tickSize/);
assert.throws(() => requireSymbolMetadata(undefined), /missing-authoritative-tick-size/);

console.log("Kioseff authoritative symbol metadata tests passed.");

