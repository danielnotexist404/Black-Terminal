import { useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { blackCoreConnectionManager } from "../../connectivity/connectionManager";
import type { ConnectionDiagnostics } from "../../connectivity/types";
import { submitPortfolioOrderViaApi } from "../../portfolio/portfolioApiClient";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderSide, OrderType, SizingMethod, TimeInForce } from "../types";
import type { ExchangeId, MarketKind } from "../../market-data/types";

export type UnifiedExecutionTicketPreset = {
  symbol: string;
  price?: number;
  side?: OrderSide;
  orderType?: OrderType;
  source: ExecutionSource;
  allocationEnabled?: boolean;
  marketKind?: MarketKind;
};

type UnifiedExecutionTicketProps = {
  preset: UnifiedExecutionTicketPreset;
  onClose: () => void;
};

const activeExecutionVenueStorageKey = "bt_active_execution_venue_v1";

const orderTypes: OrderType[] = ["market", "limit", "stop-market", "stop-limit", "trailing-stop", "bracket", "twap", "iceberg"];
const sizingMethods: Array<{ value: SizingMethod; label: string }> = [
  { value: "quantity", label: "Quantity" },
  { value: "contracts", label: "Contracts" },
  { value: "coin", label: "Coin Amount" },
  { value: "usd", label: "USD Value" },
  { value: "portfolioPct", label: "Portfolio %" },
  { value: "equityPct", label: "Equity %" },
  { value: "riskPct", label: "Risk %" },
  { value: "fixedDollarRisk", label: "Fixed Dollar Risk" }
];

export function UnifiedExecutionTicket({ preset, onClose }: UnifiedExecutionTicketProps) {
  const [connections, setConnections] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const activeConnections = useMemo(() => connections.filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status)), [connections]);
  const activeVenueId = typeof window === "undefined" ? null : localStorage.getItem(activeExecutionVenueStorageKey);
  const defaultConnection = activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  const [connectionId, setConnectionId] = useState(defaultConnection?.id ?? "");
  const selectedConnection = activeConnections.find((connection) => connection.id === connectionId) ?? defaultConnection;
  const [side, setSide] = useState<OrderSide>(preset.side ?? "buy");
  const [orderType, setOrderType] = useState<OrderType>(preset.orderType ?? "market");
  const [quantity, setQuantity] = useState("");
  const [sizingMethod, setSizingMethod] = useState<SizingMethod>("quantity");
  const [price, setPrice] = useState(preset.price ? String(Number(preset.price.toFixed(2))) : "");
  const [stopPrice, setStopPrice] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [leverage, setLeverage] = useState(1);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [postOnly, setPostOnly] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [personalDestination, setPersonalDestination] = useState(true);
  const [allocationDestination, setAllocationDestination] = useState(Boolean(preset.allocationEnabled));
  const [status, setStatus] = useState("");

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    if (activeConnections.length === 0) {
      setConnectionId("");
      return;
    }
    if (!connectionId || !activeConnections.some((connection) => connection.id === connectionId)) {
      setConnectionId(defaultConnection?.id ?? activeConnections[0].id);
    }
  }, [activeConnections, connectionId, defaultConnection]);

  const destinations = useMemo(() => {
    const next: ExecutionDestination[] = [];
    if (personalDestination) next.push("personal-portfolio");
    if (allocationDestination) next.push("allocation-engine");
    return next;
  }, [personalDestination, allocationDestination]);

  async function submit() {
    setStatus("");
    const parsedQuantity = Number(quantity);
    if (!selectedConnection) {
      setStatus("CONNECT AN ACCOUNT IN POSITIONS FIRST");
      return;
    }
    if (selectedConnection.category === "wallet") {
      const reason = typeof selectedConnection.metadata.futuresUnsupportedReason === "string"
        ? selectedConnection.metadata.futuresUnsupportedReason
        : "Wallet is connected, but no executable DEX routing adapter is configured for this protocol yet.";
      setStatus(reason.toUpperCase());
      return;
    }
    if (!selectedConnection.accountId) {
      setStatus("CONNECTED VENUE HAS NO BROKER ACCOUNT ID");
      return;
    }
    if (!parsedQuantity || parsedQuantity <= 0) {
      setStatus("ENTER A VALID SIZE");
      return;
    }
    if (destinations.length === 0) {
      setStatus("SELECT AT LEAST ONE EXECUTION DESTINATION");
      return;
    }

    try {
      const update = await submitPortfolioOrderViaApi({
        accountId: selectedConnection.accountId,
        exchange: selectedConnection.provider as ExchangeId,
        symbol: preset.symbol.toUpperCase(),
        marketKind: preset.marketKind ?? "perpetual",
        side,
        orderType,
        quantity: parsedQuantity,
        quantityMode: sizingMethod,
        sizingMethod,
        referencePrice: Number(price || stopPrice || 0) || undefined,
        limitPrice: ["limit", "stop-limit", "bracket", "twap", "iceberg"].includes(orderType) ? Number(price || 0) || undefined : undefined,
        stopPrice: ["stop-market", "stop-limit", "trailing-stop"].includes(orderType) ? Number(stopPrice || price || 0) || undefined : undefined,
        takeProfit: Number(takeProfit || 0) || undefined,
        stopLoss: Number(stopLoss || 0) || undefined,
        leverage,
        marginMode,
        postOnly,
        reduceOnly,
        timeInForce,
        source: preset.source,
        destinations
      });
      setStatus(update ? `${update.status.toUpperCase()}: ${update.reason || update.orderId}` : "AUTHENTICATED BROKER SESSION REQUIRED");
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  return (
    <div className="unified-ticket-overlay" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className="unified-ticket">
        <div className="unified-ticket-head">
          <Play size={15} />
          <span>Unified Execution Ticket</span>
          <button type="button" onClick={onClose}><X size={14} /></button>
        </div>

        <label>
          <span>Account</span>
          <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            {activeConnections.length === 0 && <option value="">Connect account in Positions</option>}
            {activeConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{formatConnectionOption(connection)}</option>
            ))}
          </select>
        </label>

        <div className="unified-destination-panel">
          <span>Execution Destination</span>
          <label><input type="checkbox" checked={personalDestination} onChange={(event) => setPersonalDestination(event.target.checked)} /> Personal Portfolio</label>
          <label><input type="checkbox" checked={allocationDestination} onChange={(event) => setAllocationDestination(event.target.checked)} /> Allocation Engine</label>
        </div>

        <div className="pm-segment">
          <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>Buy / Long</button>
          <button type="button" className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>Sell / Short</button>
        </div>

        <div className="unified-ticket-grid">
          <label><span>Symbol</span><input value={preset.symbol.toUpperCase()} readOnly /></label>
          <label><span>Order Type</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)}>{orderTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
          <label><span>Sizing</span><select value={sizingMethod} onChange={(event) => setSizingMethod(event.target.value as SizingMethod)}>{sizingMethods.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label><span>Size</span><input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" /></label>
          <label><span>Limit / Ref Price</span><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /></label>
          <label><span>Stop Price</span><input value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} inputMode="decimal" /></label>
          <label><span>Take Profit</span><input value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" /></label>
          <label><span>Stop Loss</span><input value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" /></label>
          <label><span>Leverage</span><input value={leverage} onChange={(event) => setLeverage(Number(event.target.value || 1))} inputMode="numeric" /></label>
          <label><span>Margin Mode</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}><option value="cross">Cross</option><option value="isolated">Isolated</option></select></label>
          <label><span>TIF</span><select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}><option value="gtc">GTC</option><option value="ioc">IOC</option><option value="fok">FOK</option></select></label>
        </div>

        <div className="unified-ticket-checks">
          <label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce Only</label>
          <label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post Only</label>
        </div>

        <div className="unified-execution-matrix">
          <div><span>Validation Status</span><b>{selectedConnection && Number(quantity) > 0 ? "READY" : "PENDING"}</b></div>
          <div><span>Risk Status</span><b>{selectedConnection?.category === "wallet" ? "ROUTER REQUIRED" : "SERVER CHECK"}</b></div>
          <div><span>Execution Status</span><b>{status || "NOT SUBMITTED"}</b></div>
        </div>

        <button type="button" className={side === "buy" ? "execution-submit buy" : "execution-submit sell"} onClick={submit}>
          Submit Through EMS
        </button>
      </div>
    </div>
  );
}

function formatConnectionOption(connection: ConnectionDiagnostics) {
  const latency = `${connection.health.latencyMs}ms`;
  if (connection.category === "wallet") {
    const address = connection.walletAddress ? `${connection.walletAddress.slice(0, 6)}...${connection.walletAddress.slice(-4)}` : "wallet";
    return `${connection.label} / ${address} / ${connection.status.toUpperCase()} / ${latency}`;
  }
  return `${connection.label} / ${connection.provider.toUpperCase()} / ${connection.status.toUpperCase()} / ${latency}`;
}
