import type { OrderType, TimeInForce } from "../../execution/types";
import type { VenueExecutionSchema } from "../../execution/venueExecutionSchema";

export const DOM_EQUITY_ALLOCATION_MARKERS = [0, 1, 5, 10, 15, 25, 35, 50, 65, 75, 100] as const;

export function availableDomOrderTypes(schema: VenueExecutionSchema | null): OrderType[] {
  if (!schema) return ["limit", "market"];
  return [...new Set(schema.supportedOrderModes.flatMap((mode) => mode.orderTypes))];
}

export function availableDomTimeInForce(schema: VenueExecutionSchema | null, orderType: OrderType, postOnly: boolean): TimeInForce[] {
  if (orderType === "market" || ["twap", "iceberg", "pov", "chase-limit"].includes(orderType)) return [];
  const supported = schema?.supportedTimeInForce?.length ? schema.supportedTimeInForce : (["gtc", "ioc", "fok"] as TimeInForce[]);
  return postOnly ? supported.filter((tif) => tif === "gtc") : supported;
}

export function nearestLeverageOptions(min: number, max: number, step: number, current: number) {
  const safeMin = Math.max(1, min || 1);
  const safeMax = Math.max(safeMin, max || safeMin);
  const safeStep = Math.max(0.01, step || 1);
  const anchors = [safeMin, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, safeMax, current]
    .map((value) => Math.round(value / safeStep) * safeStep)
    .filter((value) => value >= safeMin && value <= safeMax);
  return [...new Set(anchors)].sort((a, b) => a - b);
}

export function domExecutionLayoutMode(width: number): "wide" | "medium" | "narrow" | "minimal" {
  if (width >= 720) return "wide";
  if (width >= 480) return "medium";
  if (width >= 300) return "narrow";
  return "minimal";
}
