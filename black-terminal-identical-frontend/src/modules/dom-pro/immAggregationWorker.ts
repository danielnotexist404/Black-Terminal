type ReplayPoint = {
  id: string;
  side: "bid" | "ask";
  price: number;
  bucketSize: number;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  peakSize: number;
  lastSize: number;
  strength: number;
  source?: string;
};

type ShapeReplayMessage = {
  id: string;
  type: "shape-depth-replay";
  points: ReplayPoint[];
  range: { min: number; max: number };
  maxPoints: number;
};

type WorkerResponse = {
  id: string;
  type: "shape-depth-replay:done" | "error";
  points?: ReplayPoint[];
  scars?: Array<{ id: string; side: "bid" | "ask"; price: number; strength: number; lastSeen: number }>;
  error?: string;
};

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ShapeReplayMessage>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

ctx.onmessage = (event: MessageEvent<ShapeReplayMessage>) => {
  const message = event.data;
  try {
    if (message.type !== "shape-depth-replay") return;
    const result = shapeReplay(message.points, message.range, message.maxPoints);
    post({ id: message.id, type: "shape-depth-replay:done", ...result });
  } catch (error) {
    post({
      id: message.id,
      type: "error",
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

function shapeReplay(points: ReplayPoint[], range: { min: number; max: number }, maxPoints: number) {
  const now = Date.now();
  const inside = points
    .filter((point) => Number.isFinite(point.price) && point.price >= range.min && point.price <= range.max)
    .map((point) => ({ ...point, strength: clamp(point.strength) }))
    .sort((a, b) => scorePoint(b, now) - scorePoint(a, now));

  const balanced = balanceSides(inside, maxPoints);
  const scars = inside
    .filter((point) => point.source === "black-core-wall" && now - point.lastSeen > 30 * 60_000)
    .slice(0, 80)
    .map((point) => ({
      id: `scar:${point.id}`,
      side: point.side,
      price: point.price,
      strength: point.strength,
      lastSeen: point.lastSeen
    }));

  return {
    points: balanced.sort((a, b) => b.price - a.price),
    scars
  };
}

function balanceSides(points: ReplayPoint[], maxPoints: number) {
  const cap = Math.max(20, maxPoints);
  const perSide = Math.max(10, Math.floor(cap / 2));
  const bids = points.filter((point) => point.side === "bid").slice(0, perSide);
  const asks = points.filter((point) => point.side === "ask").slice(0, perSide);
  const merged = [...bids, ...asks];
  if (merged.length >= cap) return merged.slice(0, cap);
  const used = new Set(merged.map((point) => point.id));
  return [
    ...merged,
    ...points.filter((point) => !used.has(point.id)).slice(0, cap - merged.length)
  ];
}

function scorePoint(point: ReplayPoint, now: number) {
  const ageHours = Math.max(0, (now - point.lastSeen) / 3600000);
  const persistenceHours = Math.max(0.1, (point.lastSeen - point.firstSeen) / 3600000);
  return point.strength * (1 + Math.log1p(point.observations) * 0.2 + Math.min(0.45, persistenceHours * 0.03)) / (1 + ageHours / 96);
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function post(message: WorkerResponse) {
  ctx.postMessage(message);
}

export {};
