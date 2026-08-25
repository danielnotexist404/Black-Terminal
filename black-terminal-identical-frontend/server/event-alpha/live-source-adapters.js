import { isIP } from "node:net";
import { normalizeRawEventEnvelope } from "./domain.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const SNAPSHOT_URL = "https://hub.snapshot.org/graphql";
const DEFILLAMA_URL = "https://api.llama.fi/overview/fees";
const TOKENOMIST_URL = "https://api.tokenomist.ai/v5/unlock/events/upcoming";

const DEFAULT_SNAPSHOT_SPACES = Object.freeze([
  "aave.eth",
  "arbitrumfoundation.eth",
  "balancer.eth",
  "ens.eth",
  "stgdao.eth",
  "uniswapgovernance.eth"
]);

const DEFAULT_PROTOCOLS = Object.freeze([
  { slug: "aave", symbol: "AAVEUSDT", valueCaptureScore: 0.45 },
  { slug: "uniswap", symbol: "UNIUSDT", valueCaptureScore: 0.35 },
  { slug: "lido", symbol: "LDOUSDT", valueCaptureScore: 0.25 },
  { slug: "hyperliquid", symbol: "HYPEUSDT", valueCaptureScore: 0.72 },
  { slug: "ethena", symbol: "ENAUSDT", valueCaptureScore: 0.5 },
  { slug: "curve", symbol: "CRVUSDT", valueCaptureScore: 0.42 },
  { slug: "jito", symbol: "JTOUSDT", valueCaptureScore: 0.38 }
]);

export class SnapshotGovernanceSourceAdapter {
  constructor(configuration = {}, fetchImpl = globalThis.fetch, clock = () => new Date()) {
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.sourceKey = "SNAPSHOT_GOVERNANCE_V1";
    this.url = configuration.url || SNAPSHOT_URL;
    this.spaces = boundedCsv(configuration.spaces, DEFAULT_SNAPSHOT_SPACES, 50);
    this.timeoutMs = boundedInteger(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch, clock) {
    return new SnapshotGovernanceSourceAdapter({
      url: env.EVENT_ALPHA_SNAPSHOT_API_URL || SNAPSHOT_URL,
      spaces: env.EVENT_ALPHA_SNAPSHOT_SPACES,
      timeoutMs: env.EVENT_ALPHA_SOURCE_TIMEOUT_MS
    }, fetchImpl, clock);
  }

  health() {
    try {
      assertPublicHttps(this.url, new Set(["hub.snapshot.org"]));
      return this.spaces.length ? { status: "READY", reasonCode: null } : { status: "DISABLED", reasonCode: "SNAPSHOT_SPACES_MISSING" };
    } catch (error) {
      return { status: "QUARANTINED", reasonCode: error.code || "SOURCE_URL_REJECTED" };
    }
  }

  async poll(_checkpoint = {}, signal) {
    const health = this.health();
    if (health.status !== "READY") return { envelopes: [], checkpoint: {}, health };
    const observed = this.clock();
    const expectationAsOf = floorUtcMinutes(observed, 15).toISOString();
    const query = `query EventAlphaGovernance($spaces: [String!]) {
      proposals(first: 200, skip: 0, where: { space_in: $spaces }, orderBy: "created", orderDirection: desc) {
        id title choices start end created state scores scores_total scores_updated
        space { id name symbol }
      }
    }`;
    const body = await fetchJson(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables: { spaces: this.spaces } })
    }, { signal, timeoutMs: this.timeoutMs, allowedHosts: new Set(["hub.snapshot.org"]), fetchImpl: this.fetchImpl });
    if (body.errors?.length) throw sourceError("SNAPSHOT_GRAPHQL_REJECTED", "Snapshot rejected the governance query.", false);
    const rows = body?.data?.proposals;
    if (!Array.isArray(rows)) throw sourceError("SNAPSHOT_SCHEMA_INVALID", "Snapshot governance response is invalid.", false);
    const cutoff = observed.getTime() - 14 * 24 * 60 * 60 * 1_000;
    const historical = buildGovernanceHistory(rows);
    const envelopes = [];
    for (const row of rows) {
      const eventTimeMs = Number(row.end) * 1_000;
      if (!Number.isFinite(eventTimeMs) || eventTimeMs < cutoff) continue;
      const spaceId = boundedText(row.space?.id, 160);
      const spaceSymbol = normalizedSymbol(row.space?.symbol);
      if (!spaceId || !spaceSymbol || !this.spaces.includes(spaceId)) continue;
      const completed = String(row.state).toLowerCase() === "closed" || eventTimeMs <= observed.getTime();
      const scores = boundedNumbers(row.scores, 50);
      const choices = boundedStrings(row.choices, 50, 160);
      if (choices.length < 2 || scores.length !== choices.length) continue;
      const affirmativeIndex = choices.findIndex(isAffirmativeChoice);
      const negativeIndex = choices.findIndex(isNegativeChoice);
      const binaryTotal = sumSelected(scores, [affirmativeIndex, negativeIndex]);
      const currentProbability = affirmativeIndex >= 0 && binaryTotal > 0 ? scores[affirmativeIndex] / binaryTotal : historical.get(spaceId) ?? 0.5;
      const firstActionableAt = new Date(eventTimeMs).toISOString();
      const observedAt = observed.toISOString();
      envelopes.push({
        envelope: normalizeRawEventEnvelope({
          sourceKey: this.sourceKey,
          sourceEventId: String(row.id),
          eventFamily: "GOVERNANCE",
          sourcePublishedAt: unixIso(row.created),
          observedAt,
          firstActionableAt,
          payload: {
            proposalId: String(row.id),
            spaceId,
            assetId: spaceSymbol,
            symbol: `${spaceSymbol}USDT`,
            title: boundedText(row.title, 500) || "Untitled governance proposal",
            eventTime: firstActionableAt,
            state: completed ? "COMPLETED" : "ACTIVE",
            choices,
            scores,
            scoresTotal: finiteOr(row.scores_total, scores.reduce((sum, value) => sum + value, 0)),
            sourceConfidence: 0.82,
            directionalImpact: 0,
            treasuryImpactUsd: 0,
            structuralBreakScore: 0
          },
          ingestionMetadata: { adapter: "SNAPSHOT_GRAPHQL_V1", scoresUpdatedAt: unixIso(row.scores_updated), publicVote: true }
        }, observed),
        expectation: completed ? null : {
          asOf: expectationAsOf,
          expectedProbability: clamp(currentProbability, 0.01, 0.99),
          expectedValue: null,
          dispersion: Math.sqrt(Math.max(0.0001, currentProbability * (1 - currentProbability))),
          confidence: binaryTotal > 0 ? 0.72 : 0.48,
          modelKey: "SNAPSHOT_LIVE_VOTE_PROBABILITY",
          modelVersion: "1.0.0",
          contributors: [{ sourceKey: this.sourceKey, observedAt: expectationAsOf, value: currentProbability, weight: Math.max(1, binaryTotal) }],
          featureManifest: { affirmativeIndex, negativeIndex, binaryVotingPower: binaryTotal, spaceId }
        }
      });
    }
    return { envelopes, checkpoint: { watermarkAt: observed.toISOString(), cursorValue: null }, health: { status: "HEALTHY", reasonCode: null } };
  }
}

export class DefiLlamaProtocolEconomicsSourceAdapter {
  constructor(configuration = {}, fetchImpl = globalThis.fetch, clock = () => new Date()) {
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.sourceKey = "DEFILLAMA_PROTOCOL_REVENUE_V1";
    this.url = configuration.url || DEFILLAMA_URL;
    this.protocols = parseProtocolConfiguration(configuration.protocols);
    this.timeoutMs = boundedInteger(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch, clock) {
    return new DefiLlamaProtocolEconomicsSourceAdapter({
      url: env.EVENT_ALPHA_DEFILLAMA_API_URL || DEFILLAMA_URL,
      protocols: env.EVENT_ALPHA_DEFILLAMA_PROTOCOLS,
      timeoutMs: env.EVENT_ALPHA_SOURCE_TIMEOUT_MS
    }, fetchImpl, clock);
  }

  health() {
    try {
      assertPublicHttps(this.url, new Set(["api.llama.fi"]));
      return this.protocols.length ? { status: "READY", reasonCode: null } : { status: "DISABLED", reasonCode: "DEFILLAMA_PROTOCOLS_MISSING" };
    } catch (error) {
      return { status: "QUARANTINED", reasonCode: error.code || "SOURCE_URL_REJECTED" };
    }
  }

  async poll(_checkpoint = {}, signal) {
    const health = this.health();
    if (health.status !== "READY") return { envelopes: [], checkpoint: {}, health };
    const observed = this.clock();
    const expectationAsOf = floorUtcMinutes(observed, 60).toISOString();
    const target = new URL(this.url);
    target.searchParams.set("excludeTotalDataChart", "true");
    target.searchParams.set("excludeTotalDataChartBreakdown", "true");
    target.searchParams.set("dataType", "dailyRevenue");
    const body = await fetchJson(target, { headers: { accept: "application/json" } }, { signal, timeoutMs: this.timeoutMs, allowedHosts: new Set(["api.llama.fi"]), fetchImpl: this.fetchImpl });
    if (!Array.isArray(body?.protocols)) throw sourceError("DEFILLAMA_SCHEMA_INVALID", "DefiLlama protocol revenue response is invalid.", false);
    const bySlug = new Map(body.protocols.map((row) => [String(row.slug || row.module || "").toLowerCase(), row]));
    const currentHour = floorUtcMinutes(observed, 60);
    const nextHour = new Date(currentHour.getTime() + 60 * 60 * 1_000);
    const observedAt = observed.toISOString();
    const envelopes = [];
    for (const config of this.protocols) {
      const row = bySlug.get(config.slug);
      if (!row) continue;
      const actual = finiteOr(row.total24h, null);
      const previous = finiteOr(row.total48hto24h, null);
      const weekly = divideFinite(row.total7d, 7);
      const monthly = divideFinite(row.total30d, 30);
      const expectation = robustCenter([actual, previous, weekly, monthly]);
      if (!Number.isFinite(actual) || !Number.isFinite(expectation) || actual < 0 || expectation < 0) continue;
      const common = {
        assetId: config.symbol.replace(/USDT$/, ""),
        symbol: config.symbol,
        protocolSlug: config.slug,
        protocolName: boundedText(row.displayName || row.name || config.slug, 160) || config.slug,
        metric: "ROLLING_24H_REVENUE_USD",
        referencePrice: 1,
        methodologyUrl: normalizeMethodologyUrl(row.methodologyURL),
        sourceWindow: "TRAILING_24H",
        sourceConfidence: 0.78
      };
      envelopes.push(protocolEnvelope(this.sourceKey, observed, currentHour, { ...common, state: "COMPLETED", actualValue: actual, expectedValue: expectation }, null));
      envelopes.push(protocolEnvelope(this.sourceKey, observed, nextHour, { ...common, state: "SCHEDULED", actualValue: null, expectedValue: expectation }, {
        asOf: expectationAsOf,
        expectedValue: expectation,
        expectedProbability: null,
        dispersion: robustDispersion([actual, previous, weekly, monthly], expectation),
        confidence: 0.68,
        modelKey: "DEFILLAMA_ROBUST_DAILY_REVENUE",
        modelVersion: "1.0.0",
        contributors: [
          { sourceKey: "TRAILING_24H", observedAt: expectationAsOf, value: actual, weight: 1 },
          ...(Number.isFinite(previous) ? [{ sourceKey: "PRIOR_24H", observedAt: expectationAsOf, value: previous, weight: 1 }] : []),
          ...(Number.isFinite(weekly) ? [{ sourceKey: "WEEKLY_BASELINE", observedAt: expectationAsOf, value: weekly, weight: 1.25 }] : []),
          ...(Number.isFinite(monthly) ? [{ sourceKey: "MONTHLY_BASELINE", observedAt: expectationAsOf, value: monthly, weight: 1.5 }] : [])
        ],
        featureManifest: { metric: "dailyRevenue", protocolSlug: config.slug, valueCaptureScore: config.valueCaptureScore }
      }));
    }
    return { envelopes, checkpoint: { watermarkAt: observedAt, cursorValue: currentHour.toISOString() }, health: { status: "HEALTHY", reasonCode: null } };
  }
}

export class TokenomistUnlockSourceAdapter {
  constructor(configuration = {}, fetchImpl = globalThis.fetch, clock = () => new Date()) {
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.sourceKey = "TOKENOMIST_UNLOCKS_V5";
    this.url = configuration.url || TOKENOMIST_URL;
    this.apiKey = configuration.apiKey || null;
    this.timeoutMs = boundedInteger(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  }

  static fromEnvironment(env = process.env, fetchImpl = globalThis.fetch, clock) {
    return new TokenomistUnlockSourceAdapter({
      url: env.EVENT_ALPHA_TOKENOMIST_API_URL || TOKENOMIST_URL,
      apiKey: env.EVENT_ALPHA_TOKENOMIST_API_KEY,
      timeoutMs: env.EVENT_ALPHA_SOURCE_TIMEOUT_MS
    }, fetchImpl, clock);
  }

  health() {
    if (!this.apiKey) return { status: "DISABLED", reasonCode: "TOKENOMIST_API_KEY_MISSING" };
    try {
      assertPublicHttps(this.url, new Set(["api.tokenomist.ai"]));
      return { status: "READY", reasonCode: null };
    } catch (error) {
      return { status: "QUARANTINED", reasonCode: error.code || "SOURCE_URL_REJECTED" };
    }
  }

  async poll(_checkpoint = {}, signal) {
    const health = this.health();
    if (health.status !== "READY") return { envelopes: [], checkpoint: {}, health };
    const observed = this.clock();
    const expectationAsOf = floorUtcMinutes(observed, 60).toISOString();
    const target = new URL(this.url);
    target.searchParams.set("page", "1");
    target.searchParams.set("pageSize", "100");
    const body = await fetchJson(target, { headers: { accept: "application/json", "x-api-key": this.apiKey } }, { signal, timeoutMs: this.timeoutMs, allowedHosts: new Set(["api.tokenomist.ai"]), fetchImpl: this.fetchImpl });
    if (body?.status !== true || !Array.isArray(body.data)) throw sourceError("TOKENOMIST_SCHEMA_INVALID", "Tokenomist unlock response is invalid.", false);
    const observedAt = observed.toISOString();
    const envelopes = [];
    for (const row of body.data.slice(0, 100)) {
      const event = row?.upcomingEvent;
      const unlock = event?.cliffUnlocks;
      const unlockTokens = finiteOr(unlock?.cliffAmount, null);
      const referencePrice = finiteOr(event?.referencePrice, null);
      const marketCap = finiteOr(row.marketCap, null);
      const eventTime = safeIso(event?.unlockDate);
      if (!eventTime || !Number.isFinite(unlockTokens) || unlockTokens <= 0 || !Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(marketCap) || marketCap <= 0) continue;
      const circulatingSupply = marketCap / referencePrice;
      const tokenSymbol = normalizedSymbol(row.tokenSymbol);
      if (!tokenSymbol) continue;
      envelopes.push({
        envelope: normalizeRawEventEnvelope({
          sourceKey: this.sourceKey,
          sourceEventId: `${row.tokenId}:${eventTime}`,
          eventFamily: "TOKEN_SUPPLY",
          sourcePublishedAt: safeIso(event.latestUpdateDate),
          observedAt,
          firstActionableAt: eventTime,
          payload: {
            assetId: tokenSymbol,
            symbol: `${tokenSymbol}USDT`,
            eventTime,
            unlockTokens,
            circulatingSupply,
            beneficiaryClass: "MIXED_VESTING",
            liquidImmediatelyPct: 1,
            cliff: true,
            sourceNoticeId: `${row.tokenId}:${eventTime}`,
            sourceConfidence: 0.86,
            referencePrice
          },
          ingestionMetadata: { adapter: "TOKENOMIST_UNLOCKS_V5", tokenId: boundedText(row.tokenId, 160), commercialRedistributionRequired: true }
        }, observed),
        expectation: {
          asOf: expectationAsOf,
          expectedValue: unlockTokens,
          expectedProbability: 1,
          dispersion: 0,
          confidence: 0.86,
          modelKey: "TOKENOMIST_SCHEDULED_UNLOCK",
          modelVersion: "5.0.0",
          contributors: [{ sourceKey: this.sourceKey, observedAt: expectationAsOf, value: unlockTokens, weight: 1 }],
          featureManifest: { scheduledOnly: true, actualReleaseVerificationRequired: true }
        }
      });
    }
    return { envelopes, checkpoint: { watermarkAt: observedAt, cursorValue: null }, health: { status: "HEALTHY", reasonCode: null } };
  }
}

function protocolEnvelope(sourceKey, observed, eventTime, payload, expectation) {
  const eventTimeIso = eventTime.toISOString();
  return {
    envelope: normalizeRawEventEnvelope({
      sourceKey,
      sourceEventId: `${payload.protocolSlug}:${payload.metric}:${eventTimeIso}`,
      eventFamily: "PROTOCOL_ECONOMICS",
      sourcePublishedAt: observed.toISOString(),
      observedAt: observed.toISOString(),
      firstActionableAt: eventTimeIso,
      payload: { ...payload, eventTime: eventTimeIso },
      ingestionMetadata: { adapter: "DEFILLAMA_PROTOCOL_REVENUE_V1", pointInTime: true }
    }, observed),
    expectation
  };
}

function buildGovernanceHistory(rows) {
  const perSpace = new Map();
  for (const row of rows) {
    if (String(row.state).toLowerCase() !== "closed") continue;
    const choices = boundedStrings(row.choices, 50, 160);
    const scores = boundedNumbers(row.scores, 50);
    const affirmative = choices.findIndex(isAffirmativeChoice);
    const negative = choices.findIndex(isNegativeChoice);
    if (affirmative < 0 || negative < 0 || scores.length !== choices.length) continue;
    const key = boundedText(row.space?.id, 160);
    if (!key) continue;
    const bucket = perSpace.get(key) || { passes: 1, total: 2 };
    bucket.total += 1;
    if (scores[affirmative] > scores[negative]) bucket.passes += 1;
    perSpace.set(key, bucket);
  }
  return new Map([...perSpace].map(([key, bucket]) => [key, bucket.passes / bucket.total]));
}

async function fetchJson(input, init, { signal, timeoutMs, allowedHosts, fetchImpl = globalThis.fetch }) {
  const url = input instanceof URL ? input : new URL(input);
  assertPublicHttps(url, allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("SOURCE_TIMEOUT")), timeoutMs);
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relay, { once: true });
  try {
    const response = await fetchImpl(input, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok) throw sourceError(`SOURCE_HTTP_${response.status}`, `Event source rejected request with status ${response.status}.`, [408, 425, 429, 500, 502, 503, 504].includes(response.status));
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) throw sourceError("SOURCE_CONTENT_TYPE_INVALID", "Event source did not return JSON.", false);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw sourceError("SOURCE_RESPONSE_TOO_LARGE", "Event source response exceeds four MiB.", false);
    try { return JSON.parse(text); } catch { throw sourceError("SOURCE_JSON_INVALID", "Event source returned malformed JSON.", false); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

function assertPublicHttps(value, allowedHosts) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw sourceError("SOURCE_HTTPS_REQUIRED", "Event source URL is not an uncredentialed HTTPS URL.", false);
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host) || isIP(host) || host === "localhost" || host.endsWith(".local")) throw sourceError("SOURCE_HOST_NOT_ALLOWED", "Event source host is not allowlisted.", false);
  return url;
}

function parseProtocolConfiguration(value) {
  if (!value) return DEFAULT_PROTOCOLS.map((row) => ({ ...row }));
  const rows = String(value).split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 50);
  return rows.map((entry) => {
    const [slugRaw, symbolRaw, scoreRaw] = entry.split(":");
    const slug = String(slugRaw || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const symbol = String(symbolRaw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const score = Number(scoreRaw);
    if (!slug || !/^[A-Z0-9]{2,36}USDT$/.test(symbol)) throw sourceError("DEFILLAMA_PROTOCOL_CONFIG_INVALID", "DefiLlama protocol mapping is invalid.", false);
    return { slug, symbol, valueCaptureScore: Number.isFinite(score) ? clamp(score, 0, 1) : 0.4 };
  });
}

function boundedCsv(value, fallback, maximum) {
  const rows = value ? String(value).split(",") : fallback;
  return [...new Set(rows.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => /^[a-z0-9.-]{3,160}$/.test(entry)))].slice(0, maximum);
}

function boundedStrings(value, maximum, length) { return Array.isArray(value) ? value.slice(0, maximum).map((entry) => boundedText(entry, length)).filter(Boolean) : []; }
function boundedNumbers(value, maximum) { return Array.isArray(value) ? value.slice(0, maximum).map((entry) => Number(entry)).filter(Number.isFinite).map((entry) => Math.max(0, entry)) : []; }
function boundedText(value, maximum) { const text = String(value ?? "").trim(); return text ? text.slice(0, maximum) : ""; }
function normalizedSymbol(value) { const symbol = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return symbol.length >= 2 && symbol.length <= 36 ? symbol : null; }
function finiteOr(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function divideFinite(value, divisor) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed / divisor : null; }
function robustCenter(values) { const rows = values.filter(Number.isFinite).toSorted((a, b) => a - b); if (!rows.length) return null; const middle = Math.floor(rows.length / 2); return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2; }
function robustDispersion(values, center) { const deviations = values.filter(Number.isFinite).map((value) => Math.abs(value - center)); return robustCenter(deviations) || 0; }
function sumSelected(values, indexes) { return indexes.filter((index) => index >= 0).reduce((sum, index) => sum + Number(values[index] || 0), 0); }
function isAffirmativeChoice(value) { return /^(?:for|yes|approve|accept|support)(?:\b|[,.!?])/i.test(String(value).trim()); }
function isNegativeChoice(value) { return /^(?:against|no|reject|deny|oppose)(?:\b|[,.!?])/i.test(String(value).trim()); }
function unixIso(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1_000).toISOString() : null; }
function safeIso(value) { if (!value) return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null; }
function startOfUtcDay(value) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
function floorUtcMinutes(value, intervalMinutes) {
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1_000;
  return new Date(Math.floor(value.getTime() / intervalMs) * intervalMs);
}
function normalizeMethodologyUrl(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" ? url.toString().slice(0, 1000) : null; } catch { return null; } }
function boundedInteger(value, minimum, maximum) { const parsed = Math.round(Number(value)); return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : minimum)); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function sourceError(code, message, retryable = true) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
