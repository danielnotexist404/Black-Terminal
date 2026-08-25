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

function empty(time: number): AuthenticFlowBarInput { return { time, buyVolume: 0, sellVolume: 0, unknownVolume: 0, buyNotional: 0, sellNotional: 0, unknownNotional: 0, exactTradeCount: 0, totalTradeCount: 0, deliveryComplete: false }; }
