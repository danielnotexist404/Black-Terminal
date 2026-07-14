import type { AifTimelineEvent } from "../core/aifTypes";

export function AifEventTimeline({ events, onSelectNode, height = 46 }: { events: AifTimelineEvent[]; onSelectNode?: (nodeId: string) => void; height?: number }) {
  return <div className="aif-timeline" data-testid="aif-timeline" style={{ height }}><span className="aif-timeline-title">AUCTION EVENTS</span><div className="aif-timeline-track">{events.length ? events.slice(-10).map((event) => <button type="button" key={event.id} className={event.type.includes("chob") ? "critical" : ""} title={`${event.type} ${event.confidence}%`} onClick={() => event.nodeId && onSelectNode?.(event.nodeId)}><i /><span>{event.type.replaceAll("-", " ")}</span><b>{event.confidence}%</b></button>) : <span className="aif-empty">NO QUALIFIED EVENTS IN CURRENT HORIZON</span>}</div></div>;
}
