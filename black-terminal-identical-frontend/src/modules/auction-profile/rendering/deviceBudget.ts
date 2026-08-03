import type { AuctionProfileSettings } from "../core/types.ts";

export const RADAP_TABLET_RENDER_BUDGET = {
  maximumVisibleColumns: 220,
  maximumVisibleRows: 180,
  maximumVisibleLabels: 700
} as const;

const tabletSettingsCache = new WeakMap<AuctionProfileSettings, AuctionProfileSettings>();

export function auctionProfileSettingsForDevice(settings: AuctionProfileSettings, constrainedTouchRenderer = false) {
  if (!constrainedTouchRenderer) return settings;
  const cached = tabletSettingsCache.get(settings);
  if (cached) return cached;
  const rendering = settings.rendering;
  const constrainedSettings: AuctionProfileSettings = {
    ...settings,
    rendering: {
      ...rendering,
      maximumVisibleColumns: Math.min(rendering.maximumVisibleColumns, RADAP_TABLET_RENDER_BUDGET.maximumVisibleColumns),
      maximumVisibleRows: Math.min(rendering.maximumVisibleRows, RADAP_TABLET_RENDER_BUDGET.maximumVisibleRows),
      maximumVisibleLabels: Math.min(rendering.maximumVisibleLabels, RADAP_TABLET_RENDER_BUDGET.maximumVisibleLabels),
      cellTextMode: rendering.cellTextMode === "ALWAYS" ? "AUTO" as const : rendering.cellTextMode
    }
  };
  tabletSettingsCache.set(settings, constrainedSettings);
  return constrainedSettings;
}
