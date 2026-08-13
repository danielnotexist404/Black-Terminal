import { calculateDDAProCompatibility } from "./compatibilityEngine.ts";
import { calculateDDAProNative } from "./nativeEngine.ts";
import type { DDAProCalculationInput } from "./types.ts";

export function calculateDDAPro(input: DDAProCalculationInput) {
  return input.settings.engineMode === "pine-compatibility"
    ? calculateDDAProCompatibility(input)
    : calculateDDAProNative(input);
}
