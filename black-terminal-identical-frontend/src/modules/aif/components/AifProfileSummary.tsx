import { useState } from "react";
import type { AifRenderModel } from "../core/aifTypes";

export function AifProfileSummary({ model }: { model: AifRenderModel }) {
  const [collapsed, setCollapsed] = useState(false);
  const summary = model.auctionStateSummary;
  const profile = model.profileHistogram;
  const hvns = model.primaryNodes.filter((node) => node.nodeType === "hvn").length;
  const nearest = [...model.lvnZones].sort((a, b) => Math.abs(a.center - model.currentPrice) - Math.abs(b.center - model.currentPrice))[0];
  const above = model.projectedLvns.filter((zone) => zone.center >= model.currentPrice).length;
  const stability = model.projectedLvns.length ? Math.round(model.projectedLvns.reduce((sum, zone) => sum + zone.stability, 0) / model.projectedLvns.length) : 0;
  return <div className={`aif-summary ${collapsed ? "collapsed" : ""}`} data-testid="aif-summary"><button type="button" className="aif-summary-toggle" onClick={() => setCollapsed((value) => !value)}>A.I.F. AUCTION STATE <b>{collapsed ? "+" : "-"}</b></button>{!collapsed && <><span>PROFILE <b>{summary.profile}</b></span><span>LOOKBACK <b>{model.provenance.effectiveLookbackBars.toLocaleString()} / {model.provenance.requestedLookbackBars.toLocaleString()}</b></span><span>POC <b>{format(profile.poc)}</b></span><span>VAH / VAL <b>{format(profile.vah)} / {format(profile.val)}</b></span><span>NODES <b>HVN {hvns} / LVN {model.lvnZones.length}</b></span><span>FUTURE LVNs <b>{above} ABOVE / {model.projectedLvns.length - above} BELOW</b></span><span>NEAREST <b>{nearest ? `${format(nearest.low)}-${format(nearest.high)}` : "-"}</b></span><span>STATE <b>{nearest?.state.toUpperCase() ?? summary.state}</b></span><span>STABILITY <b>{stability}%</b></span><span>CHoB <b>{summary.chob.replaceAll("_", " ")}</b></span><span>IMM <b>{summary.imm}</b></span><span>SOURCE <b>{model.provenance.sourceResolution} / {summary.dataQuality}</b></span><span>ENGINE <b>{model.provenance.engineVersion} / {model.calculationMs.toFixed(1)} MS</b></span></>}</div>;
}

function format(value: number | null) { return value == null ? "-" : value.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
