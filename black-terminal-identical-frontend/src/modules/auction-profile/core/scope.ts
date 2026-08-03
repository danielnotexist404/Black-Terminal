import type { Candle } from "../../../chart-engine/types.ts";
import type { AuctionProfileSettings, AuctionScopeWindow } from "./types.ts";

const DAY_SECONDS = 86_400;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    return formatterFor("UTC");
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zonedParts(time: number, timeZone: string) {
  const values = Object.fromEntries(
    formatterFor(timeZone).formatToParts(new Date(time * 1000))
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

function timezoneOffsetSeconds(time: number, timeZone: string) {
  const part = zonedParts(time, timeZone);
  const representedAsUtc = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) / 1000;
  return representedAsUtc - Math.floor(time);
}

function zonedDayStart(time: number, timeZone: string) {
  const part = zonedParts(time, timeZone);
  const localMidnightAsUtc = Date.UTC(part.year, part.month - 1, part.day) / 1000;
  let candidate = localMidnightAsUtc - timezoneOffsetSeconds(time, timeZone);
  candidate = localMidnightAsUtc - timezoneOffsetSeconds(candidate, timeZone);
  return candidate;
}

function sessionStart(time: number, settings: AuctionProfileSettings) {
  const date = new Date(time * 1000);
  if (settings.sessionTemplate === "WEEK") {
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day) / 1000;
  }
  if (settings.sessionTemplate === "MONTH") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  const timeZone = settings.sessionTemplate === "ASIA" ? "Asia/Singapore"
    : settings.sessionTemplate === "LONDON" ? "Europe/London"
    : settings.sessionTemplate === "NEW_YORK" ? "America/New_York"
    : settings.sessionTimezone || "UTC";
  const minute = settings.sessionTemplate === "LONDON" ? 8 * 60
    : settings.sessionTemplate === "NEW_YORK" ? 9 * 60 + 30
    : settings.sessionTemplate === "CUSTOM" ? settings.customSessionStartMinute
    : 0;
  const candidate = zonedDayStart(time, timeZone) + minute * 60;
  return time >= candidate
    ? candidate
    : zonedDayStart(time - DAY_SECONDS, timeZone) + minute * 60;
}

function periodicBucket(time: number, settings: AuctionProfileSettings) {
  if (settings.periodicity === "CUSTOM_HOURS") {
    const seconds = Math.max(1, settings.periodicHours) * 3600;
    return Math.floor(time / seconds) * seconds;
  }
  const date = new Date(time * 1000);
  if (settings.periodicity === "DAILY") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
  if (settings.periodicity === "WEEKLY") {
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day) / 1000;
  }
  const month = settings.periodicity === "QUARTERLY" ? Math.floor(date.getUTCMonth() / 3) * 3 : date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month, 1) / 1000;
}

function windowFromIndices(
  bars: readonly Candle[],
  startBarIndex: number,
  endBarIndex: number,
  settings: AuctionProfileSettings,
  label: string
): AuctionScopeWindow {
  const start = bars[startBarIndex]?.time ?? 0;
  const endBarTime = bars[endBarIndex]?.time ?? start;
  const nextBarTime = bars[endBarIndex + 1]?.time;
  const estimatedInterval = endBarIndex > 0
    ? Math.max(1, endBarTime - bars[endBarIndex - 1]!.time)
    : 1;
  const end = (nextBarTime ?? endBarTime + estimatedInterval) - 1;
  return {
    id: settings.scopeMode.toLowerCase() + ":" + start + ":" + end,
    start,
    end,
    startBarIndex,
    endBarIndex,
    locked: settings.compositeLocked || settings.scopeMode === "FIXED_START" || settings.scopeMode === "MANUAL_RANGE",
    viewportDependent: settings.scopeMode === "VISIBLE_RANGE" || settings.rowSizingMode === "VISIBLE_PIXEL_ADAPTIVE",
    label
  };
}

export function resolveAuctionScopeWindows(
  bars: readonly Candle[],
  settings: AuctionProfileSettings,
  visibleRange?: { start: number; end: number }
): AuctionScopeWindow[] {
  if (!bars.length) return [];
  const last = bars.length - 1;
  if (settings.scopeMode === "VISIBLE_RANGE") {
    const startTime = visibleRange?.start ?? settings.visibleStartTime ?? bars[Math.max(0, last - settings.lookbackBars + 1)]!.time;
    const endTime = visibleRange?.end ?? settings.visibleEndTime ?? bars[last]!.time;
    const start = Math.max(0, bars.findIndex(bar => bar.time >= startTime));
    let end = bars.findIndex(bar => bar.time > endTime);
    if (end < 0) end = bars.length;
    return [windowFromIndices(bars, start, Math.max(start, end - 1), settings, "Visible Range")];
  }
  if (settings.scopeMode === "FIXED_START" || settings.scopeMode === "MANUAL_RANGE") {
    const startTime = settings.fixedStartTime ?? bars[0]!.time;
    const endTime = settings.fixedEndTime ?? bars[last]!.time;
    const start = Math.max(0, bars.findIndex(bar => bar.time >= startTime));
    let end = bars.findIndex(bar => bar.time > endTime);
    if (end < 0) end = bars.length;
    return [windowFromIndices(bars, start, Math.max(start, end - 1), settings, settings.scopeMode === "FIXED_START" ? "Fixed Start" : "Manual Range")];
  }
  if (settings.scopeMode === "SESSION") {
    const windows: AuctionScopeWindow[] = [];
    const first = Math.max(0, bars.length - settings.lookbackBars);
    let start = first;
    let bucket = sessionStart(bars[first]!.time, settings);
    for (let index = first + 1; index <= last; index += 1) {
      const nextBucket = sessionStart(bars[index]!.time, settings);
      if (nextBucket === bucket) continue;
      windows.push(windowFromIndices(bars, start, index - 1, settings, "Session " + (windows.length + 1)));
      start = index;
      bucket = nextBucket;
    }
    windows.push(windowFromIndices(bars, start, last, settings, "Session " + (windows.length + 1)));
    return windows;
  }
  if (settings.scopeMode === "PERIODIC_COMPOSITE") {
    const windows: AuctionScopeWindow[] = [];
    const first = Math.max(0, bars.length - settings.lookbackBars);
    if (settings.periodicity === "CUSTOM_BARS") {
      const chunk = Math.max(1, settings.periodicBars);
      for (let start = first; start <= last; start += chunk) {
        windows.push(windowFromIndices(bars, start, Math.min(last, start + chunk - 1), settings, "Periodic " + (windows.length + 1)));
      }
      return windows;
    }
    let start = first;
    let bucket = periodicBucket(bars[first]!.time, settings);
    for (let index = first + 1; index <= last; index += 1) {
      const nextBucket = periodicBucket(bars[index]!.time, settings);
      if (nextBucket === bucket) continue;
      windows.push(windowFromIndices(bars, start, index - 1, settings, "Periodic " + (windows.length + 1)));
      start = index;
      bucket = nextBucket;
    }
    windows.push(windowFromIndices(bars, start, last, settings, "Periodic " + (windows.length + 1)));
    return windows;
  }
  const requested = settings.scopeMode === "MACRO_COMPOSITE" ? Math.min(20000, settings.lookbackBars) : settings.lookbackBars;
  return [windowFromIndices(bars, Math.max(0, bars.length - requested), last, settings, settings.scopeMode === "MACRO_COMPOSITE" ? "Macro Composite" : settings.scopeMode === "COMPOSITE" ? "Composite" : "Rolling")];
}

export function scopeBars(bars: readonly Candle[], scope: AuctionScopeWindow) {
  return bars.slice(scope.startBarIndex, scope.endBarIndex + 1);
}
