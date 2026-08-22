import type { StrategyWorkspace } from "../../automation/strategyAutomation.types";

export function RuntimeTimeline({ audit, advanced = false }: { audit: StrategyWorkspace["audit"]; advanced?: boolean }) {
  const visible = audit.filter((item) => advanced || !isEngineeringEvent(item.event_type)).slice(0, 50);
  if (!visible.length) return <div className="cockpit-empty-state"><strong>No runtime events yet</strong><span>Signals, Paper fills and worker checkpoints will appear here.</span></div>;
  return <div className="runtime-timeline">{visible.map((item) => <article key={item.id} data-severity={item.severity}><time>{formatTime(item.created_at)}</time><div><strong>{friendlyEvent(item.event_type)}</strong><p>{item.message}</p></div></article>)}</div>;
}

function isEngineeringEvent(type: string) { return /(debug|heartbeat|poll|checkpoint_detail|rpc)/i.test(type); }
function friendlyEvent(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()); }
function formatTime(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
