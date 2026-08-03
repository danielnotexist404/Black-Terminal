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
  const constrainedTouchRenderer = isIpadClassDevice(environment);
  const requestedResolution = Number.isFinite(environment.devicePixelRatio) && environment.devicePixelRatio > 0
    ? environment.devicePixelRatio
    : 1;
  return {
    constrainedTouchRenderer,
    rendererResolution: constrainedTouchRenderer ? Math.min(1.5, requestedResolution) : requestedResolution
  };
}
