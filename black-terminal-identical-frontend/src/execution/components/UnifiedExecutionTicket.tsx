import { useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { blackCoreConnectionManager } from "../../connectivity/connectionManager";
import { readActiveExecutionVenueId } from "../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../connectivity/types";
import type { PortfolioAccount } from "../../portfolio/types";
import { syncExchangeAccountViaApi, type ExchangeAccountSyncPayload } from "../../portfolio/portfolioApiClient";
import { defaultRiskControls } from "../../risk/types";
import { submitOrder } from "../executionEngine";
import { MAINNET_ORDER_CONFIRMATION, disableMainnetValidationMode, promptEnableMainnetValidationMode, readMainnetValidationMode, validateMainnetOrderReadiness } from "../mainnetValidationMode";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderSide, OrderType, SizingMethod, TimeInForce } from "../types";
import type { ExchangeId, MarketKind } from "../../market-data/types";
import { blackCorePositionManager } from "../../positions/positionManager";
import type { PositionProtectionType } from "../../positions/types";

export type UnifiedExecutionTicketPreset = {
  symbol: string;
  price?: number;
  side?: OrderSide;
  orderType?: OrderType;
  source: ExecutionSource;
  allocationEnabled?: boolean;
  marketKind?: MarketKind;
  quantity?: string;
  stopPrice?: string;
  takeProfit?: string;
  stopLoss?: string;
  reduceOnly?: boolean;
  positionId?: string;
  protectionIntent?: PositionProtectionType;
  trailingStopEnabled?: boolean;
  trailingTrailBy?: string;
  trailingMode?: "percentage" | "usd" | "ticks" | "atr";
  trailingActivation?: "immediate" | "custom-price" | "offset";
  trailingActivationPrice?: string;
};

type UnifiedExecutionTicketProps = {
  preset: UnifiedExecutionTicketPreset;
  onClose: () => void;
};

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
  const activeVenueId = readActiveExecutionVenueId();
  const defaultConnection = activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  const [connectionId, setConnectionId] = useState(defaultConnection?.id ?? "");
  const selectedConnection = activeConnections.find((connection) => connection.id === connectionId) ?? defaultConnection;
  const isBybit = selectedConnection?.provider === "bybit";
  const [marketKind, setMarketKind] = useState<MarketKind>(preset.marketKind ?? "perpetual");
  const [side, setSide] = useState<OrderSide>(preset.side ?? "buy");
  const [orderType, setOrderType] = useState<OrderType>(preset.orderType ?? "market");
  const [quantity, setQuantity] = useState(preset.quantity ?? "");
  const [sizingMethod, setSizingMethod] = useState<SizingMethod>("quantity");
  const [price, setPrice] = useState(preset.price ? String(Number(preset.price.toFixed(2))) : "");
  const [stopPrice, setStopPrice] = useState(preset.stopPrice ?? "");
  const [takeProfit, setTakeProfit] = useState(preset.takeProfit ?? "");
  const [stopLoss, setStopLoss] = useState(preset.stopLoss ?? "");
  const [trailingStopEnabled, setTrailingStopEnabled] = useState(Boolean(preset.trailingStopEnabled));
  const [trailingTrailBy, setTrailingTrailBy] = useState(preset.trailingTrailBy ?? "");
  const [trailingMode, setTrailingMode] = useState<"percentage" | "usd" | "ticks" | "atr">(preset.trailingMode ?? "usd");
  const [trailingActivation, setTrailingActivation] = useState<"immediate" | "custom-price" | "offset">(preset.trailingActivation ?? "immediate");
  const [trailingActivationPrice, setTrailingActivationPrice] = useState(preset.trailingActivationPrice ?? "");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [leverage, setLeverage] = useState(1);
  const [marginMode, setMarginMode] = useState<MarginMode>("cross");
  const [postOnly, setPostOnly] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(Boolean(preset.reduceOnly));
  const [personalDestination, setPersonalDestination] = useState(true);
  const [allocationDestination, setAllocationDestination] = useState(Boolean(preset.allocationEnabled));
  const [tpSlEnabled, setTpSlEnabled] = useState(Boolean(preset.takeProfit || preset.stopLoss));
  const [balancePercent, setBalancePercent] = useState(0);
  const [status, setStatus] = useState("");
  const [mainnetValidation, setMainnetValidation] = useState(() => readMainnetValidationMode());
  const [accountSync, setAccountSync] = useState<ExchangeAccountSyncPayload | null>(null);
  const [accountSyncError, setAccountSyncError] = useState("");

  useEffect(() => blackCoreConnectionManager.subscribe(setConnections), []);

  useEffect(() => {
    if (!selectedConnection?.accountId || selectedConnection.provider !== "bybit") {
      setAccountSync(null);
      setAccountSyncError("");
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const next = await syncExchangeAccountViaApi(selectedConnection.accountId!, preset.symbol);
        if (active) {
          setAccountSync(next);
          setAccountSyncError("");
          if (next?.executionState) {
            const connection = blackCoreConnectionManager.getConnection(selectedConnection.id);
            if (connection && connection.health.permissions.trading !== next.executionState.tradingEnabled) {
              blackCoreConnectionManager.upsertExternalConnection({
                ...connection,
                health: {
                  ...connection.health,
                  permissions: { ...connection.health.permissions, trading: next.executionState.tradingEnabled }
                },
                metadata: {
                  ...connection.metadata,
                  network: "mainnet",
                  executionMode: next.executionState.tradingEnabled ? "full-live" : "read-only",
                  readiness: next.executionState.tradingEnabled ? "execution-ready" : "execution-blocked",
                  readinessReason: next.executionState.readinessReason
                }
              });
            }
          }
        }
      } catch (error) {
        if (active) setAccountSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = window.setInterval(load, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [preset.symbol, selectedConnection?.accountId, selectedConnection?.id, selectedConnection?.provider]);

  const mainnetReadiness = useMemo(
    () => validateMainnetOrderReadiness(selectedConnection),
    [selectedConnection, mainnetValidation]
  );

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
    if (isBybit) return ["personal-portfolio"] as ExecutionDestination[];
    const next: ExecutionDestination[] = [];
    if (personalDestination) next.push("personal-portfolio");
    if (allocationDestination) next.push("allocation-engine");
    return next;
  }, [allocationDestination, isBybit, personalDestination]);

  const venueOrderTypes = useMemo<OrderType[]>(() => {
    if (selectedConnection?.provider === "bybit") return ["market", "limit", "stop-market", "stop-limit"];
    const supported = Array.isArray(selectedConnection?.metadata.supportedOrderTypes)
      ? selectedConnection.metadata.supportedOrderTypes.map(String)
      : [];
    const normalized = orderTypes.filter((type) => supported.includes(type));
    return normalized.length > 0 ? normalized : ["market", "limit"];
  }, [selectedConnection]);

  const venueSizingMethods = useMemo(() => {
    if (selectedConnection?.provider === "bybit") {
      return sizingMethods.filter((method) => ["usd", "quantity"].includes(method.value));
    }
    return sizingMethods.filter((method) => ["quantity", "usd"].includes(method.value));
  }, [selectedConnection]);

  useEffect(() => {
    if (!venueOrderTypes.includes(orderType)) setOrderType(venueOrderTypes[0]);
    if (!venueSizingMethods.some((method) => method.value === sizingMethod)) setSizingMethod(venueSizingMethods[0].value);
  }, [orderType, sizingMethod, venueOrderTypes, venueSizingMethods]);

  const accountMetrics = accountSync?.accountMetrics ?? null;
  const availableBalance = Number(accountMetrics?.availableBalanceUsd || 0);
  const executionPrice = Number(price || stopPrice || preset.price || 0);
  const requestedValue = Number(quantity || 0);
  const estimatedNotional = sizingMethod === "usd" ? requestedValue : requestedValue * executionPrice;
  const estimatedMargin = marketKind === "spot"
    ? estimatedNotional
    : estimatedNotional / Math.max(1, leverage);
  const estimatedFees = estimatedNotional * 0.0006;
  const estimatedCollateral = estimatedMargin + estimatedFees;
  const remainingBalance = availableBalance - estimatedCollateral;
  const exceedsAvailableBalance = Boolean(accountMetrics && !reduceOnly && estimatedCollateral > availableBalance);
  const serverMaxNotional = Number(accountSync?.executionState?.maxNotionalUsd || 0);
  const exceedsServerNotional = serverMaxNotional > 0 && estimatedNotional > serverMaxNotional;

  function applyBalancePercent(percent: number) {
    if (!accountMetrics || availableBalance <= 0 || executionPrice <= 0) return;
    const venueBuyingPower = marketKind === "spot" ? availableBalance : availableBalance * Math.max(1, leverage);
    const usableNotional = serverMaxNotional > 0 ? Math.min(venueBuyingPower, serverMaxNotional) : venueBuyingPower;
    const value = usableNotional * percent;
    const next = sizingMethod === "usd" ? value : value / executionPrice;
    setQuantity(String(Number(next.toFixed(sizingMethod === "usd" ? 2 : 8))));
    setBalancePercent(Math.round(percent * 100));
  }

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
    if (selectedConnection.category === "protocol" && selectedConnection.metadata.executionReady !== true) {
      setStatus(String(selectedConnection.metadata.readinessReason || "PROTOCOL RELAY IS NOT READY").toUpperCase());
      return;
    }
    const liveReadiness = validateMainnetOrderReadiness(selectedConnection);
    if (!liveReadiness.allowed) {
      setStatus((liveReadiness.reason || "MAINNET VALIDATION BLOCKED").toUpperCase());
      return;
    }
    if (!parsedQuantity || parsedQuantity <= 0) {
      setStatus("ENTER A VALID SIZE");
      return;
    }
    if (exceedsAvailableBalance) {
      setStatus(`INSUFFICIENT AVAILABLE BALANCE. REQUIRED ${estimatedCollateral.toFixed(2)} USD / AVAILABLE ${availableBalance.toFixed(2)} USD`);
      return;
    }
    if (exceedsServerNotional) {
      setStatus(`ORDER VALUE EXCEEDS THE ACCOUNT LIMIT OF ${formatUsd(serverMaxNotional)}`);
      return;
    }
    if (destinations.length === 0) {
      setStatus("SELECT AT LEAST ONE EXECUTION DESTINATION");
      return;
    }

    try {
      const draft = {
        accountId: selectedConnection.accountId,
        exchange: selectedConnection.provider as ExchangeId,
        symbol: preset.symbol.toUpperCase(),
        marketKind,
        side,
        orderType,
        quantity: parsedQuantity,
        quantityMode: sizingMethod,
        sizingMethod,
        referencePrice: Number(price || stopPrice || 0) || undefined,
        limitPrice: ["limit", "stop-limit", "bracket", "twap", "iceberg"].includes(orderType) ? Number(price || 0) || undefined : undefined,
        stopPrice: ["stop-market", "stop-limit", "trailing-stop"].includes(orderType) ? Number(stopPrice || price || 0) || undefined : undefined,
        takeProfit: tpSlEnabled ? Number(takeProfit || 0) || undefined : undefined,
        stopLoss: tpSlEnabled ? Number(stopLoss || 0) || undefined : undefined,
        leverage: marketKind === "spot" ? 1 : leverage,
        marginMode,
        postOnly: ["limit", "stop-limit"].includes(orderType) && postOnly,
        reduceOnly: marketKind !== "spot" && reduceOnly,
        timeInForce,
        trailingStopEnabled,
        trailingTrailBy: Number(trailingTrailBy || 0) || undefined,
        trailingMode,
        trailingActivation,
        trailingActivationPrice: Number(trailingActivationPrice || 0) || undefined,
        mainnetConfirmed: liveReadiness.mainnet && liveReadiness.allowed,
        liveConfirmation: liveReadiness.mainnet && liveReadiness.allowed ? MAINNET_ORDER_CONFIRMATION : undefined,
        source: preset.source,
        destinations
      };
      const update = await submitOrder({
            accountId: draft.accountId,
            exchange: draft.exchange,
            symbol: draft.symbol,
            marketKind: draft.marketKind,
            side: draft.side,
            type: draft.orderType,
            quantity: draft.quantity,
            sizingMethod: draft.sizingMethod,
            limitPrice: draft.limitPrice,
            stopPrice: draft.stopPrice,
            referencePrice: draft.referencePrice,
            leverage: draft.leverage,
            marginMode: draft.marginMode,
            takeProfit: draft.takeProfit,
            stopLoss: draft.stopLoss,
            reduceOnly: draft.reduceOnly,
            postOnly: draft.postOnly,
            timeInForce: draft.timeInForce,
            source: draft.source,
            destinations: draft.destinations
          }, buildExecutionAccount(selectedConnection, accountSync), executionPrice || 1);
      if (preset.positionId && preset.protectionIntent) {
        if (preset.protectionIntent === "take-profit" && Number(takeProfit)) {
          blackCorePositionManager.setProtection(preset.positionId, "take-profit", { price: Number(takeProfit), metadata: { source: "unified-ticket" } });
        }
        if (preset.protectionIntent === "stop-loss" && Number(stopLoss || stopPrice)) {
          blackCorePositionManager.setProtection(preset.positionId, "stop-loss", { price: Number(stopLoss || stopPrice), metadata: { source: "unified-ticket" } });
        }
        if (preset.protectionIntent === "trailing-stop" && trailingStopEnabled) {
          blackCorePositionManager.enableTrailingStop(preset.positionId, {
            price: Number(stopPrice || trailingActivationPrice || 0) || undefined,
            trailBy: Number(trailingTrailBy || 0) || undefined,
            trailMode: trailingMode,
            activation: trailingActivation,
            activationPrice: Number(trailingActivationPrice || 0) || undefined,
            metadata: { source: "unified-ticket" }
          });
        }
      }
      setStatus(update ? `${update.status.toUpperCase()}: ${update.reason || update.orderId}` : "AUTHENTICATED BROKER SESSION REQUIRED");
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  return (
    <div className="unified-ticket-overlay" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className={isBybit ? "unified-ticket bybit-venue-ticket" : "unified-ticket"}>
        <div className="unified-ticket-head">
          {isBybit ? <b className="bybit-mark">BY</b> : <Play size={15} />}
          <span>{isBybit ? "Bybit Trade" : "Unified Execution Ticket"}</span>
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

        {isBybit ? (
          <div className="bybit-order-ticket">
            <div className="bybit-product-tabs" role="tablist" aria-label="Bybit product">
              <button type="button" className={marketKind === "spot" ? "active" : ""} onClick={() => setMarketKind("spot")}>Spot</button>
              <button type="button" className={marketKind === "perpetual" ? "active" : ""} onClick={() => setMarketKind("perpetual")}>Futures</button>
              <span>{accountMetrics?.accountType || "Unified"}</span>
            </div>

            <div className="bybit-symbol-row">
              <b>{formatBybitSymbol(preset.symbol)}</b>
              <strong>{executionPrice > 0 ? formatPrice(executionPrice) : "--"}</strong>
            </div>

            <div className="bybit-side-tabs">
              <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>{marketKind === "spot" ? "Buy" : "Long"}</button>
              <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>{marketKind === "spot" ? "Sell" : "Short"}</button>
            </div>

            <div className="bybit-order-tabs" role="tablist" aria-label="Bybit order type">
              <button type="button" className={orderType === "limit" ? "active" : ""} onClick={() => setOrderType("limit")}>Limit</button>
              <button type="button" className={orderType === "market" ? "active" : ""} onClick={() => setOrderType("market")}>Market</button>
              <button type="button" className={["stop-market", "stop-limit"].includes(orderType) ? "active" : ""} onClick={() => setOrderType("stop-market")}>Conditional</button>
            </div>

            <div className="bybit-balance-row">
              <span>Available Balance</span>
              <b>{accountMetrics ? `${formatVenueNumber(availableBalance)} USDT` : "Syncing"}</b>
            </div>

            {marketKind === "perpetual" && (
              <div className="bybit-position-settings">
                <label><span>Margin</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}><option value="cross">Cross</option><option value="isolated">Isolated</option></select></label>
                <label><span>Leverage</span><div className="bybit-suffix-input"><input value={leverage} min="1" onChange={(event) => setLeverage(Math.max(1, Number(event.target.value || 1)))} inputMode="numeric" /><b>x</b></div></label>
              </div>
            )}

            {["stop-market", "stop-limit"].includes(orderType) && (
              <div className="bybit-condition-row">
                <label><span>Trigger Price</span><div className="bybit-suffix-input"><input value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
                <label><span>Order</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)}><option value="stop-market">Market</option><option value="stop-limit">Limit</option></select></label>
              </div>
            )}

            {["limit", "stop-limit"].includes(orderType) && (
              <label><span>Price</span><div className="bybit-suffix-input"><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
            )}

            <label>
              <span>{sizingMethod === "usd" ? "Order Value" : "Quantity"}</span>
              <div className="bybit-split-input">
                <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setBalancePercent(0); }} inputMode="decimal" />
                <select value={sizingMethod} onChange={(event) => setSizingMethod(event.target.value as SizingMethod)}>
                  <option value="quantity">{baseAsset(preset.symbol)}</option>
                  <option value="usd">USDT</option>
                </select>
              </div>
            </label>

            <div className="bybit-size-slider">
              <input type="range" min="0" max="100" step="1" value={balancePercent} onChange={(event) => applyBalancePercent(Number(event.target.value) / 100)} aria-label="Percent of available balance" />
              <div><span>0</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
            </div>

            <div className="bybit-order-summary">
              <span>Order Value <b>{formatUsd(estimatedNotional)}</b></span>
              <span>Required Margin <b>{marketKind === "spot" ? "--" : formatUsd(estimatedMargin)}</b></span>
              <span>Available After <b className={remainingBalance < 0 ? "negative" : ""}>{accountMetrics ? formatUsd(remainingBalance) : "--"}</b></span>
            </div>

            <label className="bybit-check"><input type="checkbox" checked={tpSlEnabled} onChange={(event) => setTpSlEnabled(event.target.checked)} /> TP/SL</label>
            {tpSlEnabled && (
              <div className="bybit-tpsl-row">
                <label><span>Take Profit</span><div className="bybit-suffix-input"><input value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
                <label><span>Stop Loss</span><div className="bybit-suffix-input"><input value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
              </div>
            )}

            <div className="bybit-order-options">
              <label className="bybit-check"><input type="checkbox" disabled={!["limit", "stop-limit"].includes(orderType)} checked={postOnly && ["limit", "stop-limit"].includes(orderType)} onChange={(event) => setPostOnly(event.target.checked)} /> Post-Only</label>
              {marketKind === "perpetual" && <label className="bybit-check"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce-Only</label>}
              {["limit", "stop-limit"].includes(orderType) && <select aria-label="Time in force" value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}><option value="gtc">GTC</option><option value="ioc">IOC</option><option value="fok">FOK</option></select>}
            </div>

            {(status || accountSyncError || accountSync?.executionState?.readinessReason || exceedsServerNotional) && (
              <div className="bybit-ticket-status">{status || accountSyncError || accountSync?.executionState?.readinessReason || `Order value exceeds the account limit of ${formatUsd(serverMaxNotional)}.`}</div>
            )}

            <button
              type="button"
              disabled={exceedsAvailableBalance || exceedsServerNotional || !accountMetrics || selectedConnection.health.permissions.trading !== true}
              className={side === "buy" ? "bybit-submit buy" : "bybit-submit sell"}
              onClick={submit}
            >
              {marketKind === "spot" ? `${side === "buy" ? "Buy" : "Sell"} ${baseAsset(preset.symbol)}` : side === "buy" ? "Open Long" : "Open Short"}
            </button>
          </div>
        ) : (
          <>
            <div className="unified-destination-panel">
              <span>Execution Destination</span>
              <label><input type="checkbox" checked={personalDestination} onChange={(event) => setPersonalDestination(event.target.checked)} /> Personal Portfolio</label>
              <label><input type="checkbox" checked={allocationDestination} onChange={(event) => setAllocationDestination(event.target.checked)} /> Allocation Engine</label>
            </div>

            {mainnetReadiness.mainnet && (
              <div className={mainnetValidation.enabled ? "mainnet-validation-panel active" : "mainnet-validation-panel"}>
                <div><span>Live Mainnet Validation</span><b>{mainnetValidation.enabled ? "ENABLED" : "OFF"}</b></div>
                <p>Real protocol orders require session opt-in, relay readiness, trading permission, and risk approval.</p>
                <button type="button" onClick={() => setMainnetValidation(mainnetValidation.enabled ? disableMainnetValidationMode() : promptEnableMainnetValidationMode())}>{mainnetValidation.enabled ? "Disable Live Mode" : "Enable Live Mode"}</button>
              </div>
            )}

            <div className="pm-segment">
              <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>Buy / Long</button>
              <button type="button" className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>Sell / Short</button>
            </div>
            <div className="unified-ticket-grid">
              <label><span>Symbol</span><input value={preset.symbol.toUpperCase()} readOnly /></label>
              <label><span>Order Type</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)}>{venueOrderTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label><span>Sizing</span><select value={sizingMethod} onChange={(event) => setSizingMethod(event.target.value as SizingMethod)}>{venueSizingMethods.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
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
              <div><span>Risk Status</span><b>{selectedConnection?.category === "wallet" ? "ROUTER REQUIRED" : selectedConnection?.category === "protocol" ? selectedConnection.metadata.executionReady === true ? "SERVER CHECK" : "RELAY BLOCKED" : "SERVER CHECK"}</b></div>
              <div><span>Execution Status</span><b>{status || "NOT SUBMITTED"}</b></div>
            </div>
            <button type="button" disabled={exceedsAvailableBalance} className={side === "buy" ? "execution-submit buy" : "execution-submit sell"} onClick={submit}>Submit Through EMS</button>
          </>
        )}
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

function buildExecutionAccount(connection: ConnectionDiagnostics, sync: ExchangeAccountSyncPayload | null): PortfolioAccount {
  const metrics = sync?.accountMetrics;
  const tradingEnabled = connection.health.permissions.trading === true;
  const storedControls = connection.metadata.accountRiskControls as PortfolioAccount["riskControls"] | undefined;
  const riskControls = {
    ...(storedControls || defaultRiskControls),
    readOnlyMode: !tradingEnabled,
    tradingEnabled
  };
  return {
    id: connection.accountId || connection.id,
    exchange: connection.provider as ExchangeId,
    label: connection.label,
    accountName: connection.label,
    permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
    isPaper: false,
    connectedAt: connection.createdAt,
    lastValidatedAt: connection.updatedAt,
    status: connection.status === "connected" ? "connected" : "degraded",
    apiHealth: connection.metadata.executionReady === true ? "healthy" : "warning",
    latencyMs: connection.health.latencyMs,
    balanceUsd: metrics?.walletBalanceUsd ?? 0,
    equityUsd: metrics?.equityUsd ?? 0,
    marginUsed: metrics?.initialMarginUsd ?? 0,
    availableMargin: metrics?.availableBalanceUsd ?? 0,
    buyingPower: (metrics?.availableBalanceUsd ?? 0) * Math.max(1, Number(storedControls?.maxLeverage || 1)),
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls
  };
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}

function formatVenueNumber(value: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number.isFinite(value) ? value : 0);
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number.isFinite(value) ? value : 0);
}

function baseAsset(symbol: string) {
  return String(symbol || "").toUpperCase().replace(/(?:USDT|USDC|USD|PERP)$/i, "") || "COIN";
}

function formatBybitSymbol(symbol: string) {
  const normalized = String(symbol || "").toUpperCase();
  const base = baseAsset(normalized);
  const quote = normalized.slice(base.length) || "USDT";
  return `${base}/${quote}`;
}
