import type { Candle } from "../../../chart-engine/types";
import type { ExchangeId, MarketKind, MarketSymbol, Timeframe } from "../../../market-data/types";

export type ScannerRefreshMode = "manual" | "interval" | "realtime";
export type ScannerSortBy = "score" | "volume" | "changePercent" | "relativeVolume" | "symbol" | "lastPrice" | "updatedAt";
export type ScannerSortDirection = "asc" | "desc";
export type ScannerLogic = "AND" | "OR";

export type ScannerOperator =
  | ">"
  | ">="
  | "<"
  | "<="
  | "=="
  | "!="
  | "crosses_above"
  | "crosses_below"
  | "between"
  | "not_between"
  | "rising"
  | "falling"
  | "near"
  | "percent_above"
  | "percent_below";

export type PriceField = "open" | "high" | "low" | "close" | "volume" | "range" | "changePercent";

export type IndicatorName =
  | "SMA"
  | "EMA"
  | "RSI"
  | "MACD"
  | "ATR"
  | "ATR_SMA"
  | "BOLLINGER_UPPER"
  | "BOLLINGER_MIDDLE"
  | "BOLLINGER_LOWER"
  | "VWAP"
  | "VOLUME_SMA"
  | "ROC"
  | "HIGHEST_HIGH"
  | "LOWEST_LOW";

export type ScannerOperand =
  | { type: "price"; field: PriceField; offset?: number }
  | { type: "indicator"; name: IndicatorName; params?: Record<string, number | string | boolean>; offset?: number }
  | { type: "constant"; value: number }
  | { type: "previous"; field: PriceField; offset?: number }
  | { type: "averageVolume"; period: number; offset?: number }
  | { type: "highestHigh"; lookback: number; includeCurrent?: boolean; offset?: number }
  | { type: "lowestLow"; lookback: number; includeCurrent?: boolean; offset?: number }
  | { type: "percentChange"; lookback: number; offset?: number }
  | { type: "relativeStrength"; lookback: number; benchmarkSymbol?: string; offset?: number };

export type ScannerRule = {
  id: string;
  label: string;
  left: ScannerOperand;
  operator: ScannerOperator;
  right?: ScannerOperand;
  right2?: ScannerOperand;
  tolerance?: number;
  enabled?: boolean;
  weight?: number;
  note?: string;
};

export type ScannerConditionGroup = {
  id: string;
  type: ScannerLogic;
  rules: Array<ScannerRule | ScannerConditionGroup>;
};

export type ScannerUniverseType = "current-watchlist" | "all-symbols" | "exchange" | "manual";

export type ScannerUniverse = {
  type: ScannerUniverseType;
  exchangeIds?: ExchangeId[];
  symbols?: string[];
  marketKinds?: MarketKind[];
};

export type ScannerScoringConfig = {
  enabled: boolean;
  weights?: {
    trend?: number;
    volume?: number;
    momentum?: number;
    volatility?: number;
    relativeStrength?: number;
  };
};

export type ScanConfig = {
  id: string;
  name: string;
  description?: string;
  readOnly?: boolean;
  universe: ScannerUniverse;
  symbols?: string[];
  markets?: MarketKind[];
  timeframes: Timeframe[];
  refreshMode: ScannerRefreshMode;
  refreshIntervalSeconds: number;
  maxResults: number;
  sortBy: ScannerSortBy;
  sortDirection: ScannerSortDirection;
  conditions: ScannerConditionGroup;
  scoring: ScannerScoringConfig;
  createdAt?: number;
  updatedAt?: number;
  notes?: string[];
};

export type ScannerMatchedCondition = {
  ruleId: string;
  label: string;
  operator: ScannerOperator;
  leftValue: number | null;
  rightValue?: number | null;
  right2Value?: number | null;
};

export type ScannerResultStatus = "match" | "no-match" | "error" | "cancelled";

export type ScannerResult = {
  id: string;
  status: ScannerResultStatus;
  symbol: string;
  displayName: string;
  rawSymbol: string;
  exchange: ExchangeId;
  marketKind: MarketKind;
  timeframe: Timeframe;
  lastPrice: number | null;
  changePercent: number | null;
  volume: number | null;
  relativeVolume: number | null;
  matchedConditions: ScannerMatchedCondition[];
  score: number;
  updatedAt: number;
  category?: string;
  error?: string;
};

export type ScannerProgress = {
  completed: number;
  total: number;
  current?: string;
  errors: number;
};

export type ScannerRunOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ScannerProgress) => void;
  concurrency?: number;
  includeNonMatches?: boolean;
};

export type ScannerRunOutput = {
  configId: string;
  startedAt: number;
  completedAt: number;
  results: ScannerResult[];
  errors: ScannerResult[];
  scanned: number;
  cancelled: boolean;
};

export type ScannerDataAdapter = {
  fetchCandles: (symbol: MarketSymbol, timeframe: Timeframe, limit: number, signal?: AbortSignal) => Promise<Candle[]>;
};

export type RuleEvaluationContext = {
  candles: Candle[];
  index: number;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  indicatorCache: Map<string, number[]>;
  benchmarkCandles?: Candle[];
};

export type RuleEvaluationResult = {
  matched: boolean;
  matchedConditions: ScannerMatchedCondition[];
  warnings: string[];
};

export type ScanValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};
