import { useState } from "react";
import { AlertTriangle, Cloud, X } from "lucide-react";
import { investmentGroupsApi, makeIdempotencyKey } from "../../modules/investment-groups/investmentGroupsApi";

type UnifiedGroupExecutionTicketProps = {
  groupId: string;
  groupName: string;
  groupMaximumLeverage: number;
  onClose: () => void;
  onSubmitted: (message: string) => void;
};

export function UnifiedGroupExecutionTicket({ groupId, groupName, groupMaximumLeverage, onClose, onSubmitted }: UnifiedGroupExecutionTicketProps) {
  const [clientIntentId] = useState(() => makeIdempotencyKey("group-intent"));
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [marketType, setMarketType] = useState<"SPOT" | "PERPETUAL" | "FUTURE" | "OPTION">("PERPETUAL");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "TWAP" | "ICEBERG">("MARKET");
  const [equityPercent, setEquityPercent] = useState(2);
  const [leverage, setLeverage] = useState(Math.min(2, groupMaximumLeverage));
  const [marginMode, setMarginMode] = useState<"CROSS" | "ISOLATED">("CROSS");
  const [positionIntent, setPositionIntent] = useState<"OPEN" | "REDUCE" | "CLOSE">("OPEN");
  const [limitPrice, setLimitPrice] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [maximumSlippageBps, setMaximumSlippageBps] = useState(50);
  const [strategyDurationSeconds, setStrategyDurationSeconds] = useState(600);
  const [strategyIntervalSeconds, setStrategyIntervalSeconds] = useState(30);
  const [icebergOrderCount, setIcebergOrderCount] = useState(5);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const normalizedSymbol = symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      if (normalizedSymbol.length < 2) throw new Error("Enter a valid market symbol.");
      if (!Number.isFinite(equityPercent) || equityPercent <= 0 || equityPercent > 100) throw new Error("Equity allocation must be between 0 and 100%.");
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > groupMaximumLeverage) throw new Error(`Requested leverage cannot exceed the group cap of ${groupMaximumLeverage}x.`);
      if (orderType === "LIMIT" && Number(limitPrice) <= 0) throw new Error("A positive limit price is required for a limit intent.");
      if (!Number.isFinite(maximumSlippageBps) || maximumSlippageBps < 1 || maximumSlippageBps > 1000) throw new Error("Manager slippage must be between 1 and 1,000 bps.");
      if (orderType === "TWAP" && (strategyDurationSeconds < 300 || strategyDurationSeconds > 86400 || strategyDurationSeconds % strategyIntervalSeconds !== 0)) throw new Error("TWAP duration must be 300–86,400 seconds and divisible by its interval.");
      if (orderType === "ICEBERG" && (!Number.isInteger(icebergOrderCount) || icebergOrderCount < 2 || icebergOrderCount > 10000)) throw new Error("Iceberg order count must be an integer from 2 to 10,000.");
      const result = await investmentGroupsApi.submitGroupIntent({
        groupId,
        clientIntentId,
        symbol: normalizedSymbol,
        marketType,
        side,
        orderType,
        quantityModel: "EQUITY_PERCENT",
        quantityValue: equityPercent,
        leverage,
        marginMode,
        reduceOnly: positionIntent !== "OPEN",
        ...(orderType === "LIMIT" ? { limitPrice: Number(limitPrice) } : {}),
        ...(Number(takeProfit) > 0 ? { takeProfit: Number(takeProfit) } : {}),
        ...(Number(stopLoss) > 0 ? { stopLoss: Number(stopLoss) } : {}),
        ...(orderType === "TWAP" ? { strategyParameters: { durationSeconds: strategyDurationSeconds, intervalSeconds: strategyIntervalSeconds, randomize: false } } : {}),
        ...(orderType === "ICEBERG" ? { strategyParameters: { orderCount: icebergOrderCount, icebergPreference: "maker" as const } } : {}),
        maximumSlippageBps,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
      });
      onSubmitted(`GROUP INTENT ${result.intent.id.slice(0, 8).toUpperCase()} QUEUED FOR BLACK CLOUD.`);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Group intent submission failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="unified-ticket-overlay group-ticket-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="unified-ticket group-execution-ticket" role="dialog" aria-modal="true" aria-label="Unified Investment Group Execution Ticket">
        <header className="unified-ticket-head"><div><span>UNIFIED EXECUTION TICKET</span><strong>{groupName}</strong></div><button type="button" onClick={onClose}><X size={15} /></button></header>
        <div className="group-ticket-route"><Cloud size={15} /><span>GROUP INTENT</span><b>→</b><span>OMS / EMS</span><b>→</b><span>INDEPENDENT FOLLOWER PLANS</span><b>→</b><span>BLACK CLOUD</span></div>
        <div className="unified-ticket-grid">
          <label><span>Symbol</span><input value={symbol} onChange={(event) => setSymbol(event.target.value)} /></label>
          <label><span>Market</span><select value={marketType} onChange={(event) => setMarketType(event.target.value as typeof marketType)}><option>PERPETUAL</option><option>SPOT</option></select></label>
          <label><span>Side</span><select value={side} onChange={(event) => setSide(event.target.value as typeof side)}><option value="buy">BUY / LONG</option><option value="sell">SELL / SHORT</option></select></label>
          <label><span>Position intent</span><select value={positionIntent} onChange={(event) => setPositionIntent(event.target.value as typeof positionIntent)}><option>OPEN</option><option>REDUCE</option><option>CLOSE</option></select></label>
          <label><span>Order type</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}><option>MARKET</option><option>LIMIT</option><option>TWAP</option><option>ICEBERG</option></select></label>
          <label><span>Follower equity %</span><input type="number" min="0.01" max="100" step="0.01" value={equityPercent} onChange={(event) => setEquityPercent(Number(event.target.value))} /></label>
          <label><span>Requested leverage</span><input type="number" min="1" max={groupMaximumLeverage} step="0.1" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} /></label>
          <label><span>Margin mode</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as typeof marginMode)}><option>CROSS</option><option>ISOLATED</option></select></label>
          {orderType === "LIMIT" && <label><span>Limit price</span><input type="number" min="0" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} /></label>}
          {orderType === "TWAP" && <><label><span>TWAP duration (seconds)</span><input type="number" min="300" max="86400" value={strategyDurationSeconds} onChange={(event) => setStrategyDurationSeconds(Number(event.target.value))} /></label><label><span>TWAP interval</span><select value={strategyIntervalSeconds} onChange={(event) => setStrategyIntervalSeconds(Number(event.target.value))}><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option><option value="120">120 seconds</option></select></label></>}
          {orderType === "ICEBERG" && <label><span>Iceberg order count</span><input type="number" min="2" max="10000" step="1" value={icebergOrderCount} onChange={(event) => setIcebergOrderCount(Number(event.target.value))} /></label>}
          <label><span>Take profit (optional)</span><input type="number" min="0" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} /></label>
          <label><span>Stop loss (optional)</span><input type="number" min="0" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} /></label>
          <label><span>Manager slippage cap (bps)</span><input type="number" min="1" max="1000" step="1" value={maximumSlippageBps} onChange={(event) => setMaximumSlippageBps(Number(event.target.value))} /></label>
        </div>
        <div className="group-ticket-policy"><AlertTriangle size={15} /><p>Each active member is independently revalidated by OMS/EMS. The lower of manager request, member cap, group cap, EMS cap and instrument cap wins. Per-member slippage caps remain mandatory. This ticket never sends browser-side orders or grants withdrawal authority.</p></div>
        <label className="group-ticket-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm this creates one signed group intent and independent server-side follower plans.</span></label>
        {error && <p className="group-ticket-error">{error}</p>}
        <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!confirmed || busy} onClick={() => void submit()}>{busy ? "QUEUEING…" : "QUEUE GROUP INTENT"}</button></footer>
      </section>
    </div>
  );
}
