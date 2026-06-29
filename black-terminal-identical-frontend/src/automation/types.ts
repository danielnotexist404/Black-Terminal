import { OrderRequest } from "../execution/types";
import { ExchangeId, Timeframe } from "../market-data/types";

export type AutomationMode = "paper" | "live";

export type RiskGuard = {
  maxOrderUsd?: number;
  maxDailyLossUsd?: number;
  maxPositionUsd?: number;
  allowedSymbols?: string[];
  allowedExchanges?: ExchangeId[];
  requireManualApproval: boolean;
};

export type StrategyTrigger =
  | {
      type: "indicator-signal";
      indicatorId: string;
      signalName: string;
    }
  | {
      type: "price-condition";
      symbol: string;
      operator: ">" | ">=" | "<" | "<=" | "crosses-above" | "crosses-below";
      value: number;
    }
  | {
      type: "webhook";
      webhookId: string;
    };

export type StrategyDefinition = {
  id: string;
  name: string;
  mode: AutomationMode;
  symbol: string;
  timeframe: Timeframe;
  triggers: StrategyTrigger[];
  riskGuard: RiskGuard;
  enabled: boolean;
};

export type StrategyAction =
  | {
      type: "place-order";
      order: OrderRequest;
    }
  | {
      type: "send-webhook";
      webhookId: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "notify";
      severity: "info" | "warning" | "critical";
      message: string;
    };

export type WebhookEndpoint = {
  id: string;
  name: string;
  url: string;
  secretRef?: string;
  enabled: boolean;
  createdAt: number;
};

export type AutomationRunEvent = {
  strategyId: string;
  time: number;
  trigger: StrategyTrigger;
  actions: StrategyAction[];
  accepted: boolean;
  rejectedReason?: string;
};
