import { useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { blackCoreConnectionManager } from "../../connectivity/connectionManager";
import { readActiveExecutionVenueId } from "../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../connectivity/types";
import type { PortfolioAccount } from "../../portfolio/types";
import { setBybitTradingEnabledViaApi, syncExchangeAccountViaApi, type ExchangeAccountSyncPayload } from "../../portfolio/portfolioApiClient";
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
  const [status, setStatus] = useState("");
  const [mainnetValidation, setMainnetValidation] = useState(() => readMainnetValidationMode());
  const [accountSync, setAccountSync] = useState<ExchangeAccountSyncPayload | null>(null);
  const [accountSyncError, setAccountSyncError] = useState("");
  const [accountActionPending, setAccountActionPending] = useState(false);

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
        }
      } catch (error) {
        if (active) setAccountSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [preset.symbol, selectedConnection?.accountId, selectedConnection?.provider]);

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
    const next: ExecutionDestination[] = [];
    if (personalDestination) next.push("personal-portfolio");
    if (allocationDestination) next.push("allocation-engine");
    return next;
  }, [personalDestination, allocationDestination]);

  const venueOrderTypes = useMemo<OrderType[]>(() => {
    if (selectedConnection?.provider === "bybit") return ["market", "limit"];
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
  const estimatedMargin = (preset.marketKind ?? "perpetual") === "spot"
    ? estimatedNotional
    : estimatedNotional / Math.max(1, leverage);
  const estimatedFees = estimatedNotional * 0.0006;
  const estimatedCollateral = estimatedMargin + estimatedFees;
  const remainingBalance = availableBalance - estimatedCollateral;
  const exceedsAvailableBalance = Boolean(accountMetrics && !reduceOnly && estimatedCollateral > availableBalance);
  const bybitTradingEnabled = selectedConnection?.provider === "bybit" && selectedConnection.health.permissions.trading === true;

  function applyBalancePercent(percent: number) {
    if (!accountMetrics || availableBalance <= 0 || executionPrice <= 0) return;
    const collateral = availableBalance * percent;
    const value = (preset.marketKind ?? "perpetual") === "spot" ? collateral : collateral * Math.max(1, leverage);
    const next = sizingMethod === "usd" ? value : value / executionPrice;
    setQuantity(String(Number(next.toFixed(sizingMethod === "usd" ? 2 : 8))));
  }

  async function toggleBybitTrading(enable: boolean) {
    if (!selectedConnection?.accountId || selectedConnection.provider !== "bybit") return;
    const phrase = enable ? "ENABLE BYBIT LIVE VALIDATION" : "DISABLE BYBIT LIVE VALIDATION";
    const confirmation = window.prompt(`${enable ? "ENABLE" : "DISABLE"} LIVE BYBIT TRADING\n\nType exactly: ${phrase}`);
    if (confirmation !== phrase) {
      setStatus("CONFIRMATION PHRASE DID NOT MATCH");
      return;
    }

    setAccountActionPending(true);
    try {
      const result = await setBybitTradingEnabledViaApi(selectedConnection.accountId, enable, confirmation);
      if (!result) throw new Error("Authenticated account session is required.");
      const connection = blackCoreConnectionManager.getConnection(selectedConnection.id);
      if (connection) {
        blackCoreConnectionManager.upsertExternalConnection({
          ...connection,
          health: {
            ...connection.health,
            permissions: { ...connection.health.permissions, trading: enable }
          },
          metadata: {
            ...connection.metadata,
            network: "mainnet",
            executionMode: enable ? "full-live" : "read-only",
            readiness: enable ? "execution-ready" : "connected-read-only"
          }
        });
      }
      setStatus(enable ? "BYBIT TRADING ENABLED. ENABLE LIVE MODE FOR THIS SESSION." : "BYBIT TRADING DISABLED");
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    } finally {
      setAccountActionPending(false);
    }
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
    if (destinations.length === 0) {
      setStatus("SELECT AT LEAST ONE EXECUTION DESTINATION");
      return;
    }

    try {
      const draft = {
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

        {selectedConnection?.provider === "bybit" && (
          <div className="unified-account-state">
            <div><span>Unified Equity</span><b>{accountMetrics ? formatUsd(accountMetrics.equityUsd) : "SYNCING"}</b></div>
            <div><span>Available Balance</span><b className="positive">{accountMetrics ? formatUsd(availableBalance) : "SYNCING"}</b></div>
            <div><span>Initial Margin</span><b>{accountMetrics ? formatUsd(accountMetrics.initialMarginUsd) : "--"}</b></div>
            <div><span>Account</span><b>{accountMetrics?.accountType || "UNIFIED"}</b></div>
            {accountSyncError && <p>{accountSyncError}</p>}
          </div>
        )}

        <div className="unified-destination-panel">
          <span>Execution Destination</span>
          <label><input type="checkbox" checked={personalDestination} onChange={(event) => setPersonalDestination(event.target.checked)} /> Personal Portfolio</label>
          <label><input type="checkbox" checked={allocationDestination} onChange={(event) => setAllocationDestination(event.target.checked)} /> Allocation Engine</label>
        </div>

        {mainnetReadiness.mainnet && (
          <div className={mainnetValidation.enabled ? "mainnet-validation-panel active" : "mainnet-validation-panel"}>
            <div>
              <span>Live Mainnet Validation</span>
              <b>{mainnetValidation.enabled ? "ENABLED" : "OFF"}</b>
            </div>
            <p>{selectedConnection?.provider === "bybit" ? "Real Bybit orders require venue trading permission, account activation, this session opt-in, available collateral, and risk approval." : "Real Hyperliquid mainnet orders require this session opt-in plus relay readiness, trading permission, and risk approval."}</p>
            {selectedConnection?.provider === "bybit" && (
              <button type="button" disabled={accountActionPending} onClick={() => void toggleBybitTrading(!bybitTradingEnabled)}>
                {bybitTradingEnabled ? "Disable Bybit Trading" : "Enable Bybit Trading"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setMainnetValidation(mainnetValidation.enabled ? disableMainnetValidationMode() : promptEnableMainnetValidationMode())}
            >
              {mainnetValidation.enabled ? "Disable Live Mode" : "Enable Live Mode"}
            </button>
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

        {selectedConnection?.provider === "bybit" && (
          <div className={exceedsAvailableBalance ? "unified-order-estimate blocked" : "unified-order-estimate"}>
            <div><span>Order Value</span><b>{formatUsd(estimatedNotional)}</b></div>
            <div><span>Required Margin</span><b>{formatUsd(estimatedMargin)}</b></div>
            <div><span>Est. Fees</span><b>{formatUsd(estimatedFees)}</b></div>
            <div><span>Balance After</span><b>{accountMetrics ? formatUsd(remainingBalance) : "--"}</b></div>
            <div className="unified-balance-presets">
              {[0.25, 0.5, 0.75, 1].map((percent) => <button type="button" key={percent} onClick={() => applyBalancePercent(percent)}>{percent * 100}%</button>)}
            </div>
          </div>
        )}

        <div className="unified-trailing-panel">
          <label><input type="checkbox" checked={trailingStopEnabled} onChange={(event) => setTrailingStopEnabled(event.target.checked)} /> Enable Trailing Stop</label>
          <label><span>Trail By</span><input value={trailingTrailBy} onChange={(event) => setTrailingTrailBy(event.target.value)} inputMode="decimal" /></label>
          <label><span>Mode</span><select value={trailingMode} onChange={(event) => setTrailingMode(event.target.value as typeof trailingMode)}><option value="percentage">Percentage</option><option value="usd">USD</option><option value="ticks">Ticks</option><option value="atr">ATR Future</option></select></label>
          <label><span>Activation</span><select value={trailingActivation} onChange={(event) => setTrailingActivation(event.target.value as typeof trailingActivation)}><option value="immediate">Immediate</option><option value="custom-price">Custom Price</option><option value="offset">Offset</option></select></label>
          <label><span>Activation Price</span><input value={trailingActivationPrice} onChange={(event) => setTrailingActivationPrice(event.target.value)} inputMode="decimal" /></label>
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

        <button type="button" disabled={exceedsAvailableBalance || accountActionPending} className={side === "buy" ? "execution-submit buy" : "execution-submit sell"} onClick={submit}>
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
