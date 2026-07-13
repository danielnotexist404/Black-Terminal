export type AifImmContext = { available: boolean; status: "confirmed" | "divergent" | "unavailable"; reason: string; wallConfluence: number };

export function resolveAifImmContext(): AifImmContext {
  return { available: false, status: "unavailable", reason: "IMM depth memory is not present in this calculation payload.", wallConfluence: 0 };
}
