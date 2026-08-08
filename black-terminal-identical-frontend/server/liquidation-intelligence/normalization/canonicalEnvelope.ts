import { createHash } from "node:crypto";
import type { BclifCanonicalEvent, BclifCanonicalEventKind } from "../contracts.ts";

export function normalizeSymbol(value: unknown) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error("Invalid BCLIF symbol");
  return symbol;
}

export function finitePositive(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid ${label}`);
  return numeric;
}

export function timestampMs(value: unknown, fallback?: number) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  if (fallback !== undefined && Number.isFinite(fallback) && fallback > 0) return fallback;
  throw new Error("Invalid exchange timestamp");
}

export function canonicalDecimal(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("Invalid canonical decimal");
  if (Object.is(numeric, -0)) return "0";
  return numeric.toString();
}

export function sha256Hex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalEvent<T>(input: {
  eventId: string;
  dedupKey?: string;
  kind: BclifCanonicalEventKind;
  symbol: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  sourceSequence?: string | number | null;
  sourceVersion: string;
  payload: T;
}): BclifCanonicalEvent<T> {
  if (!input.eventId || !input.sourceVersion) throw new Error("Canonical event identity is incomplete");
  const exchangeTimestamp = timestampMs(input.exchangeTimestamp);
  const receivedTimestamp = timestampMs(input.receivedTimestamp);
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    dedupKey: input.dedupKey?.startsWith("sha256:")
      ? input.dedupKey
      : `sha256:${sha256Hex(input.dedupKey || input.eventId)}`,
    kind: input.kind,
    venue: "BYBIT",
    symbol: normalizeSymbol(input.symbol),
    marketKind: "linear_perpetual",
    exchangeTimestamp,
    receivedTimestamp,
    sourceSequence: input.sourceSequence == null ? null : String(input.sourceSequence),
    sourceVersion: input.sourceVersion,
    certainty: "OBSERVED",
    payload: input.payload
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
