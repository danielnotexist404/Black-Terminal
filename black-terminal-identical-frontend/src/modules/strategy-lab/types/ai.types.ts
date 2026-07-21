export type RatingGrade = "A" | "B" | "C" | "D" | "F";

export type ParameterSuggestion = {
  parameter: string;
  currentValue: number | string;
  suggestedValue: number | string;
  reason: string;
  confidence: number;
};

export type CodeSuggestion = {
  id: string;
  title: string;
  reason: string;
  expectedImpact: string;
  risk: string;
  patchType: "filter" | "risk" | "exit" | "entry" | "positionSizing" | "session";
  pseudoCode: string;
  confidence: number;
  status: "open" | "accepted" | "rejected" | "queued-test";
};

export type AIStrategyReview = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  failurePatterns: string[];
  parameterSuggestions: ParameterSuggestion[];
  filterSuggestions: string[];
  codeSuggestions: CodeSuggestion[];
  riskWarnings: string[];
  ratings: {
    profitability: RatingGrade;
    robustness: RatingGrade;
    drawdownControl: RatingGrade;
    executionRealism: RatingGrade;
    overfittingRisk: "Low" | "Medium" | "High";
    liveReadiness: "Ready" | "Needs Work" | "Not Ready";
  };
};

export type StrategyReviewInput = {
  metrics: Record<string, unknown>;
  tradeDistribution: Record<string, unknown>;
  worstPeriods: Array<Record<string, unknown>>;
  bestPeriods: Array<Record<string, unknown>>;
  sessionPerformance: Array<Record<string, unknown>>;
  regimePerformance: Array<Record<string, unknown>>;
  drawdownClusters: Array<Record<string, unknown>>;
  optimizationResults: Array<Record<string, unknown>>;
  tradeSamples: Array<Record<string, unknown>>;
};
