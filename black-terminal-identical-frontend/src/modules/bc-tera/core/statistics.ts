export const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export const clamp100 = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
export const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

export function median(values: readonly number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

export function robustZ(current: number, causalWindow: readonly number[], epsilon = 1e-9) {
  if (!Number.isFinite(current) || causalWindow.length < 3) return 0;
  const center = median(causalWindow);
  const mad = median(causalWindow.map((value) => Math.abs(value - center)));
  return (current - center) / (1.4826 * mad + epsilon);
}

export function weightedNullable(parts: ReadonlyArray<readonly [number | null, number]>) {
  let weighted = 0;
  let weight = 0;
  for (const [value, partWeight] of parts) {
    if (value == null || !Number.isFinite(value) || partWeight <= 0) continue;
    weighted += clamp100(value) * partWeight;
    weight += partWeight;
  }
  return weight > 0 ? weighted / weight : null;
}
