export const AIF_NATIVE_MANIFEST = Object.freeze({
  id: "aif",
  name: "A.I.F.",
  fullName: "Auction Intelligence Framework",
  category: "proprietary-auction",
  native: true,
  version: "0.1.0",
  initialMode: "profile",
  requires: ["candles"],
  optionalData: ["lowerTimeframeCandles", "trades", "classifiedTrades", "immDepthMemory", "immEvents"],
  supportsSecondaryProfile: true,
  supportsEventTimeline: true,
  supportsWorkspacePromotion: true,
  emitsOrders: false
});
