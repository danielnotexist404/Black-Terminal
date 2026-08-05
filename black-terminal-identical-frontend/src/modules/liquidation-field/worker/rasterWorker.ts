/// <reference lib="webworker" />
import { buildLiquidationFieldSnapshot } from "../core/exposureRaster.ts";
import type { LiquidationFieldWorkerRequest, LiquidationFieldWorkerResponse } from "./protocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (message: MessageEvent<LiquidationFieldWorkerRequest>) => {
  const request = message.data;
  try {
    const snapshot = buildLiquidationFieldSnapshot(
      request.frames,
      request.events,
      request.rules,
      request.settings,
      request.coverage
    );
    const response: LiquidationFieldWorkerResponse = { id: request.id, snapshot };
    workerScope.postMessage(response, [
      snapshot.timestamps.buffer,
      snapshot.longExposure.buffer,
      snapshot.shortExposure.buffer,
      snapshot.combinedExposure.buffer,
      snapshot.normalizedIntensity.buffer,
      snapshot.confidence.buffer,
      snapshot.validity.buffer,
      snapshot.confirmedIntensity.buffer
    ]);
  } catch (error) {
    const response: LiquidationFieldWorkerResponse = {
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    };
    workerScope.postMessage(response);
  }
};
