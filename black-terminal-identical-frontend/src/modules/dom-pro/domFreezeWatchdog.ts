import { blackCorePerformanceMonitor, type PerformanceSnapshot } from "../../performance/performanceMonitor";
import { domPerformanceTrace } from "./domPerformanceTrace";

export type DomPerformanceIncident = {
  time: number;
  symbol: string;
  preset: string;
  quality: string;
  frameP95Ms: number;
  frameP99Ms: number;
  longestTaskMs: number;
  workerQueueDepth: number;
  renderQueueDepth: number;
  heapUsedMb: number | null;
  domNodes: number | null;
  reason: string;
};

class DomFreezeWatchdog {
  private incidents: DomPerformanceIncident[] = [];
  private lastIncidentAt = 0;

  start(context: () => { symbol: string; preset: string; quality: string }) {
    return blackCorePerformanceMonitor.subscribe((snapshot) => this.inspect(snapshot, context()));
  }

  snapshot() { return [...this.incidents]; }

  private inspect(snapshot: PerformanceSnapshot, context: ReturnType<Parameters<DomFreezeWatchdog["start"]>[0]>) {
    const reason = incidentReason(snapshot);
    if (!reason || Date.now() - this.lastIncidentAt < 30_000) return;
    this.lastIncidentAt = Date.now();
    const incident: DomPerformanceIncident = {
      time: this.lastIncidentAt,
      ...context,
      frameP95Ms: snapshot.p95FrameMs,
      frameP99Ms: snapshot.p99FrameMs,
      longestTaskMs: snapshot.longestTaskMs,
      workerQueueDepth: snapshot.workerQueueDepth,
      renderQueueDepth: snapshot.renderQueueDepth,
      heapUsedMb: snapshot.heapUsedMb,
      domNodes: snapshot.domNodes,
      reason
    };
    this.incidents.push(incident);
    if (this.incidents.length > 20) this.incidents.splice(0, this.incidents.length - 20);
    domPerformanceTrace.increment(`watchdog.${reason}`);
    try { sessionStorage.setItem("bt_dom_performance_incidents", JSON.stringify(this.incidents)); } catch {}
  }
}

function incidentReason(snapshot: PerformanceSnapshot) {
  if (snapshot.workerQueueDepth > 2) return "worker_queue_spike";
  if (snapshot.status === "degraded" && snapshot.longestTaskMs > 250) return "long_task";
  if (snapshot.p99FrameMs > 160) return "frame_gap";
  if ((snapshot.heapGrowthMb ?? 0) > 256) return "heap_pressure";
  return "";
}

export const domFreezeWatchdog = new DomFreezeWatchdog();

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("domPerfTrace")) {
  (window as Window & { __DOM_PRO_INCIDENTS__?: () => DomPerformanceIncident[] }).__DOM_PRO_INCIDENTS__ = () => domFreezeWatchdog.snapshot();
}
