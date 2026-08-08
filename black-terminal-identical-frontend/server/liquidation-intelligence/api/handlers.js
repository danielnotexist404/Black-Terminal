import { bclifHttpError, parseBclifScope, parseTileChecksum, parseTileId } from "./contracts.js";
import {
  loadVerifiedBclifTile,
  readBclifCoverage,
  readBclifDiagnostics,
  readBclifManifest,
  readBclifStatus
} from "./service.js";

export async function handleBclifAction(action, req, res, security) {
  if (req.method !== "GET") throw bclifHttpError(405, "Method Not Allowed", "METHOD_NOT_ALLOWED");
  if (action === "status" || action === "health") return respondJson(res, await readBclifStatus(security.supabase));
  if (action === "diagnostics") {
    if (security.identity.role !== "admin") throw bclifHttpError(403, "Administrator access is required for BCLIF diagnostics.", "ADMIN_REQUIRED");
    return respondJson(res, await readBclifDiagnostics(security.supabase));
  }
  // Every proprietary historical read is bound to a finite causal window.
  // Status/health/diagnostics are the only unscoped actions.
  const scope = parseBclifScope(req.query || {}, { requireRange: true, requireMode: true });
  if (action === "coverage") return respondJson(res, await readBclifCoverage(security.supabase, scope));
  if (action === "manifest") return respondJson(res, await readBclifManifest(security.supabase, scope));
  if (action === "tile") {
    const tile = await loadVerifiedBclifTile(
      security.supabase,
      scope,
      parseTileId(req.query?.tileId || req.query?.id),
      parseTileChecksum(req.query?.checksum)
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(tile.bytes.byteLength));
    res.setHeader("ETag", `\"${tile.metadata.checksum}\"`);
    res.setHeader("Cache-Control", tile.metadata.publicationState === "STAGING" ? "private, no-store" : "private, max-age=300, immutable");
    res.setHeader("Vary", "Origin, Authorization");
    res.setHeader("X-BCLIF-Schema-Version", String(tile.metadata.schemaVersion));
    res.setHeader("X-BCLIF-Model-Version", String(tile.metadata.modelVersion));
    return res.end(tile.bytes);
  }
  throw bclifHttpError(404, "Unknown liquidation-intelligence route.", "BCLIF_ROUTE_NOT_FOUND");
}

function respondJson(res, result) {
  if (result.httpStatus === 503) res.setHeader("Retry-After", "15");
  return res.status(result.httpStatus).json(result.payload);
}
