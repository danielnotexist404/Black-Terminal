import type { ExchangeId } from "../market-data/types";

export type PositionDirection = "long" | "short";
export type PositionLifecycleState = "opening" | "open" | "protected" | "scaling" | "closing" | "closed" | "archived";
export type PositionProtectionType = "take-profit" | "stop-loss" | "trailing-stop" | "break-even" | "oco";
export type PositionProtectionStatus = "pending" | "active" | "modifying" | "cancelled" | "triggered" | "failed";
export type PositionTimelineEventType =
  | "position-opened"
  | "position-updated"
  | "position-protected"
  | "tp-added"
  | "sl-added"
  | "trailing-enabled"
  | "protection-modified"
  | "protection-cancelled"
  | "added-to-position"
  | "scaled-in"
  | "scaled-out"
  | "partial-close"
  | "position-reversed"
  | "position-closed"
  | "position-archived"
  | "note-added"
  | "tags-updated";

export type PortfolioPosition = {
  id: string;
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  direction: PositionDirection;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  margin: number;
  leverage: number;
  liquidationPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
};

export type PositionProtectionOrder = {
  id: string;
  type: PositionProtectionType;
  status: PositionProtectionStatus;
  price?: number;
  trailBy?: number;
  trailMode?: "percentage" | "usd" | "ticks" | "atr";
  activation?: "immediate" | "custom-price" | "offset";
  activationPrice?: number;
  orderId?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type PositionTimelineEvent = {
  id: string;
  positionId: string;
  type: PositionTimelineEventType;
  message: string;
  time: number;
  price?: number;
  quantity?: number;
  orderId?: string;
  metadata?: Record<string, unknown>;
};

export type PositionHealth = {
  entryPrice: number;
  markPrice: number;
  averageEntry: number;
  currentPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  currentRisk: number;
  distanceToTp?: number;
  distanceToSl?: number;
  riskReward?: number;
  marginUsed: number;
  liquidationPrice?: number;
  fundingPaid: number;
  fees: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  timeInTradeMs: number;
  executionQuality: "unknown" | "excellent" | "good" | "fair" | "poor";
};

export type ManagedPosition = PortfolioPosition & {
  lifecycleState: PositionLifecycleState;
  protections: PositionProtectionOrder[];
  timeline: PositionTimelineEvent[];
  health: PositionHealth;
  notes: string[];
  tags: string[];
  sourceOrderIds: string[];
  updatedAt: number;
  closedAt?: number;
  archivedAt?: number;
};

export type PositionLifecycleEvent = {
  type: PositionTimelineEventType;
  positionId: string;
  accountId: string;
  symbol: string;
  exchange: ExchangeId;
  time: number;
  message: string;
  metadata?: Record<string, unknown>;
};
