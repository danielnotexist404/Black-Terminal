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
  deferred("bybit.chase-limit", "bybit", "Chase Limit", "A supervised cancel-replace worker and persistent strategy state are not deployed."),
  deferred("blackcore.scaled-order", "bybit", "Scaled Order", "OMS parent-child scheduling and atomic preview persistence are not deployed."),
  deferred("blackcore.twap", "bybit", "TWAP", "A persistent execution worker is required; browser timers are prohibited."),
  deferred("blackcore.pov", "bybit", "POV", "A persistent market-volume sampler and execution worker are required."),
  deferred("blackcore.iceberg", "bybit", "Iceberg", "A persistent child-order replenishment worker is required.")
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
