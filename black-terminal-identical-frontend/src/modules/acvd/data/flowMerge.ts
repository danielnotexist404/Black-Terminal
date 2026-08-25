import type { AuthenticFlowBarInput } from "../core/types.ts";
import type { PersistentFlowSnapshot } from "./persistentFlowClient.ts";

export function mergePersistentAndLiveFlow(candleTimes: readonly number[], persistent: PersistentFlowSnapshot | null, live: readonly AuthenticFlowBarInput[] | undefined) {
  const archived = new Map((persistent?.bars ?? []).map((bar) => [bar.time, bar]));
  const session = new Map((live ?? []).map((bar) => [bar.time, bar]));
  return candleTimes.map((time) => {
    const historical = archived.get(time);
    if (historical?.deliveryComplete) return historical;
    const current = session.get(time);
    if (current?.deliveryComplete) return current;
    return historical ?? current ?? empty(time);
  });
}

export function authenticFlowRevision(bars: readonly AuthenticFlowBarInput[] | undefined) {
  if (!bars?.length) return "00000000";
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  let hash = 2166136261;
  const mix = (value: number) => {
    view.setFloat64(0, Number.isFinite(value) ? value : Number.NaN, true);
    for (let offset = 0; offset < 8; offset++) {
      hash ^= view.getUint8(offset);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const bar of bars) {
    mix(bar.time);
    mix(bar.buyNotional);
    mix(bar.sellNotional);
    mix(bar.exactTradeCount);
    mix(bar.totalTradeCount);
    hash ^= bar.deliveryComplete ? 1 : 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function empty(time: number): AuthenticFlowBarInput { return { time, buyVolume: 0, sellVolume: 0, unknownVolume: 0, buyNotional: 0, sellNotional: 0, unknownNotional: 0, exactTradeCount: 0, totalTradeCount: 0, deliveryComplete: false }; }
