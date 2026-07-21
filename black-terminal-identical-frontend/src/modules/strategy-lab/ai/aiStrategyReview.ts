import type { AIStrategyReview, RatingGrade, StrategyReviewInput } from "../types/ai.types";
import { buildCodeSuggestions } from "./codeSuggestionEngine";

function grade(score: number): RatingGrade {
  if (score >= 0.82) return "A";
  if (score >= 0.64) return "B";
  if (score >= 0.46) return "C";
  if (score >= 0.28) return "D";
  return "F";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bestWorstLabel(rows: Array<Record<string, unknown>>, key: string) {
  const best = [...rows].sort((a, b) => asNumber(b.pnl) - asNumber(a.pnl))[0];
  const worst = [...rows].sort((a, b) => asNumber(a.pnl) - asNumber(b.pnl))[0];
  return { best: String(best?.[key] ?? "unknown"), worst: String(worst?.[key] ?? "unknown") };
}

export function createAIStrategyReview(input: StrategyReviewInput): AIStrategyReview {
  const metrics = input.metrics;
  const netProfit = asNumber(metrics.netProfit);
  const returnOnCapital = asNumber(metrics.returnOnCapital);
  const profitFactor = asNumber(metrics.profitFactor);
  const maxDrawdownPercent = asNumber(metrics.maxDrawdownPercent);
  const winRate = asNumber(metrics.winRate);
  const robustnessScores = input.optimizationResults.map((item) => asNumber(item.robustnessScore)).filter((value) => value > 0);
  const avgRobustness = robustnessScores.length
    ? robustnessScores.reduce((sum, value) => sum + value, 0) / robustnessScores.length
    : 0;
  const session = bestWorstLabel(input.sessionPerformance, "session");
  const regime = bestWorstLabel(input.regimePerformance, "regime");
  const exitReasons = (input.tradeDistribution.exitReasons as Array<Record<string, unknown>> | undefined) ?? [];
  const stopLossDamage = exitReasons.find((item) => item.reason === "stopLoss");
  const chopDamage = input.regimePerformance.find((item) => String(item.regime).includes("chop") && asNumber(item.pnl) < 0);

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const failurePatterns: string[] = [];
  const riskWarnings: string[] = [];

  if (netProfit > 0) strengths.push("Strategy produced positive net profit on the tested history.");
  if (profitFactor >= 1.3) strengths.push("Profit factor is above the minimum deployability threshold.");
  if (winRate >= 0.5) strengths.push("Win rate is stable enough to support tighter risk controls.");
  if (asNumber(metrics.longNetProfit) > 0 && asNumber(metrics.shortNetProfit) > 0) strengths.push("Both long and short books contributed positively.");

  if (netProfit <= 0) weaknesses.push("Net profit is negative or flat after costs.");
  if (profitFactor < 1.15) weaknesses.push("Profit factor is thin after fees, slippage, and spread assumptions.");
  if (maxDrawdownPercent > 0.18) weaknesses.push("Drawdown control is weak relative to account capital.");
  if (avgRobustness > 0 && avgRobustness < 45) weaknesses.push("Optimization surface is unstable and may indicate curve fitting.");
  if (asNumber(metrics.longNetProfit) * asNumber(metrics.shortNetProfit) < 0) weaknesses.push("Long and short performance is asymmetric.");

  if (session.worst !== "unknown") failurePatterns.push(`Worst session cluster: ${session.worst}. Consider restricting entry windows or changing sizing by session.`);
  if (regime.worst !== "unknown") failurePatterns.push(`Worst market regime: ${regime.worst}. Strategy behavior should be gated by trend/volatility quality.`);
  if (stopLossDamage && asNumber(stopLossDamage.pnl) < 0) failurePatterns.push("Stop-loss exits contribute a meaningful portion of losses; review volatility-adjusted stop sizing.");
  if (chopDamage) failurePatterns.push("Chop regime losses detected. Add ADX, range expansion, or liquidity filters before deployment.");
  if (input.drawdownClusters.length > 4) failurePatterns.push("Drawdown clusters are persistent rather than isolated, suggesting regime sensitivity.");

  if (maxDrawdownPercent > 0.25) riskWarnings.push("Account drawdown exceeds a high-risk threshold.");
  if (profitFactor < 1.05) riskWarnings.push("Costs or spread widening could erase the edge.");
  if (input.optimizationResults.some((item) => Boolean(item.overfitWarning))) riskWarnings.push("At least one high-profit parameter set has poor nearby robustness.");

  const parameterSuggestions = [];
  const bestRobust = [...input.optimizationResults].sort((a, b) => asNumber(b.robustnessScore) - asNumber(a.robustnessScore))[0];
  if (bestRobust?.parameters && avgRobustness > 0) {
    for (const [parameter, value] of Object.entries(bestRobust.parameters as Record<string, number>)) {
      parameterSuggestions.push({
        parameter,
        currentValue: "current",
        suggestedValue: value,
        reason: "Selected from the most robust tested parameter cluster, not just highest raw profit.",
        confidence: Math.min(0.92, Math.max(0.45, asNumber(bestRobust.robustnessScore) / 100))
      });
    }
  }
  if (maxDrawdownPercent > 0.16) {
    parameterSuggestions.push({
      parameter: "riskPerTrade",
      currentValue: "current",
      suggestedValue: "reduce by 25-40%",
      reason: "Drawdown profile is too heavy for forward deployment.",
      confidence: 0.74
    });
  }

  const review: AIStrategyReview = {
    summary: netProfit > 0
      ? `Positive test with ${profitFactor.toFixed(2)} profit factor and ${(returnOnCapital * 100).toFixed(2)}% return on capital. Best session appears to be ${session.best}; weakest regime is ${regime.worst}.`
      : `The strategy is not profitable on the tested data after execution costs. Weakest session is ${session.worst} and weakest regime is ${regime.worst}.`,
    strengths,
    weaknesses,
    failurePatterns,
    parameterSuggestions,
    filterSuggestions: [
      maxDrawdownPercent > 0.14 ? "Add max daily loss and max account drawdown circuit breakers." : "Keep current account-level risk controls active.",
      regime.worst.includes("chop") ? "Add trend/chop regime filter." : "Validate with volatility and spread filters.",
      session.worst !== "unknown" ? `Consider blocking or reducing size during ${session.worst}.` : "Collect more session-tagged trades before adding session restrictions."
    ],
    codeSuggestions: [],
    riskWarnings,
    ratings: {
      profitability: grade(Math.min(1, Math.max(0, returnOnCapital * 4 + profitFactor / 4))),
      robustness: grade(avgRobustness / 100),
      drawdownControl: grade(1 - Math.min(1, maxDrawdownPercent / 0.3)),
      executionRealism: grade(Boolean(metrics.totalTrades) ? 0.72 : 0.4),
      overfittingRisk: avgRobustness > 65 ? "Low" : avgRobustness > 35 ? "Medium" : "High",
      liveReadiness: netProfit > 0 && profitFactor > 1.25 && maxDrawdownPercent < 0.18 ? "Needs Work" : "Not Ready"
    }
  };
  review.codeSuggestions = buildCodeSuggestions(review);
  return review;
}
