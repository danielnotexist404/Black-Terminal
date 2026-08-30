import type {
  StrategyDeploymentPlan,
  StrategyTargetBinding,
} from "../automation/strategyAutomation.types";

export const paperStrategyDestinationKey = "paper";

/** A disconnected target is historical audit state, not a settings destination. */
export function selectableStrategyBindings(bindings: readonly StrategyTargetBinding[]) {
  return bindings.filter((binding) => binding.status !== "DISCONNECTED" && binding.status !== "DISCONNECTING");
}

/**
 * Prefer the explicitly planned target, then an armed target, then any attached
 * target. A strategy originally created as Paper may later have a broker or
 * Investment Group attached; that live destination must not silently keep the
 * settings panel on the script's Paper capital seed.
 */
export function preferredStrategyDestination(
  bindings: readonly StrategyTargetBinding[],
  plan?: StrategyDeploymentPlan,
) {
  const selectable = selectableStrategyBindings(bindings);
  if (plan?.targetType !== "PAPER" && plan?.targetId) {
    const planned = selectable.find((binding) => binding.targetId === plan.targetId);
    if (planned) return planned.id;
  }
  return selectable.find((binding) => binding.status === "LIVE")?.id
    || selectable[0]?.id
    || paperStrategyDestinationKey;
}

export function resolveStrategyDestination(
  sourceKey: string,
  bindings: readonly StrategyTargetBinding[],
  plan?: StrategyDeploymentPlan,
) {
  const selectable = selectableStrategyBindings(bindings);
  if (sourceKey === paperStrategyDestinationKey) {
    return { key: paperStrategyDestinationKey, mode: "PAPER" as const, binding: undefined };
  }
  const binding = selectable.find((item) => item.id === sourceKey);
  if (binding) return { key: binding.id, mode: "AUTHORITATIVE" as const, binding };
  const fallbackKey = preferredStrategyDestination(selectable, plan);
  const fallback = selectable.find((item) => item.id === fallbackKey);
  return fallback
    ? { key: fallback.id, mode: "AUTHORITATIVE" as const, binding: fallback }
    : { key: paperStrategyDestinationKey, mode: "PAPER" as const, binding: undefined };
}
