import assert from "node:assert/strict";
import { DDAProWorkerRuntime } from "../src/modules/dda-pro/workers/runtime.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import type { DDAProWorkerResponse } from "../src/modules/dda-pro/workers/protocol.ts";

const candles: Candle[] = Array.from({ length: 800 }, (_, index) => {
  const close = 100 + index * 0.03 + Math.sin(index / 19) * 7;
  return { time: 1_700_000_000 + index * 3_600, open: close, high: close + 1, low: close - 1, close, volume: 1_000 };
});

{
  const messages: DDAProWorkerResponse[] = [];
  const runtime = new DDAProWorkerRuntime((message) => messages.push(message));
  runtime.handle({ protocolVersion: 1, type: "CALCULATE", requestId: "valid", generation: 7, input: { candles, settings: DEFAULT_DDA_PRO_SETTINGS, timeframeSeconds: 3_600 } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "RESULT");
  if (messages[0]?.type === "RESULT") {
    assert.equal(messages[0].requestId, "valid");
    assert.equal(messages[0].generation, 7);
    assert.equal(messages[0].snapshot.inputSize, candles.length);
    assert.ok(messages[0].calculationMs >= 0);
  }
}

{
  const messages: DDAProWorkerResponse[] = [];
  const runtime = new DDAProWorkerRuntime((message) => messages.push(message));
  runtime.handle({ protocolVersion: 999 as 1, type: "CALCULATE", requestId: "invalid", generation: 1, input: { candles, settings: DEFAULT_DDA_PRO_SETTINGS } });
  assert.equal(messages[0]?.type, "ERROR");
  if (messages[0]?.type === "ERROR") assert.equal(messages[0].code, "INVALID_PROTOCOL");
}

{
  const messages: DDAProWorkerResponse[] = [];
  const runtime = new DDAProWorkerRuntime((message) => messages.push(message));
  runtime.handle({ protocolVersion: 1, type: "INITIALIZE", requestId: "init", generation: 10, config: DEFAULT_DDA_PRO_SETTINGS, timeframeSeconds: 3_600 });
  assert.equal(messages.at(-1)?.type, "ACK");
  const values = Float64Array.from(candles.slice(0, 600).map((candle) => candle.close));
  const timestamps = BigInt64Array.from(candles.slice(0, 600).map((candle) => BigInt(candle.time)));
  runtime.handle({ protocolVersion: 1, type: "LOAD_HISTORY", requestId: "history", generation: 10, values, timestamps });
  assert.equal(messages.at(-1)?.type, "ACK");
  runtime.handle({ protocolVersion: 1, type: "APPEND", requestId: "append", generation: 10, value: candles[600]!.close, timestamp: candles[600]!.time, confirmed: true });
  assert.equal(messages.at(-1)?.type, "ACK");
  runtime.handle({ protocolVersion: 1, type: "UPDATE_CONFIG", requestId: "config", generation: 10, config: { lookback: 250 } });
  assert.equal(messages.at(-1)?.type, "ACK");
  runtime.handle({ protocolVersion: 1, type: "REBUILD", requestId: "rebuild", generation: 10 });
  const rebuilt = messages.at(-1);
  assert.equal(rebuilt?.type, "RESULT");
  if (rebuilt?.type === "RESULT") {
    assert.equal(rebuilt.snapshot.inputSize, 601);
    assert.equal(rebuilt.snapshot.validFromIndex, 99);
  }
  runtime.handle({ protocolVersion: 1, type: "CANCEL", requestId: "cancel", generation: 11 });
  const messageCountAfterCancel = messages.length;
  runtime.handle({ protocolVersion: 1, type: "REBUILD", requestId: "cancelled-rebuild", generation: 11 });
  assert.equal(messages.length, messageCountAfterCancel, "cancelled generations must not publish results");
}

{
  const messages: DDAProWorkerResponse[] = [];
  const runtime = new DDAProWorkerRuntime((message) => messages.push(message));
  runtime.handle({ protocolVersion: 1, type: "INITIALIZE", requestId: "init-invalid", generation: 3, config: DEFAULT_DDA_PRO_SETTINGS });
  runtime.handle({ protocolVersion: 1, type: "LOAD_HISTORY", requestId: "history-invalid", generation: 3, values: new Float64Array([1, 2]), timestamps: new BigInt64Array([2n, 1n]) });
  assert.equal(messages.at(-1)?.type, "ERROR");
  if (messages.at(-1)?.type === "ERROR") assert.match((messages.at(-1) as Extract<DDAProWorkerResponse, { type: "ERROR" }>).message, /HISTORY_INVALID/);
}

console.log("DDA Pro worker protocol, generation cancellation, stateful history, append/config rebuild, and deterministic calculation tests: PASS");
