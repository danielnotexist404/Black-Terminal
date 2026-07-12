import type { MarketKind } from "../market-data/types";

export type ExecutionAlgorithmDefinition = {
  id: string;
  venue: string;
  label: string;
  nativeOrSynthetic: "native" | "black-core";
  supportedProducts: MarketKind[];
  requiredCapabilities: string[];
  requiredWorker: boolean;
  supportedParameters: string[];
  readiness: boolean;
  knownLimitations: string[];
};

export const executionAlgorithmRegistry: ExecutionAlgorithmDefinition[] = [
  {
    id: "bybit.market",
    venue: "bybit",
    label: "Market",
    nativeOrSynthetic: "native",
    supportedProducts: ["spot", "perpetual", "futures"],
    requiredCapabilities: ["market-orders"],
    requiredWorker: false,
    supportedParameters: ["quantity", "slippageTolerance", "reduceOnly", "takeProfit", "stopLoss"],
    readiness: true,
    knownLimitations: ["Bybit internally protects market orders using IOC limit behavior and venue slippage limits."]
  },
  {
    id: "bybit.limit",
    venue: "bybit",
    label: "Limit",
    nativeOrSynthetic: "native",
    supportedProducts: ["spot", "perpetual", "futures"],
    requiredCapabilities: ["limit-orders"],
    requiredWorker: false,
    supportedParameters: ["quantity", "price", "timeInForce", "postOnly", "reduceOnly", "takeProfit", "stopLoss"],
    readiness: true,
    knownLimitations: []
  },
  {
    id: "bybit.conditional",
    venue: "bybit",
    label: "Conditional",
    nativeOrSynthetic: "native",
    supportedProducts: ["spot", "perpetual", "futures"],
    requiredCapabilities: ["conditional-orders"],
    requiredWorker: false,
    supportedParameters: ["triggerPrice", "triggerBy", "executionType", "quantity", "reduceOnly"],
    readiness: true,
    knownLimitations: []
  },
  nativeStrategy("bybit.chase-limit", "Chase Limit", ["spot", "perpetual", "futures"], ["quantity", "chaseDistance", "maxChasePrice", "triggerPrice", "reduceOnly"]),
  nativeStrategy("bybit.twap", "TWAP", ["spot", "perpetual", "futures"], ["quantity", "duration", "interval", "randomize", "priceProtection", "reduceOnly"]),
  nativeStrategy("bybit.iceberg", "Iceberg", ["spot", "perpetual", "futures"], ["quantity", "subSize", "orderCount", "preference", "priceProtection", "reduceOnly"]),
  nativeStrategy("bybit.pov", "POV", ["perpetual", "futures"], ["quantity", "duration", "interval", "participationRate", "volumeReference", "reduceOnly"]),
  deferred("blackcore.scaled-order", "bybit", "Scaled Order", "OMS parent-child scheduling and atomic preview persistence are not deployed."),
];

export function listReadyExecutionAlgorithms(venue: string, product: MarketKind) {
  return executionAlgorithmRegistry.filter((definition) =>
    definition.venue === venue && definition.readiness && definition.supportedProducts.includes(product)
  );
}

function deferred(id: string, venue: string, label: string, limitation: string): ExecutionAlgorithmDefinition {
  return {
    id,
    venue,
    label,
    nativeOrSynthetic: "black-core",
    supportedProducts: ["perpetual", "futures"],
    requiredCapabilities: [],
    requiredWorker: true,
    supportedParameters: [],
    readiness: false,
    knownLimitations: [limitation]
  };
}

function nativeStrategy(id: string, label: string, supportedProducts: MarketKind[], supportedParameters: string[]): ExecutionAlgorithmDefinition {
  return {
    id,
    venue: "bybit",
    label,
    nativeOrSynthetic: "native",
    supportedProducts,
    requiredCapabilities: ["strategy-orders"],
    requiredWorker: false,
    supportedParameters,
    readiness: true,
    knownLimitations: ["Availability remains subject to Bybit account, product, region, and strategy eligibility."]
  };
}
