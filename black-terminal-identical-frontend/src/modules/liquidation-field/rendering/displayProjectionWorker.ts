/// <reference lib="webworker" />
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { buildBclifDisplayProjection, type BclifDisplayContext } from "./displayProjection.ts";

interface ProjectionRequest {
  generation: number;
  key: string;
  snapshot: LiquidationFieldSnapshot;
  settings: LiquidationFieldSettings;
  context: BclifDisplayContext;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<ProjectionRequest>) => {
  const { generation, key, snapshot, settings, context } = event.data;
  try {
    const projection = buildBclifDisplayProjection(snapshot, settings, context);
    const transfer = projection
      ? [projection.intensity.buffer, projection.alpha.buffer, projection.validity.buffer, projection.yellowEligible.buffer]
      : [];
    scope.postMessage({ generation, key, projection }, transfer);
  } catch (error) {
    scope.postMessage({
      generation,
      key,
      projection: null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
