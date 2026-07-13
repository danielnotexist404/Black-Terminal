import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Download, Flag, Pause, Play, RotateCcw, X } from "lucide-react";
import { blackCorePerformanceMonitor, type PerformanceSnapshot } from "./performanceMonitor";

const storageKey = "bt_performance_hud_visible";

export function PerformanceHud({ isAdmin }: { isAdmin: boolean }) {
  if (!isAdmin) return null;
  return <AdminPerformanceHud />;
}

function AdminPerformanceHud() {
  const [visible, setVisible] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem(storageKey) === "true");
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>(() => blackCorePerformanceMonitor.snapshot());
  const [capturing, setCapturing] = useState(() => blackCorePerformanceMonitor.isCapturing());
  const [actionStatus, setActionStatus] = useState("");

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

  const resourceSummary = useMemo(() => {
    const active = snapshot.resources.active;
    return {
      sockets: active.websocket ?? 0,
      workers: active.worker ?? 0,
      timers: (active.interval ?? 0) + (active.timeout ?? 0),
      listeners: active.listener ?? snapshot.eventBus.listenerCount,
      observers: active.observer ?? 0,
      subscriptions: active["supabase-subscription"] ?? 0,
      pixi: (active["pixi-container"] ?? 0) + (active["pixi-graphics"] ?? 0) + (active["pixi-text"] ?? 0),
      textures: active["pixi-texture"] ?? 0,
      geometries: active["pixi-geometry"] ?? 0
    };
  }, [snapshot]);

  if (!visible) return null;

  const showStatus = (value: string) => {
    setActionStatus(value);
    window.setTimeout(() => setActionStatus(""), 1600);
  };

  const exportJson = (name: string, value: unknown) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showStatus("EXPORTED");
  };

  return (
    <aside className="performance-hud" aria-label="Black Core performance HUD">
      <header>
        <div><b>BLACK CORE PERFORMANCE</b><span className={snapshot.status}>{snapshot.status.toUpperCase()}</span></div>
        <button type="button" title="Close performance HUD" onClick={() => {
          localStorage.setItem(storageKey, "false");
          setVisible(false);
        }}><X size={13} /></button>
      </header>

      <HudSection title="Render">
        <HudMetric label="Chart FPS" value={format(snapshot.chartFps)} />
        <HudMetric label="IMM FPS" value={format(snapshot.immFps)} />
        <HudMetric label="Frame Avg" value={ms(snapshot.averageFrameMs)} />
        <HudMetric label="Frame P95" value={ms(snapshot.p95FrameMs)} hot={snapshot.p95FrameMs > 32} />
        <HudMetric label="Frame P99" value={ms(snapshot.p99FrameMs)} hot={snapshot.p99FrameMs > 50} />
        <HudMetric label="Longest" value={ms(snapshot.worstFrameMs)} hot={snapshot.worstFrameMs > 80} />
        <HudMetric label="Dropped" value={String(snapshot.droppedFrames)} hot={snapshot.droppedFrames > 0} />
      </HudSection>

      <HudSection title="Memory">
        <HudMetric label="JS Heap" value={mb(snapshot.heapUsedMb)} />
        <HudMetric label="Heap Growth" value={signedMb(snapshot.heapGrowthMb)} hot={(snapshot.heapGrowthMb ?? 0) > 128} />
        <HudMetric label="DOM Nodes" value={nullable(snapshot.domNodes)} />
        <HudMetric label="Pixi Objects" value={String(resourceSummary.pixi)} />
        <HudMetric label="Textures" value={String(resourceSummary.textures)} />
        <HudMetric label="Geometries" value={String(resourceSummary.geometries)} />
      </HudSection>

      <HudSection title="Pipelines">
        <HudMetric label="Public msg/s" value={format(snapshot.publicMessagesPerSecond)} />
        <HudMetric label="Private msg/s" value={format(snapshot.privateMessagesPerSecond)} />
        <HudMetric label="Events/s" value={format(snapshot.eventBusEventsPerSecond)} />
        <HudMetric label="Worker Queue" value={String(snapshot.workerQueueDepth)} hot={snapshot.workerQueueDepth > 2} />
        <HudMetric label="Render Queue" value={String(snapshot.renderQueueDepth)} hot={snapshot.renderQueueDepth > 8} />
      </HudSection>

      <HudSection title="Execution">
        <LatestMetric snapshot={snapshot} name="execution.oms_ms" label="OMS" />
        <LatestMetric snapshot={snapshot} name="execution.risk_ms" label="EMS Risk" />
        <LatestMetric snapshot={snapshot} name="execution.router_ms" label="Broker Router" />
        <LatestMetric snapshot={snapshot} name="execution.round_trip_ms" label="Round Trip" />
        <LatestMetric snapshot={snapshot} name="account.freshness_ms" label="Account Freshness" />
      </HudSection>

      <HudSection title="Resources">
        <HudMetric label="WebSockets" value={String(resourceSummary.sockets)} />
        <HudMetric label="Workers" value={String(resourceSummary.workers)} />
        <HudMetric label="Timers" value={String(resourceSummary.timers)} />
        <HudMetric label="Listeners" value={String(resourceSummary.listeners)} />
        <HudMetric label="Observers" value={String(resourceSummary.observers)} />
        <HudMetric label="Supabase" value={String(resourceSummary.subscriptions)} />
      </HudSection>

      <footer>
        <button type="button" onClick={() => {
          if (capturing) {
            blackCorePerformanceMonitor.stopCapture();
            setCapturing(false);
            showStatus("CAPTURE STOPPED");
          } else {
            blackCorePerformanceMonitor.startCapture();
            setCapturing(true);
            showStatus("CAPTURE STARTED");
          }
        }}>{capturing ? <Pause size={12} /> : <Play size={12} />}{capturing ? "Stop Capture" : "Start Capture"}</button>
        <button type="button" onClick={() => exportJson("black-terminal-performance-snapshot", snapshot)}><Download size={12} />Snapshot</button>
        <button type="button" onClick={() => exportJson("black-terminal-performance-session", blackCorePerformanceMonitor.sessionReport())}><Download size={12} />Session</button>
        <button type="button" onClick={() => { blackCorePerformanceMonitor.mark("ADMIN MARK"); showStatus("MARKED"); }}><Flag size={12} />Mark</button>
        <button type="button" onClick={() => { blackCorePerformanceMonitor.resetCounters(); showStatus("RESET"); }}><RotateCcw size={12} />Reset</button>
        {actionStatus && <em>{actionStatus}</em>}
      </footer>
    </aside>
  );
}

function HudSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h4>{title}</h4><div>{children}</div></section>;
}

function LatestMetric({ snapshot, name, label }: { snapshot: PerformanceSnapshot; name: string; label: string }) {
  const metric = snapshot.latestMetrics.find((item) => item.name === name);
  return <HudMetric label={label} value={metric ? `${format(metric.value)} ${metric.unit}` : "--"} />;
}

function HudMetric({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return <div className={hot ? "hot" : ""}><span>{label}</span><b>{value}</b></div>;
}

function format(value: number) { return Number.isFinite(value) ? value.toFixed(1) : "--"; }
function ms(value: number) { return `${format(value)} ms`; }
function mb(value: number | null) { return value === null ? "N/A" : `${value.toFixed(1)} MB`; }
function signedMb(value: number | null) { return value === null ? "N/A" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} MB`; }
function nullable(value: number | null) { return value === null ? "N/A" : String(value); }
