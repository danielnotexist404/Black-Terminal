import { useEffect, useMemo, useState } from "react";
import { blackCorePerformanceMonitor, type PerformanceSnapshot } from "./performanceMonitor";

const storageKey = "bt_performance_hud_visible";

export function PerformanceHud() {
  const [visible, setVisible] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem(storageKey) === "true");
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>(() => blackCorePerformanceMonitor.snapshot());
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => blackCorePerformanceMonitor.subscribe(setSnapshot), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.code !== "KeyP") return;
      event.preventDefault();
      setVisible((current) => {
        const next = !current;
        localStorage.setItem(storageKey, String(next));
        return next;
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const status = useMemo(() => {
    if (snapshot.p99FrameMs > 50 || snapshot.longTaskCount > 0) return "DEGRADED";
    if (snapshot.averageFrameMs > 22) return "WATCH";
    return "STABLE";
  }, [snapshot.averageFrameMs, snapshot.longTaskCount, snapshot.p99FrameMs]);

  if (!visible) return null;

  const copySnapshot = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopyStatus("COPIED");
      window.setTimeout(() => setCopyStatus(""), 1600);
    } catch {
      setCopyStatus("COPY FAILED");
    }
  };

  return (
    <aside className="performance-hud" aria-label="Black Core performance HUD">
      <header>
        <div>
          <b>PERFORMANCE HUD</b>
          <span>{status}</span>
        </div>
        <button type="button" onClick={() => {
          localStorage.setItem(storageKey, "false");
          setVisible(false);
        }}>Close</button>
      </header>
      <main>
        <HudMetric label="FPS" value={snapshot.fps.toFixed(1)} />
        <HudMetric label="Avg Frame" value={`${snapshot.averageFrameMs.toFixed(2)} ms`} />
        <HudMetric label="P99 Frame" value={`${snapshot.p99FrameMs.toFixed(2)} ms`} hot={snapshot.p99FrameMs > 50} />
        <HudMetric label="Worst Frame" value={`${snapshot.worstFrameMs.toFixed(2)} ms`} hot={snapshot.worstFrameMs > 80} />
        <HudMetric label="Dropped" value={String(snapshot.droppedFrames)} hot={snapshot.droppedFrames > 0} />
        <HudMetric label="Long Tasks" value={String(snapshot.longTaskCount)} hot={snapshot.longTaskCount > 0} />
        <HudMetric label="Heap" value={snapshot.heapUsedMb === null ? "N/A" : `${snapshot.heapUsedMb.toFixed(1)} MB`} />
        <HudMetric label="Heap Limit" value={snapshot.heapLimitMb === null ? "N/A" : `${snapshot.heapLimitMb.toFixed(0)} MB`} />
        <HudMetric label="DOM Nodes" value={snapshot.domNodes === null ? "N/A" : String(snapshot.domNodes)} />
        <HudMetric label="Listeners" value={String(snapshot.eventBus.listenerCount)} hot={snapshot.eventBus.listenerCount > 80} />
        <HudMetric label="Event Types" value={String(snapshot.eventBus.eventTypeCount)} />
        <HudMetric label="Publishes" value={String(snapshot.eventBus.totalPublishes)} />
      </main>
      <section>
        {snapshot.latestMetrics.slice(0, 6).map((metric) => (
          <div key={`${metric.name}-${metric.time}`}>
            <span>{metric.name}</span>
            <b>{metric.value.toFixed(metric.value >= 100 ? 0 : 2)} {metric.unit}</b>
          </div>
        ))}
      </section>
      <footer>
        <button type="button" onClick={copySnapshot}>Copy Snapshot</button>
        <span>Ctrl+Shift+P</span>
        {copyStatus && <em>{copyStatus}</em>}
      </footer>
    </aside>
  );
}

function HudMetric({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className={hot ? "hot" : ""}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
