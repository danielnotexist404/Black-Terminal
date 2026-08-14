export type DDAProCamera = {
  zoom: number;
  pan: number;
};

export type DDAProDomain = {
  min: number;
  max: number;
  range: number;
  baseRange: number;
};

export const DEFAULT_DDA_PRO_CAMERA: DDAProCamera = Object.freeze({ zoom: 1, pan: 0 });

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function resetDDAProCamera(): DDAProCamera {
  return { ...DEFAULT_DDA_PRO_CAMERA };
}

export function ddaProDomain(baseDepth: number, camera: DDAProCamera): DDAProDomain {
  const baseRange = clamp(Number.isFinite(baseDepth) ? Math.abs(baseDepth) : 1, 0.01, 10_000);
  const zoom = clamp(Number.isFinite(camera.zoom) ? camera.zoom : 1, 0.2, 40);
  const range = baseRange / zoom;
  const pan = clamp(Number.isFinite(camera.pan) ? camera.pan : 0, -baseRange * 4, baseRange * 4);
  const center = -baseRange / 2 + pan;
  return { min: center - range / 2, max: center + range / 2, range, baseRange };
}

export function ddaProValueToY(value: number, paneTop: number, paneBottom: number, domain: DDAProDomain) {
  const top = paneTop + 18;
  const bottom = Math.max(top + 1, paneBottom - 16);
  const ratio = (domain.max - value) / Math.max(1e-9, domain.range);
  return top + clamp(ratio, 0, 1) * (bottom - top);
}

export function zoomDDAProCamera(
  camera: DDAProCamera,
  baseDepth: number,
  deltaY: number,
  anchorRatio: number
): DDAProCamera {
  const before = ddaProDomain(baseDepth, camera);
  const anchor = before.max - clamp(anchorRatio, 0, 1) * before.range;
  const zoom = clamp(camera.zoom * Math.exp(-deltaY * 0.0028), 0.2, 40);
  const afterRange = before.baseRange / zoom;
  const desiredMax = anchor + clamp(anchorRatio, 0, 1) * afterRange;
  const pan = desiredMax - afterRange / 2 + before.baseRange / 2;
  return { zoom, pan: clamp(pan, -before.baseRange * 4, before.baseRange * 4) };
}

export function panDDAProCamera(
  camera: DDAProCamera,
  baseDepth: number,
  pixelDeltaY: number,
  paneHeight: number
): DDAProCamera {
  const domain = ddaProDomain(baseDepth, camera);
  const pan = camera.pan + (pixelDeltaY / Math.max(1, paneHeight - 34)) * domain.range;
  return { zoom: camera.zoom, pan: clamp(pan, -domain.baseRange * 4, domain.baseRange * 4) };
}
