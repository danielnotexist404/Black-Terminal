import type { AuctionProfileSnapshot, AuctionProfileSettings } from "./types.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
  return value;
}

export function stableSerialize(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function stableHash(value: unknown) {
  const text = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function auctionProfileVersion(parts: {
  dataHash: string;
  settingsHash: string;
  grid: unknown;
  range: unknown;
  engineVersion: string;
}) {
  return "auction-" + stableHash(parts);
}

export function freezeAuctionStrategySnapshot(snapshot: AuctionProfileSnapshot, signalTimestamp: number) {
  return Object.freeze({
    profileId: snapshot.profileId,
    profileVersion: snapshot.profileVersion,
    engine: snapshot.engine,
    scope: snapshot.scope,
    range: Object.freeze({ ...snapshot.range }),
    poc: snapshot.keyLevels.poc,
    vah: snapshot.keyLevels.vah,
    val: snapshot.keyLevels.val,
    lvnZone: snapshot.nodes.find(node => node.type === "LVN") ?? null,
    hvnZone: snapshot.nodes.find(node => node.type === "HVN") ?? null,
    quality: Object.freeze({ ...snapshot.quality }),
    signalTimestamp
  });
}

export function settingsWithoutPresentation(settings: AuctionProfileSettings) {
  const { rendering: _rendering, diagnosticsVisible: _diagnostics, settingsVersion: _version, ...calculation } = settings;
  return calculation;
}
