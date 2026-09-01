export type ChartDeviceEnvironment = {
  devicePixelRatio: number;
  maxTouchPoints: number;
  platform: string;
  userAgent: string;
};

export function isIpadClassDevice(environment: Pick<ChartDeviceEnvironment, "maxTouchPoints" | "platform" | "userAgent">) {
  const appleMobileAgent = /iPad|iPhone|iPod/i.test(environment.userAgent);
  const desktopClassIpad = environment.platform === "MacIntel" && environment.maxTouchPoints > 1;
  return appleMobileAgent || desktopClassIpad;
}

export function resolveChartDeviceCapabilities(environment: ChartDeviceEnvironment) {
  return resolveChartDevicePreferences(environment, "AUTO");
}

export function resolveChartDevicePreferences(
  environment: ChartDeviceEnvironment,
  resolutionMode: "AUTO" | "LOW_DPI" | "HIGH_DPI" | "ULTRA",
) {
  const constrainedTouchRenderer = isIpadClassDevice(environment);
  const requestedResolution = Number.isFinite(environment.devicePixelRatio) && environment.devicePixelRatio > 0
    ? environment.devicePixelRatio
    : 1;
  const selectedResolution = resolutionMode === "LOW_DPI"
    ? 1
    : resolutionMode === "HIGH_DPI"
      ? Math.max(2, requestedResolution)
      : resolutionMode === "ULTRA"
        ? Math.max(3, requestedResolution)
        : requestedResolution;
  return {
    constrainedTouchRenderer,
    rendererResolution: constrainedTouchRenderer
      ? Math.min(resolutionMode === "ULTRA" ? 2 : 1.5, selectedResolution)
      : Math.min(3, Math.max(1, selectedResolution))
  };
}
