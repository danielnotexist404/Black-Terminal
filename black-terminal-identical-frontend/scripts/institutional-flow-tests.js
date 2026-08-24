import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBasketOscillator,
  buildInstitutionalFlowSnapshot,
  calculateFundPressure,
  institutionalFlowInternals
} from "../server/institutional-flow/runtime.js";

assert.ok(calculateFundPressure(1, 1) > 0, "positive ETF return produces positive pressure");
assert.ok(calculateFundPressure(-1, 1) < 0, "negative ETF return produces negative pressure");
assert.ok(Math.abs(calculateFundPressure(0, 5)) < 1e-9, "volume without a signed return cannot invent directional pressure");
assert.ok(calculateFundPressure(100, 100) <= 100, "pressure is bounded at +100");
assert.ok(calculateFundPressure(-100, 100) >= -100, "pressure is bounded at -100");

const fetchImpl = mockNasdaqFetch();
const snapshot = await buildInstitutionalFlowSnapshot("BTC", fetchImpl, 1_787_500_000_000);
assert.equal(snapshot.state, "live");
assert.equal(snapshot.funds.length, institutionalFlowInternals.FUND_UNIVERSES.BTC.length, "every verified BTC fund remains in the basket");
assert.equal(snapshot.reporting.reportedNetFlowUsd, null, "secondary exchange volume is never mislabeled as reported ETF flow");
assert.equal(snapshot.reporting.livePressureIsPrimaryFlow, false, "the API explicitly separates market pressure from creations/redemptions");
assert.ok(snapshot.basket.totalTurnoverUsd > 0, "real traded notional is aggregated");
assert.ok(snapshot.oscillator.length >= 3, "multi-fund intraday history drives the pressure oscillator");
assert.equal(snapshot.disclosures.treasury[0].classification, "CORPORATE_BITCOIN_TREASURY", "Strategy is not misclassified as an ETF");
assert.equal(snapshot.disclosures.exclusions[0].includedInBasket, false, "Vanguard receives no fabricated native fund flow");

const degraded = await buildInstitutionalFlowSnapshot("BTC", mockNasdaqFetch({ failedTicker: "EZBC" }), 1_787_500_000_000);
assert.equal(degraded.state, "degraded", "partial source failure is disclosed without erasing healthy funds");
assert.equal(degraded.sourceFailures, 1);

const unsupported = await buildInstitutionalFlowSnapshot("XMR", fetchImpl, 1_787_500_000_000);
assert.equal(unsupported.state, "unsupported");
assert.equal(unsupported.funds.length, 0, "unsupported assets cannot receive a synthetic ETF basket");

const oscillator = buildBasketOscillator([
  internalFund("AAA", 100, 1, [{ time: 1, price: 100 }, { time: 2, price: 102 }]),
  internalFund("BBB", 100, 1, [{ time: 1, price: 100 }, { time: 2, price: 98 }])
]);
assert.ok(Math.abs(oscillator.at(-1).pressure) < 1, "equal and opposite AUM-weighted fund moves neutralize instead of inventing direction");

const component = readFileSync(new URL("../src/components/InstitutionalFlowIntelligence.tsx", import.meta.url), "utf8");
assert.match(component, /LIVE PRESSURE/);
assert.match(component, /REPORTED FLOW/);
assert.match(component, /not fund inflow/i);
assert.match(component, /STRATEGY · TREASURY \/ PERIODIC 8-K/);
assert.match(component, /VANGUARD · NO NATIVE FUND/);
assert.match(component, /HISTORICAL COIN PRICE/);
assert.match(component, /onPointerMove/);
assert.match(component, /Maximize ETF Flow Intelligence/);
assert.match(component, /Close enlarged ETF Flow Intelligence/);
assert.match(component, /createPortal\(panel, fullscreenHost\)/, "the enlarged panel must portal into the isolated terminal workspace");
assert.match(component, /event\.key !== "Escape"/, "Escape must restore the compact ETF panel");
assert.doesNotMatch(component, /institutional-pressure" title=/, "the oscillator must use its bounded hover table instead of a native browser tooltip");
assert.doesNotMatch(component, /reportedNetFlowUsd\s*\?\?\s*signedTurnoverUsd/, "the UI cannot substitute turnover when primary flow is absent");

console.log("Institutional flow intelligence tests passed (truthful flow semantics, signed pressure, basket breadth, partial failure, and UI disclosures)." );

function mockNasdaqFetch({ failedTicker = null } = {}) {
  return async (url) => {
    const match = String(url).match(/quote\/([^/]+)\/(info|summary|chart)/);
    if (!match) return response(404, null);
    const [, ticker, action] = match;
    if (ticker === failedTicker) return response(503, null);
    const index = institutionalFlowInternals.FUND_UNIVERSES.BTC.findIndex((fund) => fund.ticker === ticker);
    const direction = index % 3 === 0 ? -1 : 1;
    if (action === "info") return response(200, {
      data: {
        marketStatus: "Market Open",
        primaryData: {
          lastSalePrice: `$${50 + index}`,
          percentageChange: `${direction * (0.4 + index / 10)}%`,
          volume: String(1_000_000 + index * 10_000),
          bidPrice: `$${49.9 + index}`,
          askPrice: `$${50.1 + index}`,
          lastTradeTimestamp: "Aug 24, 2026 10:30 AM ET",
          isRealTime: true
        }
      },
      status: { rCode: 200 }
    });
    if (action === "summary") return response(200, {
      data: { summaryData: {
        PreviousClose: { value: `$${50 + index - direction * 0.25}` },
        AvgDailyVol20Days: { value: "1,200,000" },
        AUM: { value: String(2_000_000 - index * 100_000) }
      } },
      status: { rCode: 200 }
    });
    return response(200, {
      data: { chart: [
        { x: 1, y: 50 + index - direction * 0.25 },
        { x: 2, y: 50 + index },
        { x: 3, y: 50 + index + direction * 0.2 }
      ] },
      status: { rCode: 200 }
    });
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

function internalFund(ticker, previousClose, aumWeight, chart) {
  return {
    ticker,
    previousClose,
    aumUsd: aumWeight,
    relativeVolume: 1,
    pressureScore: 0,
    chart,
    chartByTime: new Map(chart.map((point) => [point.time, point]))
  };
}
