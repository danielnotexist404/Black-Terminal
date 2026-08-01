import {
  migrateKioseffSettings,
  type KioseffSettingsV1
} from "./settings.ts";

export type LegacyKioseffWorkspaceFields = {
  visibility?: boolean;
  period?: number;
  visual?: {
    color?: string;
    intensity?: number;
  };
  settings?: unknown;
};

export type MigratedKioseffWorkspaceFields = {
  visibility: boolean;
  legacyPeriod: number | undefined;
  settings: KioseffSettingsV1;
};

export function migrateKioseffWorkspaceFields(
  input: LegacyKioseffWorkspaceFields
): MigratedKioseffWorkspaceFields {
  return {
    visibility: input.visibility === true,
    // Retained for round-trip compatibility only. The Kioseff engine never reads it.
    legacyPeriod:
      typeof input.period === "number" && Number.isFinite(input.period)
        ? input.period
        : undefined,
    settings: migrateKioseffSettings(input.settings, input.visual)
  };
}
