import type { AifRenderModel } from "../core/aifTypes";

export function AifProfileSummary({ model }: { model: AifRenderModel }) {
  const summary = model.auctionStateSummary;
  const profile = model.profileHistogram;
  return <div className="aif-summary" data-testid="aif-summary"><strong>A.I.F. AUCTION STATE</strong><span>PROFILE <b>{summary.profile}</b></span><span>RANGE <b>{model.provenance.effectiveLookbackBars.toLocaleString()} / {model.provenance.requestedLookbackBars.toLocaleString()}</b></span><span>POC <b>{format(profile.poc)}</b></span><span>VAH / VAL <b>{format(profile.vah)} / {format(profile.val)}</b></span><span>NODES / FUTURE <b>{model.primaryNodes.length} / {model.projectedLvns.length}</b></span><span>NEAREST <b>{summary.nearestStructure}</b></span><span>STATE <b>{summary.state}</b></span><span>CHoB <b>{summary.chob.replaceAll("_", " ")}</b></span><span>IMM <b>{summary.imm}</b></span><span>SOURCE <b>{model.provenance.sourceResolution} / {summary.dataQuality}</b></span><span>ENGINE <b>{model.calculationMs.toFixed(1)} MS / {model.cacheState.toUpperCase()}</b></span></div>;
}

function format(value: number | null) { return value == null ? "-" : value.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
