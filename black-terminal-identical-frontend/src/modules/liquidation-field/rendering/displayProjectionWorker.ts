/// <reference lib="webworker" />
import type { LiquidationFieldSettings, LiquidationFieldSnapshot } from "../core/types.ts";
import { bclifUint8ToHalf, buildBclifDisplayProjection, type BclifDisplayContext } from "./displayProjection.ts";
import { buildBclifDisplayTexture } from "./displayTexture.ts";
import { buildBclifSafeThermalRaster } from "./safeThermalRaster.ts";
import { createBclifReferenceThermalStyleFixture } from "../testing/referenceThermalFixture.ts";

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
    let projection = buildBclifDisplayProjection(snapshot, settings, context);
    if (projection && snapshot.header.checksum.includes("SYNTHETIC_REFERENCE_THERMAL_STYLE_V3")) {
      const source = projection;
      projection = {
        ...createBclifReferenceThermalStyleFixture(source.columns, source.rows),
        minPrice: source.minPrice,
        maxPrice: source.maxPrice,
        priceStep: source.priceStep,
        timeStepMs: source.timeStepMs,
        modelHash: source.modelHash,
        exposureHash: source.exposureHash,
        renderSettingsHash: source.renderSettingsHash,
        displayRasterHash: source.displayRasterHash
      };
    }
    if (projection && settings.rendererVersion === "REFERENCE_THERMAL_V2") {
      projection.exposureHalf = bclifUint8ToHalf(projection.intensity);
      const safe = buildBclifSafeThermalRaster(projection, settings);
      projection.rgba = safe.rgba;
      projection.safeRasterFinalVisiblePixels = safe.metrics.finalVisiblePixels;
      projection.safeRasterExposureVisiblePixels = safe.metrics.exposureVisiblePixels;
      projection.safeRasterMinimumAlpha = safe.metrics.minimumAlpha;
      projection.safeRasterMaximumAlpha = safe.metrics.maximumAlpha;
    }
    if (projection && settings.rendererVersion === "LEGACY_RGBA_V1") {
      projection.rgba = buildBclifDisplayTexture(projection, settings);
    }
    const transfer: Transferable[] = projection ? [
      projection.intensity.buffer,
      projection.confidence.buffer,
      projection.alpha.buffer,
      projection.validity.buffer,
      projection.yellowEligible.buffer
    ] : [];
    if (projection?.exposureHalf) transfer.push(projection.exposureHalf.buffer);
    if (projection?.rgba) transfer.push(projection.rgba.buffer);
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
