import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import readline from "node:readline";

const ARCHIVE_ORIGIN = "https://public.bybit.com";
const MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TRADE_ROWS = 100_000_000;
const EXPECTED_HEADER = "timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function buildBybitPublicTradeArchiveUrl(symbol, archiveDate) {
  const normalized = normalizeSymbol(symbol);
  const date = normalizeArchiveDate(archiveDate);
  return `${ARCHIVE_ORIGIN}/trading/${normalized}/${normalized}${date}.csv.gz`;
}

export async function ingestBybitPublicTradeArchiveDay(controlPlane, options = {}) {
  const symbol = normalizeSymbol(options.symbol || "BTCUSDT");
  const archiveDate = normalizeArchiveDate(options.archiveDate);
  assertCompletedArchiveDate(archiveDate, options.now);

  const existing = await readExistingManifest(controlPlane, symbol, archiveDate);
  if (existing) return { status: "existing", symbol, archiveDate, exactTradeCount: Number(existing.exact_trade_count || 0) };

  const sourceUrl = buildBybitPublicTradeArchiveUrl(symbol, archiveDate);
  const temporaryRoot = await mkdtemp(join(options.temporaryRoot || tmpdir(), "black-terminal-acvd-"));
  const archivePath = join(temporaryRoot, `${symbol}-${archiveDate}.csv.gz`);
  try {
    const download = await downloadArchive(sourceUrl, archivePath, options.fetchImpl || globalThis.fetch);
    const parsed = await parseDownloadedArchive(archivePath, { symbol, archiveDate, onProgress: options.onProgress });
    const manifest = {
      symbol,
      archiveDate,
      sourceUrl,
      sourceEtag: download.etag,
      sourceSha256: download.sha256,
      compressedBytes: download.compressedBytes,
      uncompressedBytes: parsed.uncompressedBytes,
      exactTradeCount: parsed.exactTradeCount,
      firstTradeAt: new Date(parsed.firstTradeMs).toISOString(),
      lastTradeAt: new Date(parsed.lastTradeMs).toISOString()
    };
    const result = await controlPlane.rpc("acvd_commit_bybit_public_trade_day", {
      p_manifest: manifest,
      p_minutes: parsed.minutes
    });
    if (result.error) throw result.error;
    return { ...(result.data || {}), symbol, archiveDate, exactTradeCount: parsed.exactTradeCount, sha256: download.sha256 };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function backfillBybitPublicTradeArchives(controlPlane, options = {}) {
  const symbol = normalizeSymbol(options.symbol || "BTCUSDT");
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const lastCompletedDay = startOfUtcDay(now) - DAY_MS;
  const endMs = options.endDate ? parseUtcDate(options.endDate) : lastCompletedDay;
  const days = Math.max(1, Math.min(3_000, Number(options.days) || 14));
  const startMs = options.startDate ? parseUtcDate(options.startDate) : endMs - (days - 1) * DAY_MS;
  if (startMs > endMs || endMs > lastCompletedDay) throw new Error("Bybit public archive backfill range must contain completed UTC days only");

  const results = [];
  for (let day = startMs; day <= endMs; day += DAY_MS) {
    const archiveDate = new Date(day).toISOString().slice(0, 10);
    options.onProgress?.({ phase: "day-start", symbol, archiveDate, completedDays: results.length, totalDays: Math.floor((endMs - startMs) / DAY_MS) + 1 });
    const result = await ingestBybitPublicTradeArchiveDay(controlPlane, { ...options, symbol, archiveDate, now });
    results.push(result);
    options.onProgress?.({ phase: "day-complete", symbol, archiveDate, completedDays: results.length, totalDays: Math.floor((endMs - startMs) / DAY_MS) + 1, exactTradeCount: result.exactTradeCount });
  }
  return { symbol, startDate: new Date(startMs).toISOString().slice(0, 10), endDate: new Date(endMs).toISOString().slice(0, 10), days: results.length, inserted: results.filter((row) => row.status === "inserted").length, existing: results.filter((row) => row.status === "existing").length, results };
}

export async function parseDownloadedArchive(archivePath, options) {
  const symbol = normalizeSymbol(options.symbol);
  const archiveDate = normalizeArchiveDate(options.archiveDate);
  const dayStart = parseUtcDate(archiveDate);
  const dayEnd = dayStart + DAY_MS;
  const minutes = Array.from({ length: 1440 }, (_, index) => ({
    interval_start: new Date(dayStart + index * MINUTE_MS).toISOString(),
    buy_volume: 0,
    sell_volume: 0,
    buy_notional: 0,
    sell_notional: 0,
    exact_trade_count: 0,
    total_trade_count: 0
  }));

  let uncompressedBytes = 0;
  let exactTradeCount = 0;
  let firstTradeMs = Number.POSITIVE_INFINITY;
  let lastTradeMs = 0;
  let previousTradeMs = dayStart;
  let headerSeen = false;
  const byteGuard = new Transform({
    transform(chunk, _encoding, callback) {
      uncompressedBytes += chunk.length;
      callback(uncompressedBytes > MAX_UNCOMPRESSED_BYTES ? new Error("Bybit public archive violates uncompressed safety bound") : null, chunk);
    }
  });
  const input = createReadStream(archivePath).pipe(createGunzip()).pipe(byteGuard);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!headerSeen) {
      if (line !== EXPECTED_HEADER) throw new Error("Unexpected Bybit public trade archive schema");
      headerSeen = true;
      continue;
    }
    if (!line) continue;
    const fields = line.split(",");
    if (fields.length !== 11) throw new Error("Malformed Bybit public trade archive row");
    const [timestampText, rowSymbol, side, sizeText, priceText, , tradeId, , , foreignNotionalText] = fields;
    const timestampMs = Number(timestampText) * 1000;
    const size = Number(sizeText);
    const price = Number(priceText);
    const foreignNotional = Number(foreignNotionalText);
    if (!Number.isFinite(timestampMs) || timestampMs < dayStart || timestampMs >= dayEnd || timestampMs + 1 < previousTradeMs) throw new Error("Bybit public trade archive timestamps are invalid or out of order");
    if (rowSymbol !== symbol || !["Buy", "Sell"].includes(side) || !(size > 0) || !(price > 0) || !(foreignNotional > 0) || !tradeId) throw new Error("Bybit public trade archive contains an invalid aggressor trade");
    previousTradeMs = timestampMs;
    firstTradeMs = Math.min(firstTradeMs, timestampMs);
    lastTradeMs = Math.max(lastTradeMs, timestampMs);
    const minute = minutes[Math.floor((timestampMs - dayStart) / MINUTE_MS)];
    if (!minute) throw new Error("Bybit public trade archive minute mapping failed");
    if (side === "Buy") {
      minute.buy_volume += size;
      minute.buy_notional += foreignNotional;
    } else {
      minute.sell_volume += size;
      minute.sell_notional += foreignNotional;
    }
    minute.exact_trade_count += 1;
    minute.total_trade_count += 1;
    exactTradeCount += 1;
    if (exactTradeCount > MAX_TRADE_ROWS) throw new Error("Bybit public trade archive violates trade-count safety bound");
    if (exactTradeCount % 1_000_000 === 0) options.onProgress?.({ phase: "parse", symbol, archiveDate, exactTradeCount, uncompressedBytes });
  }
  if (!headerSeen || !exactTradeCount || !Number.isFinite(firstTradeMs) || !lastTradeMs) throw new Error("Bybit public trade archive contains no genuine trades");
  return { minutes, exactTradeCount, firstTradeMs, lastTradeMs, uncompressedBytes };
}

async function readExistingManifest(controlPlane, symbol, archiveDate) {
  const result = await controlPlane.from("acvd_bybit_public_trade_days")
    .select("source_sha256,exact_trade_count")
    .eq("venue", "BYBIT").eq("symbol", symbol).eq("market_kind", "linear_perpetual").eq("archive_date", archiveDate)
    .maybeSingle();
  if (result.error) {
    if (["42P01", "PGRST205"].includes(String(result.error.code || ""))) throw Object.assign(new Error("ACVD public archive migration is not deployed"), { code: "ACVD_PUBLIC_ARCHIVE_NOT_DEPLOYED" });
    throw result.error;
  }
  return result.data || null;
}

async function downloadArchive(sourceUrl, archivePath, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required for Bybit public archive ingestion");
  const response = await fetchImpl(sourceUrl, { method: "GET", redirect: "error", headers: { Accept: "application/gzip, application/octet-stream, text/csv" } });
  if (!response.ok || !response.body) throw new Error(`Bybit public archive download failed with HTTP ${response.status}`);
  const resolved = new URL(response.url || sourceUrl);
  if (resolved.origin !== ARCHIVE_ORIGIN || resolved.href !== sourceUrl) throw new Error("Bybit public archive redirected outside the approved origin");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > MAX_COMPRESSED_BYTES) throw new Error("Bybit public archive violates compressed safety bound");
  const hash = crypto.createHash("sha256");
  let compressedBytes = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      hash.update(chunk);
      callback(compressedBytes > MAX_COMPRESSED_BYTES ? new Error("Bybit public archive violates compressed safety bound") : null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
  if (!compressedBytes || (declaredLength && declaredLength !== compressedBytes)) throw new Error("Bybit public archive download was incomplete");
  return { compressedBytes, sha256: hash.digest("hex"), etag: response.headers.get("etag") || null };
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(symbol)) throw new Error("Invalid Bybit public archive symbol");
  return symbol;
}

function normalizeArchiveDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid Bybit public archive date");
  return date;
}

function parseUtcDate(value) { return new Date(`${normalizeArchiveDate(value)}T00:00:00.000Z`).getTime(); }
function startOfUtcDay(value) { const date = new Date(value); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); }
function assertCompletedArchiveDate(date, now = Date.now()) {
  if (parseUtcDate(date) >= startOfUtcDay(Number(now))) throw new Error("Bybit public archive date is not a completed UTC day");
}
