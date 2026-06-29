import type { StrategyReviewInput } from "../types/ai.types";

export function buildAIReviewPrompt(input: StrategyReviewInput) {
  return {
    role: "strategy-analyst",
    instruction: "Analyze the structured BLACK-TERMINAL strategy report. Avoid generic trading advice. Focus on failure patterns, execution realism, robustness, and specific improvements.",
    payload: input
  };
}
