import type { ScanConfig, ScannerResult } from "../types/scanner.types";
import { getBuiltInPresets } from "../engine/presets";

const scannerPresetsKey = "bt_scanner_presets_v1";

function canUseStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function getUserPresets(): ScanConfig[] {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(scannerPresetsKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to load scanner presets", error);
    return [];
  }
}

export function getAllScannerPresets() {
  return [...getBuiltInPresets(), ...getUserPresets()];
}

export function saveScanPreset(config: ScanConfig) {
  if (!canUseStorage()) return config;
  const now = Date.now();
  const nextPreset: ScanConfig = {
    ...config,
    readOnly: false,
    createdAt: config.createdAt ?? now,
    updatedAt: now
  };
  const existing = getUserPresets().filter((preset) => preset.id !== nextPreset.id);
  localStorage.setItem(scannerPresetsKey, JSON.stringify([...existing, nextPreset]));
  return nextPreset;
}

export function deleteScanPreset(id: string) {
  if (!canUseStorage()) return;
  const next = getUserPresets().filter((preset) => preset.id !== id);
  localStorage.setItem(scannerPresetsKey, JSON.stringify(next));
}

export function duplicateScanPreset(config: ScanConfig) {
  return saveScanPreset({
    ...config,
    id: `scan-${Date.now()}`,
    name: `${config.name} Copy`,
    readOnly: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}

export function exportResultsCsv(results: ScannerResult[]) {
  const headers = ["Symbol", "Exchange", "Market", "Timeframe", "Last Price", "Change %", "Volume", "Relative Volume", "Score", "Matched Rules", "Last Updated"];
  const rows = results.map((result) => [
    result.symbol,
    result.exchange,
    result.marketKind,
    result.timeframe,
    result.lastPrice ?? "",
    result.changePercent ?? "",
    result.volume ?? "",
    result.relativeVolume ?? "",
    result.score.toFixed(1),
    result.matchedConditions.map((item) => item.label).join("; "),
    new Date(result.updatedAt).toISOString()
  ]);
  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(","))
    .join("\n");
}
