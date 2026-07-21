import { Flag, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { professionalNetworkApi } from "../networkApi";

type ReportRow = Record<string, unknown> & { id: string; target_type: string; reason: string; details?: string; status: string; created_at: string };

export function ModerationPanel() {
  const [statusFilter, setStatusFilter] = useState("pending");
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const result = await professionalNetworkApi.moderationReports(statusFilter); setReports(result.reports as ReportRow[]); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [statusFilter]);
  useEffect(() => { void load(); }, [load]);
  const resolve = async (report: ReportRow, action: string) => {
    const reason = window.prompt("Record an internal moderation reason. This is written to the immutable audit trail.");
    if (!reason?.trim()) return;
    const options: { scope?: string; durationDays?: number } = {};
    if (action === "restrict") {
      const scope = window.prompt("Restriction scope: all, posting, comments, engagement, messaging, or media", "all")?.trim().toLowerCase();
      if (!scope || !["all", "posting", "comments", "engagement", "messaging", "media"].includes(scope)) { setStatus("Choose a valid restriction scope."); return; }
      options.scope = scope;
    }
    if (action === "restrict" || action === "suspend") {
      const duration = Number(window.prompt("Duration in days (1-365)", action === "suspend" ? "30" : "7"));
      if (!Number.isInteger(duration) || duration < 1 || duration > 365) { setStatus("Choose a duration from 1 to 365 days."); return; }
      options.durationDays = duration;
    }
    setBusy(report.id);
    try { await professionalNetworkApi.moderationAction(report.id, action, reason.trim(), options); setReports((current) => current.filter((item) => item.id !== report.id)); setStatus("Moderation action recorded."); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  return <section className="pn-moderation"><header><div><ShieldCheck size={15} /><span>Professional Network Moderation</span></div><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="pending">Pending</option><option value="reviewing">Reviewing</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></header>{status && <div className="pn-form-status">{status}</div>}{reports.length === 0 ? <div className="pn-empty"><Flag size={20} /><strong>No Reports In This Queue</strong><span>Report identities and private details remain restricted to authorized administrators.</span></div> : <div className="pn-moderation-list">{reports.map((report) => <article key={report.id}><header><span>{report.target_type}</span><strong>{report.reason.replaceAll("_", " ")}</strong><time>{new Date(report.created_at).toLocaleString()}</time></header><p>{report.details || "No additional reporter details."}</p><footer><button type="button" disabled={busy === report.id} onClick={() => resolve(report, "none")}>Dismiss</button><button type="button" disabled={busy === report.id} onClick={() => resolve(report, "warn")}>Warn</button><button type="button" disabled={busy === report.id} onClick={() => resolve(report, "hide")}>Hide</button><button type="button" disabled={busy === report.id} onClick={() => resolve(report, "restrict")}>Restrict</button><button type="button" className="danger" disabled={busy === report.id} onClick={() => resolve(report, "suspend")}>Suspend</button><button type="button" className="danger" disabled={busy === report.id} onClick={() => resolve(report, "remove")}>Remove</button></footer></article>)}</div>}</section>;
}
