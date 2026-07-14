import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Play, X } from "lucide-react";
import { blackCoreConnectionManager } from "../../connectivity/connectionManager";
import { readActiveExecutionVenueId } from "../../connectivity/activeExecutionVenue";
import type { ConnectionDiagnostics } from "../../connectivity/types";
import type { PortfolioAccount } from "../../portfolio/types";
import { stopBybitStrategyViaApi, syncExchangeAccountViaApi, updateBybitAccountModeViaApi, type ExchangeAccountSyncPayload } from "../../portfolio/portfolioApiClient";
import { defaultRiskControls } from "../../risk/types";
import { submitOrder } from "../executionEngine";
import { MAINNET_ORDER_CONFIRMATION, validateMainnetOrderReadiness } from "../mainnetValidationMode";
import type { ExecutionDestination, ExecutionSource, MarginMode, OrderSide, OrderType, SizingMethod, TimeInForce, TriggerSource, VenueStrategyParameters } from "../types";
import type { ExchangeId, MarketKind } from "../../market-data/types";
import { blackCorePositionManager } from "../../positions/positionManager";
import type { PositionProtectionType } from "../../positions/types";
import { buildVenueExecutionSchema, calculateVenueOrderPreview, calculateVenueSizingCapacity, sizeFromEquityPercent, sizeFromPositionPercent, validateVenueOrderDraft } from "../venueExecutionSchema";

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

const orderTypes: OrderType[] = ["market", "limit", "stop-market", "stop-limit", "trailing-stop", "bracket", "chase-limit", "twap", "iceberg", "pov"];
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
  const activeConnections = useMemo(() => connections.filter((connection) =>
    ["centralized-exchange", "protocol"].includes(connection.category) &&
    !["disconnected", "offline", "unsupported"].includes(connection.status)
  ), [connections]);
  const activeVenueId = readActiveExecutionVenueId();
  const defaultConnection = activeConnections.find((connection) => connection.id === activeVenueId) ?? activeConnections[0] ?? null;
  const [connectionId, setConnectionId] = useState(defaultConnection?.id ?? "");
  const selectedConnection = activeConnections.find((connection) => connection.id === connectionId) ?? defaultConnection;
  const usesVenueNativeTicket = selectedConnection?.category === "centralized-exchange";
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
  const [accountSync, setAccountSync] = useState<ExchangeAccountSyncPayload | null>(null);
  const [accountSyncError, setAccountSyncError] = useState("");
  const [triggerBy, setTriggerBy] = useState<TriggerSource>("last");
  const [tpTriggerBy, setTpTriggerBy] = useState<TriggerSource>("last");
  const [slTriggerBy, setSlTriggerBy] = useState<TriggerSource>("mark");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [balancesVisible, setBalancesVisible] = useState(true);
  const [modeUpdatePending, setModeUpdatePending] = useState(false);
  const [slippageTolerance, setSlippageTolerance] = useState(0.5);
  const [strategyDurationSeconds, setStrategyDurationSeconds] = useState(1800);
  const [strategyIntervalSeconds, setStrategyIntervalSeconds] = useState(30);
  const [strategyRandomize, setStrategyRandomize] = useState(false);
  const [strategyTriggerPrice, setStrategyTriggerPrice] = useState("");
  const [strategyMaxChasePrice, setStrategyMaxChasePrice] = useState("");
  const [strategyChaseUnit, setStrategyChaseUnit] = useState<"distance" | "percent">("distance");
  const [strategyChaseValue, setStrategyChaseValue] = useState("0.5");
  const [strategySubSize, setStrategySubSize] = useState("");
  const [strategyOrderCount, setStrategyOrderCount] = useState(10);
  const [icebergPreference, setIcebergPreference] = useState<"maker" | "taker" | "offset" | "fixed">("maker");
  const [povMode, setPovMode] = useState<"TradedVolume" | "OppositeSideLiquidity" | "SameSideLiquidity">("TradedVolume");
  const [povParticipationRate, setPovParticipationRate] = useState(10);
  const [povReferenceWindow, setPovReferenceWindow] = useState(300);
  const [povDepthReference, setPovDepthReference] = useState(5);
  const [stoppingStrategyId, setStoppingStrategyId] = useState("");
  const hydratedAccountRef = useRef("");

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
        const next = await syncExchangeAccountViaApi(selectedConnection.accountId!, preset.symbol, marketKind);
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
  }, [marketKind, preset.symbol, selectedConnection?.accountId, selectedConnection?.id, selectedConnection?.provider]);

  const venueSchema = useMemo(() => selectedConnection
    ? buildVenueExecutionSchema({ connection: selectedConnection, product: marketKind, symbol: preset.symbol, sync: accountSync })
    : null,
  [accountSync, marketKind, preset.symbol, selectedConnection]);

  useEffect(() => {
    if (!venueSchema || !selectedConnection?.accountId) return;
    const key = `${selectedConnection.accountId}:${marketKind}:${preset.symbol}`;
    if (hydratedAccountRef.current === key) return;
    hydratedAccountRef.current = key;
    setLeverage(venueSchema.currentLeverage || venueSchema.instrumentRules.minLeverage || 1);
    setMarginMode(venueSchema.currentMarginMode);
  }, [marketKind, preset.symbol, selectedConnection?.accountId, venueSchema]);

  useEffect(() => {
    if (reduceOnly && tpSlEnabled) setTpSlEnabled(false);
    if (reduceOnly && sizingMethod !== "quantity") setSizingMethod("quantity");
  }, [reduceOnly, sizingMethod, tpSlEnabled]);

  const mainnetReadiness = useMemo(
    () => validateMainnetOrderReadiness(selectedConnection),
    [selectedConnection]
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
    if (usesVenueNativeTicket) return ["personal-portfolio"] as ExecutionDestination[];
    const next: ExecutionDestination[] = [];
    if (personalDestination) next.push("personal-portfolio");
    if (allocationDestination) next.push("allocation-engine");
    return next;
  }, [allocationDestination, personalDestination, usesVenueNativeTicket]);

  const venueOrderTypes = useMemo<OrderType[]>(() => {
    if (venueSchema) return venueSchema.supportedOrderModes.flatMap((mode) => mode.orderTypes);
    const supported = Array.isArray(selectedConnection?.metadata.supportedOrderTypes)
      ? selectedConnection.metadata.supportedOrderTypes.map(String)
      : [];
    const normalized = orderTypes.filter((type) => supported.includes(type));
    return normalized.length > 0 ? normalized : ["market", "limit"];
  }, [selectedConnection, venueSchema]);

  const venueSizingMethods = useMemo(() => {
    if (venueSchema) return sizingMethods.filter((method) => venueSchema.supportedSizingModes.includes(method.value));
    return sizingMethods.filter((method) => ["quantity", "usd"].includes(method.value));
  }, [venueSchema]);

  useEffect(() => {
    if (!venueOrderTypes.includes(orderType)) setOrderType(venueOrderTypes[0]);
    if (!venueSizingMethods.some((method) => method.value === sizingMethod)) setSizingMethod(venueSizingMethods[0].value);
  }, [orderType, sizingMethod, venueOrderTypes, venueSizingMethods]);

  const accountMetrics = venueSchema?.accountMetrics ?? accountSync?.accountMetrics ?? null;
  const strategyOrder = ["chase-limit", "twap", "iceberg", "pov"].includes(orderType);
  const strategyParameters: VenueStrategyParameters | undefined = strategyOrder ? {
    durationSeconds: ["twap", "pov"].includes(orderType) ? strategyDurationSeconds : undefined,
    intervalSeconds: ["twap", "pov"].includes(orderType) ? strategyIntervalSeconds : undefined,
    randomize: orderType === "twap" ? strategyRandomize : undefined,
    triggerPrice: Number(strategyTriggerPrice || 0) || undefined,
    maxChasePrice: Number(strategyMaxChasePrice || 0) || undefined,
    chaseDistance: (orderType === "chase-limit" || orderType === "iceberg" && icebergPreference === "offset") && strategyChaseUnit === "distance" ? Number(strategyChaseValue || 0) : undefined,
    chasePercent: (orderType === "chase-limit" || orderType === "iceberg" && icebergPreference === "offset") && strategyChaseUnit === "percent" ? Number(strategyChaseValue || 0) : undefined,
    subSize: orderType === "iceberg" ? Number(strategySubSize || 0) || undefined : undefined,
    orderCount: orderType === "iceberg" && !Number(strategySubSize || 0) ? strategyOrderCount : undefined,
    icebergPreference: orderType === "iceberg" ? icebergPreference : undefined,
    povMode: orderType === "pov" ? povMode : undefined,
    participationRate: orderType === "pov" ? povParticipationRate : undefined,
    referenceWindowSeconds: orderType === "pov" && povMode === "TradedVolume" ? povReferenceWindow : undefined,
    depthReference: orderType === "pov" && povMode !== "TradedVolume" ? povDepthReference : undefined
  } : undefined;
  const activeStrategies = (accountSync?.strategies || []).filter((strategy) => ["working", "pending", "paused"].includes(strategy.status));
  const availableBalance = Number(accountMetrics?.availableBalanceUsd || 0);
  const executionPrice = Number(price || stopPrice || preset.price || 0);
  const requestedValue = Number(quantity || 0);
  const sizingCapacity = venueSchema ? calculateVenueSizingCapacity({
    schema: venueSchema,
    percent: balancePercent / 100,
    referencePrice: executionPrice,
    leverage
  }) : null;
  const normalizedEquityQuantity = venueSchema && sizingMethod === "equityPct"
    ? sizeFromEquityPercent({ schema: venueSchema, percent: requestedValue / 100, referencePrice: executionPrice, leverage, sizingMethod: "quantity" })
    : requestedValue;
  const effectiveSizingMethod: SizingMethod = sizingMethod === "equityPct" ? "quantity" : sizingMethod;
  const effectiveSize = sizingMethod === "equityPct" ? normalizedEquityQuantity : requestedValue;
  const preview = venueSchema ? calculateVenueOrderPreview({
    schema: venueSchema,
    sizingMethod: effectiveSizingMethod,
    size: effectiveSize,
    referencePrice: executionPrice,
    leverage,
    side,
    stopLoss: Number(stopLoss || 0) || undefined,
    takeProfit: Number(takeProfit || 0) || undefined
  }) : null;
  const estimatedNotional = preview?.notional ?? (effectiveSizingMethod === "usd" ? effectiveSize : effectiveSize * executionPrice);
  const estimatedMargin = preview?.requiredMargin ?? estimatedNotional / Math.max(1, leverage);
  const estimatedFees = preview?.entryFee ?? estimatedNotional * 0.0006;
  const estimatedCollateral = estimatedMargin + estimatedFees;
  const remainingBalance = preview?.availableAfter ?? availableBalance - estimatedCollateral;
  const exceedsAvailableBalance = Boolean(accountMetrics && !reduceOnly && estimatedCollateral > availableBalance);
  const serverMaxNotional = Number(venueSchema?.maxOrderNotionalUsd || 0);
  const exceedsServerNotional = serverMaxNotional > 0 && estimatedNotional > serverMaxNotional;
  const instrumentBlockedByServerCap = Boolean(!reduceOnly && sizingCapacity?.blockedByServerCap);
  const orderValidation = venueSchema ? validateVenueOrderDraft({
    schema: venueSchema,
    orderType,
    sizingMethod: effectiveSizingMethod,
    size: effectiveSize,
    referencePrice: executionPrice,
    limitPrice: Number(price || 0) || undefined,
    triggerPrice: Number(stopPrice || 0) || undefined,
    leverage: marketKind === "spot" ? 1 : leverage,
    side,
    reduceOnly,
    tpSlEnabled: strategyOrder ? false : tpSlEnabled,
    strategyParameters
  }) : { valid: true, reasons: [], normalizedQuantity: effectiveSize, notional: estimatedNotional };
  const activeOrderMode = venueSchema?.supportedOrderModes.find((mode) => mode.orderTypes.includes(orderType)) || null;
  const ticketMessage = status || (accountSyncError ? formatExecutionError(accountSyncError) : "") ||
    (venueSchema && !venueSchema.executionReady ? venueSchema.readinessReason || "Trading is unavailable." : "") ||
    (instrumentBlockedByServerCap && sizingCapacity
      ? `Server order cap ${formatUsd(sizingCapacity.serverNotionalCap)} is below the ${venueSchema?.instrumentRules.symbol} executable minimum ${formatUsd(sizingCapacity.venueMinimumNotional)}.`
      : "") ||
    (requestedValue > 0 && !orderValidation.valid ? orderValidation.reasons[0] : "");

  function applyBalancePercent(percent: number) {
    if (!venueSchema || !accountMetrics || availableBalance <= 0 || executionPrice <= 0) return;
    const next = reduceOnly && accountSync?.selectedPosition
      ? sizeFromPositionPercent(venueSchema, accountSync.selectedPosition.quantity, percent)
      : sizingMethod === "equityPct"
      ? Number((percent * 100).toFixed(2))
      : sizeFromEquityPercent({ schema: venueSchema, percent, referencePrice: executionPrice, leverage, sizingMethod });
    setQuantity(String(next));
    setBalancePercent(Math.round(percent * 100));
  }

  async function applyVenueAccountSettings() {
    if (!venueSchema || !selectedConnection?.accountId || venueSchema.venue !== "bybit") return;
    const leverageChanged = venueSchema.featureFlags.showLeverage && Math.abs(leverage - venueSchema.currentLeverage) > 1e-8;
    const marginChanged = marginMode !== venueSchema.currentMarginMode;
    if (!leverageChanged && !marginChanged) return;
    const change = marginChanged
      ? `Change the Bybit Unified Account to ${marginMode} margin and set ${preset.symbol.toUpperCase()} leverage to ${leverage}x?`
      : `Set ${preset.symbol.toUpperCase()} leverage to ${leverage}x?`;
    if (!window.confirm(change)) return;

    setModeUpdatePending(true);
    setStatus("");
    try {
      if (marginChanged) {
        const result = await updateBybitAccountModeViaApi({
          accountId: selectedConnection.accountId,
          action: "switch-margin-mode",
          symbol: preset.symbol.toUpperCase(),
          category: "linear",
          marginMode,
          mainnetConfirmed: true,
          liveConfirmation: MAINNET_ORDER_CONFIRMATION
        });
        if (!result) throw new Error("Authenticated account session required.");
      }
      if (leverageChanged) {
        const result = await updateBybitAccountModeViaApi({
          accountId: selectedConnection.accountId,
          action: "set-leverage",
          symbol: preset.symbol.toUpperCase(),
          category: "linear",
          leverage,
          mainnetConfirmed: true,
          liveConfirmation: MAINNET_ORDER_CONFIRMATION
        });
        if (!result) throw new Error("Authenticated account session required.");
      }
      const next = await syncExchangeAccountViaApi(selectedConnection.accountId, preset.symbol, marketKind);
      setAccountSync(next);
      hydratedAccountRef.current = "";
      setStatus("Account settings updated by Bybit.");
    } catch (error) {
      setStatus(formatExecutionError(error));
      const next = await syncExchangeAccountViaApi(selectedConnection.accountId, preset.symbol, marketKind).catch(() => null);
      if (next) setAccountSync(next);
    } finally {
      setModeUpdatePending(false);
    }
  }

  async function submit() {
    setStatus("");
    const parsedQuantity = Number(effectiveSize);
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
      setStatus("Enter a valid order size.");
      return;
    }
    if (!orderValidation.valid) {
      setStatus(orderValidation.reasons[0]);
      return;
    }
    if (exceedsAvailableBalance) {
      setStatus(`Insufficient available margin. Required ${estimatedCollateral.toFixed(2)} USD; available ${availableBalance.toFixed(2)} USD.`);
      return;
    }
    if (exceedsServerNotional) {
      setStatus(`Order value exceeds the account limit of ${formatUsd(serverMaxNotional)}.`);
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
        quantity: effectiveSizingMethod === "usd" ? parsedQuantity : orderValidation.normalizedQuantity,
        quantityMode: effectiveSizingMethod,
        sizingMethod: effectiveSizingMethod,
        referencePrice: Number(price || stopPrice || 0) || undefined,
        limitPrice: ["limit", "stop-limit", "bracket"].includes(orderType) || orderType === "iceberg" && icebergPreference === "fixed" ? Number(price || 0) || undefined : undefined,
        stopPrice: ["stop-market", "stop-limit", "trailing-stop"].includes(orderType) ? Number(stopPrice || price || 0) || undefined : undefined,
        takeProfit: !strategyOrder && tpSlEnabled ? Number(takeProfit || 0) || undefined : undefined,
        stopLoss: !strategyOrder && tpSlEnabled ? Number(stopLoss || 0) || undefined : undefined,
        leverage: marketKind === "spot" ? 1 : leverage,
        marginMode,
        postOnly: ["limit", "stop-limit"].includes(orderType) && postOnly,
        reduceOnly: marketKind !== "spot" && reduceOnly,
        timeInForce,
        triggerBy,
        tpTriggerBy,
        slTriggerBy,
        tpslMode: "full" as const,
        positionIdx: venueSchema?.currentPositionMode === "hedge" ? side === "buy" ? 1 : 2 : 0,
        slippageTolerancePercent: orderType === "market" ? slippageTolerance : undefined,
        strategyParameters,
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
            triggerBy: draft.triggerBy,
            tpTriggerBy: draft.tpTriggerBy,
            slTriggerBy: draft.slTriggerBy,
            tpslMode: draft.tpslMode,
            positionIdx: draft.positionIdx,
            slippageTolerancePercent: draft.slippageTolerancePercent,
            strategyParameters: draft.strategyParameters,
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
      setStatus(update ? update.reason ? formatExecutionError(update.reason) : `${formatOrderStatus(update.status)}: ${update.orderId}` : "Authenticated broker session required.");
    } catch (error) {
      setStatus(formatExecutionError(error));
    }
  }

  async function stopStrategy(strategyId: string) {
    if (!selectedConnection?.accountId || !window.confirm(`Stop Bybit strategy ${strategyId}? Remaining child orders will be cancelled by Bybit.`)) return;
    setStoppingStrategyId(strategyId);
    setStatus("");
    try {
      await stopBybitStrategyViaApi({
        accountId: selectedConnection.accountId,
        strategyId,
        symbol: preset.symbol.toUpperCase(),
        mainnetConfirmed: true,
        liveConfirmation: MAINNET_ORDER_CONFIRMATION
      });
      setStatus("Bybit strategy stop accepted.");
      const next = await syncExchangeAccountViaApi(selectedConnection.accountId, preset.symbol, marketKind);
      if (next) setAccountSync(next);
    } catch (error) {
      setStatus(formatExecutionError(error));
    } finally {
      setStoppingStrategyId("");
    }
  }

  return (
    <div className="unified-ticket-overlay" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className={usesVenueNativeTicket ? "unified-ticket bybit-venue-ticket" : "unified-ticket"}>
        <div className="unified-ticket-head">
          {usesVenueNativeTicket ? <b className="bybit-mark">{String(venueSchema?.venueLabel || "EX").slice(0, 2).toUpperCase()}</b> : <Play size={15} />}
          <span>Unified Execution Ticket</span>
          <button type="button" onClick={onClose}><X size={14} /></button>
        </div>

        <label>
          <span>Account</span>
          <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            {activeConnections.length === 0 && <option value="">Connect account in Positions</option>}
            {activeConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{formatConnectionOption(connection, connection.id === selectedConnection?.id ? accountSync : null)}</option>
            ))}
          </select>
        </label>

        {usesVenueNativeTicket && venueSchema ? (
          <div className="bybit-order-ticket">
            <div className="venue-ticket-summary">
              <div><span>Venue</span><b>{venueSchema.venueLabel.toUpperCase()}</b></div>
              <div><span>Product</span><b>{venueSchema.instrumentRules.symbol} {venueSchema.marketType.toUpperCase()}</b></div>
              <div><span>Network</span><b>{venueSchema.network.toUpperCase()}</b></div>
              <div className="venue-ready-state" title={venueSchema.readinessReason || "Account and venue checks passed."}>
                <i className={venueSchema.executionReady ? "ready" : accountSyncError ? "blocked" : "syncing"} />
                <b>{venueSchema.executionReady ? "TRADING READY" : accountSyncError ? "SYNC FAILED" : accountSync ? "BLOCKED" : "SYNCING"}</b>
              </div>
            </div>

            <div className="bybit-product-tabs" role="tablist" aria-label="Bybit product">
              <button type="button" className={marketKind === "spot" ? "active" : ""} onClick={() => setMarketKind("spot")}>Spot</button>
              <button type="button" className={marketKind === "perpetual" ? "active" : ""} onClick={() => setMarketKind("perpetual")}>Futures</button>
              <span>{venueSchema.accountType} / {venueSchema.currentPositionMode}</span>
            </div>

            <div className="bybit-symbol-row">
              <b>{formatBybitSymbol(venueSchema.instrumentRules.symbol)}</b>
              <strong>{executionPrice > 0 ? formatPrice(executionPrice) : "--"}</strong>
            </div>

            <div className="bybit-side-tabs">
              <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>{marketKind === "spot" ? "Buy" : "Long"}</button>
              <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>{marketKind === "spot" ? "Sell" : "Short"}</button>
            </div>

            <div className="bybit-order-tabs" role="tablist" aria-label={`${venueSchema.venueLabel} order type`}>
              {venueSchema.supportedOrderModes.map((mode) => (
                <button type="button" key={mode.id} className={mode.orderTypes.includes(orderType) ? "active" : ""} onClick={() => setOrderType(mode.orderTypes[0])}>
                  {mode.label}
                </button>
              ))}
            </div>
            {activeOrderMode && <div className="venue-execution-origin">{venueSchema.venueLabel.toUpperCase()} NATIVE / {activeOrderMode.label.toUpperCase()}</div>}

            <div className="bybit-balance-row">
              <span>Available Balance</span>
              <span className="bybit-balance-value">
                <b>{accountMetrics ? balancesVisible ? `${formatVenueNumber(availableBalance)} ${venueSchema.instrumentRules.settlementAsset}` : "HIDDEN" : "Syncing"}</b>
                <button type="button" title={balancesVisible ? "Hide balances" : "Show balances"} onClick={() => setBalancesVisible((visible) => !visible)}>{balancesVisible ? <EyeOff size={13} /> : <Eye size={13} />}</button>
              </span>
            </div>

            {venueSchema.featureFlags.showMarginMode && (
              <div className="bybit-position-settings">
                <label><span>Margin</span><select value={marginMode} onChange={(event) => setMarginMode(event.target.value as MarginMode)}>{venueSchema.supportedMarginModes.map((mode) => <option key={mode} value={mode}>{titleCase(mode)}</option>)}</select></label>
                {venueSchema.featureFlags.showLeverage && <label><span>Leverage (max {venueSchema.instrumentRules.maxLeverage}x)</span><div className="bybit-suffix-input"><input value={leverage} min={venueSchema.instrumentRules.minLeverage} max={venueSchema.instrumentRules.maxLeverage} step={venueSchema.instrumentRules.leverageStep} onChange={(event) => setLeverage(clampNumber(Number(event.target.value || 1), venueSchema.instrumentRules.minLeverage, venueSchema.instrumentRules.maxLeverage))} inputMode="decimal" /><b>x</b></div></label>}
                <span className="bybit-position-mode">Position Mode <b>{venueSchema.currentPositionMode.toUpperCase()}</b></span>
                <button type="button" className="bybit-apply-settings" disabled={modeUpdatePending || (!venueSchema.featureFlags.showLeverage || leverage === venueSchema.currentLeverage) && marginMode === venueSchema.currentMarginMode} onClick={() => void applyVenueAccountSettings()}>{modeUpdatePending ? "Applying" : "Apply"}</button>
              </div>
            )}

            {["stop-market", "stop-limit"].includes(orderType) && (
              <div className="bybit-condition-row">
                <label><span>Trigger Price</span><div className="bybit-suffix-input"><input value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
                <label><span>Trigger By</span><select value={triggerBy} onChange={(event) => setTriggerBy(event.target.value as TriggerSource)}><option value="last">Last Price</option><option value="mark">Mark Price</option><option value="index">Index Price</option></select></label>
                <label><span>Order</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as OrderType)}><option value="stop-market">Market</option><option value="stop-limit">Limit</option></select></label>
                <span className="bybit-trigger-direction">{Number(stopPrice || 0) > 0 ? Number(stopPrice) >= executionPrice ? "Triggers when price rises" : "Triggers when price falls" : "Enter trigger price"}</span>
              </div>
            )}

            {orderType === "chase-limit" && (
              <div className="bybit-strategy-grid">
                <label><span>Chase Unit</span><select value={strategyChaseUnit} onChange={(event) => setStrategyChaseUnit(event.target.value as "distance" | "percent")}><option value="distance">Price Distance</option><option value="percent">Percentage</option></select></label>
                <label><span>Chase {strategyChaseUnit === "distance" ? "Distance" : "%"}</span><input value={strategyChaseValue} onChange={(event) => setStrategyChaseValue(event.target.value)} inputMode="decimal" /></label>
                <label><span>Trigger Price</span><input value={strategyTriggerPrice} onChange={(event) => setStrategyTriggerPrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label><span>Maximum Chase Price</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
              </div>
            )}

            {orderType === "twap" && (
              <div className="bybit-strategy-grid">
                <label><span>Running Time</span><select value={strategyDurationSeconds} onChange={(event) => setStrategyDurationSeconds(Number(event.target.value))}><option value={600}>10 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option></select></label>
                <label><span>Child Interval</span><select value={strategyIntervalSeconds} onChange={(event) => setStrategyIntervalSeconds(Number(event.target.value))}><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option value={120}>120 seconds</option></select></label>
                <label><span>Trigger Price</span><input value={strategyTriggerPrice} onChange={(event) => setStrategyTriggerPrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label><span>Price Protection</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
                <label className="bybit-check"><input type="checkbox" checked={strategyRandomize} onChange={(event) => setStrategyRandomize(event.target.checked)} /> Randomize child size</label>
              </div>
            )}

            {orderType === "iceberg" && (
              <div className="bybit-strategy-grid">
                <label><span>Order Preference</span><select value={icebergPreference} onChange={(event) => setIcebergPreference(event.target.value as typeof icebergPreference)}><option value="maker">Chase Limit / Maker</option><option value="taker">Chase Limit / Taker</option><option value="offset">Chase Limit / Offset</option><option value="fixed">Fixed Price</option></select></label>
                <label><span>Visible Child Size</span><input value={strategySubSize} onChange={(event) => setStrategySubSize(event.target.value)} placeholder="Uses count when empty" inputMode="decimal" /></label>
                <label><span>Order Count</span><input value={strategyOrderCount} min="2" step="1" onChange={(event) => setStrategyOrderCount(Math.max(2, Number(event.target.value || 2)))} inputMode="numeric" /></label>
                {icebergPreference === "fixed" && <label><span>Fixed Price</span><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /></label>}
                {icebergPreference === "offset" && <label><span>Chase Offset</span><input value={strategyChaseValue} onChange={(event) => setStrategyChaseValue(event.target.value)} inputMode="decimal" /></label>}
                <label><span>Price Protection</span><input value={strategyMaxChasePrice} onChange={(event) => setStrategyMaxChasePrice(event.target.value)} placeholder="Optional" inputMode="decimal" /></label>
              </div>
            )}

            {orderType === "pov" && (
              <div className="bybit-strategy-grid">
                <label><span>Volume Reference</span><select value={povMode} onChange={(event) => setPovMode(event.target.value as typeof povMode)}><option value="TradedVolume">Traded Volume</option><option value="OppositeSideLiquidity">Opposite Liquidity</option><option value="SameSideLiquidity">Same-side Liquidity</option></select></label>
                <label><span>Participation</span><div className="bybit-suffix-input"><input value={povParticipationRate} min="1" max="100" step="0.1" onChange={(event) => setPovParticipationRate(clampNumber(Number(event.target.value || 1), 1, 100))} inputMode="decimal" /><b>%</b></div></label>
                <label><span>Sampling Interval</span><input value={strategyIntervalSeconds} min="0" max="3600" step="1" onChange={(event) => setStrategyIntervalSeconds(Number(event.target.value || 0))} inputMode="numeric" /></label>
                <label><span>Maximum Duration</span><input value={strategyDurationSeconds} min="900" max="86400" step="60" onChange={(event) => setStrategyDurationSeconds(Number(event.target.value || 900))} inputMode="numeric" /></label>
                {povMode === "TradedVolume" ? <label><span>Reference Window</span><input value={povReferenceWindow} min="60" max="14400" step="60" onChange={(event) => setPovReferenceWindow(Number(event.target.value || 60))} inputMode="numeric" /></label> : <label><span>Book Depth</span><input value={povDepthReference} min="1" max="10" step="1" onChange={(event) => setPovDepthReference(clampNumber(Number(event.target.value || 1), 1, 10))} inputMode="numeric" /></label>}
              </div>
            )}

            {["limit", "stop-limit"].includes(orderType) && (
              <label><span>Price</span><div className="bybit-suffix-input"><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
            )}

            <label>
              <span>{sizingMethod === "usd" ? "Notional" : sizingMethod === "equityPct" ? "Equity Allocation" : "Quantity"}</span>
              <div className="bybit-split-input">
                <input value={quantity} onChange={(event) => { setQuantity(event.target.value); setBalancePercent(0); }} inputMode="decimal" />
                <select value={sizingMethod} onChange={(event) => setSizingMethod(event.target.value as SizingMethod)}>
                  {venueSizingMethods.map((method) => <option key={method.value} value={method.value}>{method.value === "quantity" ? venueSchema.instrumentRules.baseAsset : method.value === "usd" ? venueSchema.instrumentRules.quoteAsset : "Equity %"}</option>)}
                </select>
              </div>
            </label>

            <div className="bybit-size-slider">
              <div className="bybit-size-slider-head">
                <span>Equity Allocation <b>{balancePercent}%</b></span>
                <span>{sizingCapacity?.serverNotionalCap ? `Safety cap ${formatUsd(sizingCapacity.serverNotionalCap)}` : "Venue capacity"}</span>
              </div>
              <input type="range" min="0" max="100" step="1" value={balancePercent} onChange={(event) => applyBalancePercent(Number(event.target.value) / 100)} aria-label="Equity allocation percentage" />
              <div><span>0</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
            </div>

            <div className="bybit-order-summary">
              <span>Order Value <b>{formatUsd(estimatedNotional)}</b></span>
              <span>Required Margin <b>{marketKind === "spot" ? "--" : formatUsd(estimatedMargin)}</b></span>
              <span>Entry Fee <b>{formatUsd(preview?.entryFee || 0)}</b></span>
              <span>Exit Fee <b>{formatUsd(preview?.exitFee || 0)}</b></span>
              <span>Available After <b className={remainingBalance < 0 ? "negative" : ""}>{accountMetrics ? formatUsd(remainingBalance) : "--"}</b></span>
              <span>Risk / Reward <b>{preview?.rewardRiskRatio ? `${preview.rewardRiskRatio.toFixed(2)} R` : "--"}</b></span>
            </div>

            {!strategyOrder && <label className="bybit-check"><input type="checkbox" disabled={reduceOnly} checked={tpSlEnabled && !reduceOnly} onChange={(event) => setTpSlEnabled(event.target.checked)} /> TP/SL</label>}
            {!strategyOrder && tpSlEnabled && (
              <div className="bybit-tpsl-row">
                <label><span>Take Profit</span><div className="bybit-suffix-input"><input value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
                <label><span>TP Trigger</span><select value={tpTriggerBy} onChange={(event) => setTpTriggerBy(event.target.value as TriggerSource)}><option value="last">Last Price</option><option value="mark">Mark Price</option><option value="index">Index Price</option></select></label>
                <label><span>Stop Loss</span><div className="bybit-suffix-input"><input value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" /><b>USDT</b></div></label>
                <label><span>SL Trigger</span><select value={slTriggerBy} onChange={(event) => setSlTriggerBy(event.target.value as TriggerSource)}><option value="last">Last Price</option><option value="mark">Mark Price</option><option value="index">Index Price</option></select></label>
              </div>
            )}

            <details className="bybit-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary>Advanced Settings</summary>
              <div className="bybit-order-options">
                {!strategyOrder && <label className="bybit-check"><input type="checkbox" disabled={!["limit", "stop-limit"].includes(orderType)} checked={postOnly && ["limit", "stop-limit"].includes(orderType)} onChange={(event) => setPostOnly(event.target.checked)} /> Post-Only</label>}
                {venueSchema.featureFlags.showReduceOnly && <label className="bybit-check"><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce-Only</label>}
                {["limit", "stop-limit"].includes(orderType) && <select aria-label="Time in force" value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as TimeInForce)}>{venueSchema.supportedTimeInForce.map((tif) => <option key={tif} value={tif}>{tif.toUpperCase()}</option>)}</select>}
              </div>
              {orderType === "market" && <label className="bybit-slippage"><span>Slippage Tolerance</span><div className="bybit-suffix-input"><input value={slippageTolerance} min="0.01" max="10" step="0.01" onChange={(event) => setSlippageTolerance(clampNumber(Number(event.target.value || 0.01), 0.01, 10))} inputMode="decimal" /><b>%</b></div></label>}
              <p>{strategyOrder ? "This strategy is created and supervised by Bybit's native strategy engine." : orderType === "market" ? `${venueSchema.venueLabel} executes market orders using venue-protected IOC behavior.` : "Post-Only cancels instead of taking liquidity."}</p>
            </details>

            <div className="venue-account-metrics">
              <div><span>Total Equity</span><b>{maskMetric(accountMetrics?.equityUsd, balancesVisible)}</b></div>
              <div><span>Available Margin</span><b>{maskMetric(accountMetrics?.availableBalanceUsd, balancesVisible)}</b></div>
              <div><span>Margin Balance</span><b>{maskMetric(accountMetrics?.marginBalanceUsd, balancesVisible)}</b></div>
              <div><span>Initial Margin</span><b>{maskMetric(accountMetrics?.initialMarginUsd, balancesVisible)}</b></div>
              <div><span>Maintenance</span><b>{maskMetric(accountMetrics?.maintenanceMarginUsd, balancesVisible)}</b></div>
              <div><span>Unrealized PnL</span><b>{maskMetric(accountMetrics?.unrealizedPnlUsd, balancesVisible)}</b></div>
              <div><span>Risk Ratio</span><b>{!balancesVisible ? "HIDDEN" : accountMetrics?.accountMmRate === null || accountMetrics?.accountMmRate === undefined ? "--" : `${(accountMetrics.accountMmRate * 100).toFixed(2)}%`}</b></div>
            </div>

            {activeStrategies.length > 0 && (
              <div className="bybit-active-strategies">
                <strong>Active Bybit Strategies</strong>
                {activeStrategies.map((strategy) => (
                  <div key={strategy.strategyId}>
                    <span><b>{strategy.strategyType.toUpperCase()}</b> {strategy.filledQuantity}/{strategy.quantity} {venueSchema.instrumentRules.baseAsset}</span>
                    <button type="button" disabled={stoppingStrategyId === strategy.strategyId} onClick={() => void stopStrategy(strategy.strategyId)}>{stoppingStrategyId === strategy.strategyId ? "Stopping" : "Stop"}</button>
                  </div>
                ))}
              </div>
            )}

            {ticketMessage && <div className="bybit-ticket-status">{ticketMessage}</div>}

            <div className="venue-order-intent">
              <b>{side === "buy" ? "BUY" : "SELL"} {venueSchema.instrumentRules.symbol} {venueSchema.marketType.toUpperCase()}</b>
              <span>{formatOrderStatus(orderType)} / {effectiveSizingMethod === "usd" ? formatUsd(effectiveSize) : `${orderValidation.normalizedQuantity || 0} ${venueSchema.instrumentRules.baseAsset}`} / {marketKind === "spot" ? "Spot" : `${leverage}x ${titleCase(marginMode)}`}</span>
            </div>

            <button
              type="button"
              disabled={!orderValidation.valid || exceedsAvailableBalance || exceedsServerNotional || instrumentBlockedByServerCap || !accountMetrics || !venueSchema.executionReady || modeUpdatePending}
              className={side === "buy" ? "bybit-submit buy" : "bybit-submit sell"}
              onClick={submit}
            >
              {strategyOrder ? `Start ${activeOrderMode?.label || "Strategy"}` : marketKind === "spot" ? `${side === "buy" ? "Buy" : "Sell"} ${venueSchema.instrumentRules.baseAsset}` : side === "buy" ? "Long / Buy" : "Short / Sell"}
            </button>
          </div>
        ) : (
          <>
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

function formatConnectionOption(connection: ConnectionDiagnostics, sync: ExchangeAccountSyncPayload | null = null) {
  const latency = `${connection.health.latencyMs}ms`;
  if (connection.category === "wallet") {
    const address = connection.walletAddress ? `${connection.walletAddress.slice(0, 6)}...${connection.walletAddress.slice(-4)}` : "wallet";
    return `${connection.label} / ${address} / ${connection.status.toUpperCase()} / ${latency}`;
  }
  const accountType = sync?.accountMetrics.accountType || String(connection.metadata.accountMode || "ACCOUNT");
  const balance = sync ? ` / ${formatVenueNumber(sync.accountMetrics.availableBalanceUsd)} USDT` : "";
  return `${connection.label} / ${connection.provider.toUpperCase()} / ${accountType} / ${connection.status.toUpperCase()}${balance} / ${latency}`;
}

function buildExecutionAccount(connection: ConnectionDiagnostics, sync: ExchangeAccountSyncPayload | null): PortfolioAccount {
  const metrics = sync?.accountMetrics;
  const tradingEnabled = connection.health.permissions.trading === true;
  const storedControls = connection.metadata.accountRiskControls as PortfolioAccount["riskControls"] | undefined;
  const accountDrivenBybit = connection.provider === "bybit" && Number(sync?.executionState.maxNotionalUsd || 0) <= 0;
  const riskControls = {
    ...(storedControls || defaultRiskControls),
    maxPositionUsd: accountDrivenBybit ? 0 : storedControls?.maxPositionUsd ?? defaultRiskControls.maxPositionUsd,
    maxPortfolioExposureUsd: storedControls?.maxPortfolioExposureUsd ?? (accountDrivenBybit ? 0 : defaultRiskControls.maxPortfolioExposureUsd),
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

function maskMetric(value: number | undefined, visible: boolean) {
  if (!visible) return "HIDDEN";
  return value === undefined ? "--" : formatUsd(value);
}

function titleCase(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatOrderStatus(status: string) {
  return status.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Order unavailable.");
  if (/minimum.*notional|below Bybit minimum notional/i.test(message)) return message.replace(/^.*?Order notional/i, "Order value");
  if (/quantity step/i.test(message)) return "Order quantity does not match the venue quantity increment.";
  if (/tick size/i.test(message)) return "Order price does not match the venue price increment.";
  if (/insufficient|available balance|available margin/i.test(message)) return message;
  if (/private.*stream|reconnect/i.test(message)) return "Order unavailable: Bybit account synchronization is reconnecting.";
  if (/trading.*disabled|read-only/i.test(message)) return "Order unavailable: this Bybit API key is not enabled for trading.";
  if (/service.?role|allowlist|environment|supabase|validation mode/i.test(message)) return "Order unavailable. Open Runtime & Certification in Connections for details.";
  if (/HTTP 5\d\d|server error/i.test(message)) return "Order unavailable: the venue connection is temporarily unavailable.";
  return message;
}
