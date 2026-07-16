import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDomLadderModel } from "../src/modules/dom-pro/domLadderModel.ts";
import { createDomProPriceCamera, sameDomPriceCamera } from "../src/modules/dom-pro/domPriceCamera.ts";

type RawLevel = [string, string];
type BybitBook = {
  retCode: number;
  retMsg: string;
  result: { s: string; b: RawLevel[]; a: RawLevel[]; ts: number; u?: number; seq?: number };
};

const endpoint = "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=200";
const first = await fetchBook();
const firstSnapshot = toSnapshot(first);
const midpoint = (firstSnapshot.bestBid + firstSnapshot.bestAsk) / 2;
const camera = createDomProPriceCamera(
  { min: midpoint * 0.95, max: midpoint * 1.05, source: "custom" },
  midpoint,
  60,
  "explore"
);
const firstModel = buildDomLadderModel({ snapshot: firstSnapshot, camera, bookStatus: "LIVE", now: first.result.ts });
const populated = firstModel.rows.find((row) => row.bidSize > 0 || row.askSize > 0);
assert(populated, "Bybit live levels did not map into the shared camera");

const rawBid = sumBucket(first.result.b, populated.priceLow, populated.priceHigh, camera.visiblePriceMax === populated.priceHigh);
const rawAsk = sumBucket(first.result.a, populated.priceLow, populated.priceHigh, camera.visiblePriceMax === populated.priceHigh);
assert(close(populated.bidSize, rawBid), `Bid aggregation mismatch: rendered=${populated.bidSize} raw=${rawBid}`);
assert(close(populated.askSize, rawAsk), `Ask aggregation mismatch: rendered=${populated.askSize} raw=${rawAsk}`);
assert(firstModel.rows.some((row) => row.coverage === "unavailable"), "Wide camera must identify uncovered prices as unavailable");
assert(firstModel.rows.filter((row) => row.coverage === "unavailable").every((row) => row.bidSize === 0 && row.askSize === 0), "Unavailable rows cannot contain venue depth");

await new Promise((resolve) => setTimeout(resolve, 350));
const second = await fetchBook();
const secondModel = buildDomLadderModel({ snapshot: toSnapshot(second), camera, bookStatus: "LIVE", now: second.result.ts });
assert(secondModel.cameraVersion === firstModel.cameraVersion, "Reconnect snapshot changed the user camera");
assert(sameDomPriceCamera(camera, camera), "Shared camera identity check failed");
assert(secondModel.coverage.sequence !== null, "Bybit sequence metadata is missing");

const evidence = {
  certifiedAt: new Date().toISOString(),
  venue: "BYBIT",
  symbol: first.result.s,
  endpoint,
  camera: {
    version: camera.version,
    min: camera.visiblePriceMin,
    max: camera.visiblePriceMax,
    bucketSize: camera.bucketSize,
    rows: camera.rowCount
  },
  liveCoverage: {
    min: firstModel.coverage.min,
    max: firstModel.coverage.max,
    bidLevels: firstModel.coverage.bidLevels,
    askLevels: firstModel.coverage.askLevels,
    subscribedDepth: firstModel.coverage.subscribedDepth,
    sequence: firstModel.coverage.sequence,
    unavailableRows: firstModel.rows.filter((row) => row.coverage === "unavailable").length
  },
  independentlyVerifiedBucket: {
    key: populated.key,
    low: populated.priceLow,
    high: populated.priceHigh,
    renderedBid: populated.bidSize,
    rawBid,
    renderedAsk: populated.askSize,
    rawAsk
  },
  reconnect: {
    firstSequence: first.result.seq ?? first.result.u ?? null,
    secondSequence: second.result.seq ?? second.result.u ?? null,
    cameraPreserved: secondModel.cameraVersion === firstModel.cameraVersion
  },
  passed: true
};

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "docs", "validation");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "dom-pro-shared-camera-live-certification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));

async function fetchBook() {
  const response = await fetch(endpoint, { headers: { accept: "application/json", "user-agent": "Black-Terminal-DOM-Certification/1.0" } });
  assert(response.ok, `Bybit orderbook request failed: HTTP ${response.status}`);
  const payload = await response.json() as BybitBook;
  assert(payload.retCode === 0, `Bybit orderbook rejected: ${payload.retCode} ${payload.retMsg}`);
  assert(payload.result.b.length > 0 && payload.result.a.length > 0, "Bybit returned an empty orderbook");
  return payload;
}

function toSnapshot(payload: BybitBook) {
  const bids = payload.result.b.map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }));
  const asks = payload.result.a.map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }));
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const midPrice = (bestBid + bestAsk) / 2;
  return {
    sourceBook: {
      exchange: "bybit",
      symbol: payload.result.s,
      time: payload.result.ts / 1000,
      bids,
      asks,
      subscribedDepth: 200,
      updateId: payload.result.u,
      sequence: payload.result.seq ?? payload.result.u
    },
    bestBid,
    bestAsk,
    midPrice,
    lastPrice: midPrice
  } as never;
}

function sumBucket(levels: RawLevel[], low: number, high: number, inclusiveHigh: boolean) {
  return levels.reduce((sum, [rawPrice, rawQuantity]) => {
    const price = Number(rawPrice);
    return price >= low && (price < high || inclusiveHigh && price === high) ? sum + Number(rawQuantity) : sum;
  }, 0);
}

function close(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-10);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
