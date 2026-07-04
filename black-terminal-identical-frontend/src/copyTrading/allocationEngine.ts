import type { OrderTicketDraft } from "../orders/types";
import type { CopyTradingFollower, ExecutionMatrixRow } from "./types";

export function calculateFollowerQuantity(
  follower: CopyTradingFollower,
  draft: OrderTicketDraft,
  referencePrice: number
) {
  const profile = follower.allocationProfile;

  switch (profile.method) {
    case "equityPercentage":
      return ((follower.equity * profile.value) / 100) / referencePrice;
    case "riskPercentage":
      return ((follower.equity * profile.value) / 100) / referencePrice;
    case "fixedUsd":
      return profile.value / referencePrice;
    case "fixedQuantity":
      return profile.value;
    case "volatilityBased":
      return Math.max(0, (profile.maxExposureUsd * (profile.value / 100)) / referencePrice);
    case "portfolioWeight":
      return ((follower.equity * profile.value) / 100) / referencePrice;
    default:
      return draft.quantity;
  }
}

export function buildExecutionMatrix(
  followers: CopyTradingFollower[],
  draft: OrderTicketDraft,
  referencePrice: number
): ExecutionMatrixRow[] {
  return followers.map((follower) => {
    const calculatedQuantity = calculateFollowerQuantity(follower, draft, referencePrice);
    const estimatedExposure = calculatedQuantity * referencePrice;
    const estimatedMargin = estimatedExposure / 5;
    const blocked = follower.status !== "active" || follower.connectionHealth === "failed";

    return {
      accountId: follower.id,
      accountName: follower.displayName,
      exchange: follower.connectedExchange,
      allocationMethod: follower.allocationProfile.method,
      calculatedQuantity,
      estimatedExposure,
      estimatedMargin,
      riskCheck: {
        status: blocked ? "blocked" : "approved",
        reasons: blocked ? ["Follower is not eligible for execution."] : []
      }
    };
  });
}
