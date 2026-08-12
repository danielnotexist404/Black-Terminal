import { useEffect, useState } from "react";
import { AlertTriangle, BarChart3, Layers3, Pause, RefreshCw, ShieldCheck } from "lucide-react";
import { investmentGroupsApi } from "../../investment-groups/investmentGroupsApi";
import type { InvestmentGroupCockpit, InvestmentGroupWorkspace } from "../../investment-groups/types";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function InvestmentGroupsPortfolioSection({ onOpenInvestmentGroups }: { onOpenInvestmentGroups: () => void }) {
  const [workspace, setWorkspace] = useState<InvestmentGroupWorkspace | null>(null);
  const [cockpits, setCockpits] = useState<InvestmentGroupCockpit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const next = await investmentGroupsApi.list();
      setWorkspace(next);
      const managed = await Promise.all(next.managed.map((group) => investmentGroupsApi.cockpit(group.id)));
      setCockpits(managed);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  if (loading) return <div className="pm-panel"><div className="pm-panel-title"><RefreshCw size={15} /> Investment Groups</div><div className="pm-panel-empty">LOADING SERVER-BACKED GROUP ALLOCATIONS</div></div>;
  if (error) return <div className="pm-panel"><div className="pm-panel-title"><AlertTriangle size={15} /> Investment Groups unavailable</div><div className="pm-panel-empty">{error.toUpperCase()}</div></div>;
  if (!workspace) return null;

  return (
    <>
      <div className="pm-panel">
        <div className="pm-panel-title"><Layers3 size={15} /> Joined Investment Groups <button type="button" onClick={() => void load()}><RefreshCw size={12} /></button></div>
        {!workspace.joined.length ? <div className="pm-panel-empty">NO JOINED GROUPS. DISCOVER AND COMPLETE A VERSIONED COPY-TRADING APPLICATION IN INVESTMENT GROUPS.</div> : (
          <div className="pm-table pm-groups-capital-table">
            <div className="pm-table-head"><span>GROUP</span><span>STATUS</span><span>ALLOCATION</span><span>ALLOCATED EQUITY</span><span>REALIZED</span><span>UNREALIZED</span><span>NET PNL</span><span>DRAWDOWN</span><span>POSITIONS</span><span>EXECUTION</span></div>
            {workspace.joined.map((group) => <div className="pm-table-row" key={group.id}><strong>{group.firmName}</strong><span>{group.membership?.state.replaceAll("_", " ")}</span><span>{value(group.memberCapital?.allocationPercent, "%")}</span><span>{currency(group.memberCapital?.allocatedEquity)}</span><Pnl value={group.memberCapital?.realizedPnl} /><Pnl value={group.memberCapital?.unrealizedPnl} /><Pnl value={group.memberCapital?.netPnl} /><span>{value(group.memberCapital?.drawdownPercent, "%")}</span><span>{group.memberCapital?.activePositions ?? "UNAVAILABLE"}</span><em>{group.memberCapital?.executionMode === "CLOUD_DELEGATED" ? `${group.memberCapital.freshness} / PERSISTENT` : group.memberCapital?.executionMode || "UNAVAILABLE"}</em></div>)}
          </div>
        )}
        <div className="pm-group-actions"><button type="button" onClick={onOpenInvestmentGroups}><Pause size={13} /> Manage pause / leave</button></div>
      </div>
      <div className="pm-panel">
        <div className="pm-panel-title"><ShieldCheck size={15} /> My Investment Group Summary</div>
        {!cockpits.length ? <div className="pm-panel-empty">NO AUTHORIZED OWNER OR MANAGER COCKPIT.</div> : (
          <div className="pm-table pm-owner-group-table"><div className="pm-table-head"><span>GROUP</span><span>HEALTH</span><span>CONNECTED EQUITY</span><span>ALLOCATED</span><span>ACTIVE</span><span>NET PNL</span><span>DRAWDOWN</span><span>GROSS EXPOSURE</span><span>RISK ALERTS</span></div>{cockpits.map((cockpit) => <button type="button" className="pm-table-row" key={cockpit.group.id} onClick={onOpenInvestmentGroups}><strong>{cockpit.group.firmName}</strong><span>{cockpit.health.status.replaceAll("_", " ")}</span><span>{money.format(cockpit.aggregate.connectedEquity)}</span><span>{money.format(cockpit.aggregate.allocatedEquity)}</span><span>{cockpit.aggregate.activeMembers}</span><Pnl value={cockpit.aggregate.netPnl} /><span>{value(cockpit.aggregate.currentDrawdownPercent, "%")}</span><span>{money.format(cockpit.aggregate.grossExposure)}</span><em>{cockpit.aggregate.degradedMembers ? `${cockpit.aggregate.degradedMembers} DEGRADED` : "NONE"}</em></button>)}</div>
        )}
      </div>
      <div className="pm-panel"><div className="pm-panel-title"><BarChart3 size={15} /> Capital boundary</div><div className="pm-risk-list"><span>Copy Trading capital <b>LIVE MANDATES ONLY</b></span><span>Obsidian capital <b>EXCLUDED — RESEARCH ONLY</b></span><span>Broker credentials <b>INACCESSIBLE TO MANAGERS</b></span><span>Withdrawal authority <b>NEVER</b></span></div></div>
    </>
  );
}

function Pnl({ value }: { value: number | null | undefined }) { return value == null ? <span>UNAVAILABLE</span> : <strong className={value > 0 ? "positive" : value < 0 ? "negative" : ""}>{value >= 0 ? "+" : "−"}{money.format(Math.abs(value))}</strong>; }
function currency(value: number | null | undefined) { return value == null ? "UNAVAILABLE" : money.format(value); }
function value(value: number | null | undefined, suffix: string) { return value == null ? "UNAVAILABLE" : `${value}${suffix}`; }
