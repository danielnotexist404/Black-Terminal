import type { Candle } from "../../../chart-engine/types";
import type { AifAuctionNode, AifChobState, AifProvenance, AifTimelineEvent } from "../core/aifTypes";

type Interaction = { nodeId: string; state: AifChobState; firstTouch: number; lastTouch: number; rejectionScore: number; acceptanceScore: number; swingPrice: number | null; eventIds: Set<string> };

export function buildAifTimeline(candles: Candle[], nodes: AifAuctionNode[], horizon: number, minimumConfidence: number, provenance: AifProvenance): { events: AifTimelineEvent[]; activeState: AifChobState } {
  const source = candles.slice(-Math.max(20, horizon));
  const events: AifTimelineEvent[] = [];
  let activeState: AifChobState = "UNTESTED";
  for (const node of nodes.slice(0, 32)) {
    const interaction: Interaction = { nodeId: node.id, state: "UNTESTED", firstTouch: 0, lastTouch: 0, rejectionScore: 0, acceptanceScore: 0, swingPrice: null, eventIds: new Set() };
    let outsideBars = 0;
    let insideBars = 0;
    for (let index = 0; index < source.length; index += 1) {
      const candle = source[index];
      const touches = candle.high >= node.low && candle.low <= node.high;
      if (!touches) {
        outsideBars += 1;
        insideBars = 0;
        if (interaction.state === "FIRST_REJECTION" && outsideBars >= 2) {
          interaction.state = "INTERMEDIATE_SWING";
          interaction.swingPrice = candle.close;
        }
        continue;
      }
      insideBars += 1;
      outsideBars = 0;
      const eventKey = `${node.id}:${Math.floor(candle.time / 60)}`;
      if (interaction.eventIds.has(eventKey)) continue;
      interaction.eventIds.add(eventKey);
      node.touchCount += 1;
      node.tested = true;
      node.status = node.touchCount === 1 ? "first-test" : node.status;
      const width = Math.max(1e-12, node.high - node.low);
      const displacement = Math.abs(candle.close - node.center) / width;
      const closeOutside = candle.close < node.low || candle.close > node.high;
      interaction.rejectionScore = Math.min(100, displacement * 35 + (closeOutside ? 45 : 10) + Math.min(20, outsideBars * 4));
      interaction.acceptanceScore = Math.min(100, insideBars * 18 + (closeOutside ? 0 : 42));
      if (interaction.state === "UNTESTED") interaction.state = "FIRST_TEST";
      else if (interaction.state === "INTERMEDIATE_SWING") interaction.state = "RETEST";
      else if (interaction.state === "RETEST") interaction.state = "SECOND_REJECTION";
      if (interaction.rejectionScore >= minimumConfidence) {
        interaction.state = interaction.state === "SECOND_REJECTION" ? "CHOB_CANDIDATE" : "FIRST_REJECTION";
        node.status = "rejected";
        push(events, interaction, candle, node, interaction.state === "CHOB_CANDIDATE" ? "chob-candidate" : "node-rejected", interaction.rejectionScore);
      } else if (interaction.acceptanceScore >= minimumConfidence) {
        interaction.state = "ACCEPTED";
        node.status = "accepted";
        push(events, interaction, candle, node, "node-accepted", interaction.acceptanceScore);
      } else {
        push(events, interaction, candle, node, "node-tested", Math.max(interaction.rejectionScore, interaction.acceptanceScore));
      }
      if (interaction.state === "CHOB_CANDIDATE" && interaction.swingPrice != null) {
        const crossedSwing = candle.high >= interaction.swingPrice && candle.low <= interaction.swingPrice;
        if (crossedSwing) {
          interaction.state = "CHOB_CONFIRMED";
          push(events, interaction, candle, node, "chob-confirmed", Math.min(99, interaction.rejectionScore + 8));
        }
      }
      interaction.firstTouch ||= candle.time;
      interaction.lastTouch = candle.time;
    }
    if (interaction.state !== "UNTESTED") activeState = interaction.state;
  }
  events.unshift({ id: `profile:${source.at(-1)?.time ?? 0}`, time: source.at(-1)?.time ?? 0, type: "profile-calculated", price: source.at(-1)?.close ?? null, confidence: 100, source: "aif", details: { bars: candles.length }, provenance });
  return { events: events.sort((a, b) => a.time - b.time).slice(-200), activeState };
}

function push(events: AifTimelineEvent[], interaction: Interaction, candle: Candle, node: AifAuctionNode, type: AifTimelineEvent["type"], confidence: number) {
  events.push({ id: `${type}:${node.id}:${candle.time}`, time: candle.time, type, price: candle.close, confidence: Math.round(confidence), source: node.profileType, direction: candle.close > node.center ? "bullish" : "bearish", experimental: type === "chob-candidate" || type === "chob-confirmed", nodeId: node.id, details: { nodeType: node.nodeType, state: interaction.state, touch: node.touchCount }, provenance: node.provenance });
}
