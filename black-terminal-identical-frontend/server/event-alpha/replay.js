import { assessEventSurprise, buildEventAlphaThesis, forecastEventResponse } from "./engine.js";
import { EVENT_ALPHA_REASON_CODES, normalizeRawEventEnvelope, normalizeTokenUnlock, sha256 } from "./domain.js";

export function runPointInTimeEventReplay(input) {
  const configuration = normalizeReplayConfiguration(input.configuration);
  const events = input.rawEvents.map((row) => normalizeRawEventEnvelope(row))
    .toSorted((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.sourceEventId.localeCompare(b.sourceEventId));
  const availableEvents = events.filter((event) => Date.parse(event.observedAt) <= Date.parse(configuration.cutoffAt));
  const results = [];
  const canonicalAtCutoff = new Map();
  for (const envelope of availableEvents) {
    const canonical = envelope.eventFamily === "TOKEN_SUPPLY" ? normalizeTokenUnlock(envelope) : null;
    if (!canonical) continue;
    const prior = canonicalAtCutoff.get(canonical.canonicalKey);
    if (!prior || Date.parse(envelope.observedAt) > Date.parse(prior.envelope.observedAt)
      || (envelope.observedAt === prior.envelope.observedAt && envelope.sourceEventId > prior.envelope.sourceEventId)) {
      canonicalAtCutoff.set(canonical.canonicalKey, { envelope, canonical });
    }
  }
  for (const { canonical } of [...canonicalAtCutoff.values()].toSorted((a, b) => a.canonical.canonicalKey.localeCompare(b.canonical.canonicalKey))) {
    const expectation = selectPointInTime(input.expectations, canonical, "asOf", canonical.firstActionableAt);
    const assetProfile = selectPointInTime(input.assetProfiles, canonical, "knownAt", canonical.firstActionableAt);
    const observation = selectObservation(input.marketObservations, canonical, configuration.cutoffAt, configuration.latencyMs);
    const tradability = observation ? selectTradability(input.tradableUniverse, canonical, observation.cutoffAt) : null;
    if (!expectation || !assetProfile || !observation || !tradability) {
      results.push({ canonicalKey: canonical.canonicalKey, outcome: "NO_TRADE", reasonCodes: [EVENT_ALPHA_REASON_CODES.POINT_IN_TIME_EVIDENCE_INCOMPLETE] });
      continue;
    }
    const surprise = assessEventSurprise({ canonicalEvent: canonical, expectation, assetProfile, assessedAt: observation.cutoffAt });
    const forecast = forecastEventResponse({
      surprise,
      realizedAssetReturnBps: observation.assetReturnBps,
      realizedBenchmarkReturnBps: observation.benchmarkReturnBps,
      horizonSeconds: observation.horizonSeconds,
      costs: { ...configuration.costs, ...(observation.costs || {}) }
    });
    const thesis = buildEventAlphaThesis({ canonicalEvent: canonical, forecast, validFrom: observation.cutoffAt, expiresAt: observation.expiresAt });
    results.push({ canonicalKey: canonical.canonicalKey, surprise, forecast, thesis });
  }
  const replayIdentity = {
    engineVersion: "EVENT_ALPHA_REPLAY_V1",
    codeCommit: configuration.codeCommit,
    configurationHash: configuration.configurationHash,
    dataSnapshotIdentifiers: configuration.dataSnapshotIdentifiers,
    eventSchemaVersion: "EVENT_ALPHA_EVENT_V1",
    modelVersions: configuration.modelVersions,
    featureVersions: configuration.featureVersions,
    randomSeed: configuration.randomSeed,
    startTimestamp: availableEvents[0]?.observedAt || configuration.cutoffAt,
    cutoffAt: configuration.cutoffAt,
    latencyMs: configuration.latencyMs,
    costs: configuration.costs,
    tradableUniverseDefinition: configuration.tradableUniverseDefinition,
    eventCount: availableEvents.length,
    canonicalEventCount: canonicalAtCutoff.size,
    resultCount: results.length,
    sourceHashes: availableEvents.map((event) => event.payloadHash).toSorted(),
    tradableUniverseHash: sha256(input.tradableUniverse || [])
  };
  const manifestHash = sha256(replayIdentity);
  return Object.freeze({ manifest: { runId: `EAE-${manifestHash.slice(0, 24)}`, ...replayIdentity, manifestHash }, results });
}

function normalizeReplayConfiguration(value = {}) {
  const cutoffAt = new Date(value.cutoffAt).toISOString();
  const codeCommit = requiredReplayText(value.codeCommit, "codeCommit", 120);
  const dataSnapshotIdentifiers = requiredReplayTextArray(value.dataSnapshotIdentifiers, "dataSnapshotIdentifiers");
  const tradableUniverseDefinition = requiredReplayText(value.tradableUniverseDefinition, "tradableUniverseDefinition", 240);
  const modelVersions = requiredReplayObject(value.modelVersions, "modelVersions");
  const featureVersions = requiredReplayObject(value.featureVersions, "featureVersions");
  const normalized = {
    cutoffAt,
    codeCommit,
    dataSnapshotIdentifiers,
    tradableUniverseDefinition,
    modelVersions,
    featureVersions,
    randomSeed: bounded(value.randomSeed, 0, 2_147_483_647, "randomSeed"),
    latencyMs: bounded(value.latencyMs ?? 500, 0, 300_000, "latencyMs"),
    costs: {
      spreadBps: bounded(value.costs?.spreadBps ?? 2, 0, 1_000, "spreadBps"),
      slippageBps: bounded(value.costs?.slippageBps ?? 3, 0, 1_000, "slippageBps"),
      feesBps: bounded(value.costs?.feesBps ?? 5, 0, 1_000, "feesBps"),
      fundingBps: bounded(value.costs?.fundingBps ?? 0, -1_000, 1_000, "fundingBps")
    }
  };
  return { ...normalized, configurationHash: sha256(normalized) };
}

function selectPointInTime(rows, event, field, before) {
  return (rows || []).filter((row) => row.canonicalEventKey === event.canonicalKey && Date.parse(row[field]) < Date.parse(before))
    .toSorted((a, b) => Date.parse(b[field]) - Date.parse(a[field]))[0] || null;
}

function selectObservation(rows, event, cutoffAt, latencyMs) {
  const earliestTradableAt = Date.parse(event.firstActionableAt) + latencyMs;
  return (rows || []).filter((row) => row.canonicalEventKey === event.canonicalKey && Date.parse(row.cutoffAt) <= Date.parse(cutoffAt) && Date.parse(row.cutoffAt) >= earliestTradableAt)
    .toSorted((a, b) => Date.parse(a.cutoffAt) - Date.parse(b.cutoffAt))[0] || null;
}

function selectTradability(rows, event, cutoffAt) {
  const cutoff = Date.parse(cutoffAt);
  return (rows || []).filter((row) => row.symbol === event.symbol
      && Date.parse(row.knownAt) <= cutoff
      && Date.parse(row.listedAt) <= cutoff
      && (row.delistedAt === null || row.delistedAt === undefined || cutoff < Date.parse(row.delistedAt))
      && row.venueAvailable === true
      && ["SPOT", "PERPETUAL", "FUTURE"].includes(String(row.marketKind || "").toUpperCase()))
    .toSorted((a, b) => Date.parse(b.knownAt) - Date.parse(a.knownAt))[0] || null;
}

function bounded(value, minimum, maximum, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`EVENT_ALPHA_REPLAY_${field.toUpperCase()}_INVALID`);
  return value;
}

function requiredReplayText(value, field, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) throw new Error(`EVENT_ALPHA_REPLAY_${field.toUpperCase()}_INVALID`);
  return text;
}

function requiredReplayTextArray(value, field) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`EVENT_ALPHA_REPLAY_${field.toUpperCase()}_INVALID`);
  return value.map((entry) => requiredReplayText(entry, field, 240)).toSorted();
}

function requiredReplayObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error(`EVENT_ALPHA_REPLAY_${field.toUpperCase()}_INVALID`);
  return JSON.parse(JSON.stringify(value));
}
