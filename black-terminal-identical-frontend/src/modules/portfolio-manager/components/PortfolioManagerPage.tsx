import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  Activity,
  AlertTriangle,
  CircleDollarSign,
  Copy,
  KeyRound,
  Layers3,
  Plus,
  ShieldCheck,
  X
} from "lucide-react";
import { getCapabilities, resolveProductTier, type CapabilityUser } from "../../../core/permissions/capabilities";
import { blackCoreConnectionManager } from "../../../connectivity/connectionManager";
import { readActiveExecutionVenueId, setActiveExecutionVenueId } from "../../../connectivity/activeExecutionVenue";
import type { ConnectionCapability, ConnectionDiagnostics } from "../../../connectivity/types";
import { formatExecutionMode, getVenueCertification, type VenueCertificationRecord } from "../../../connectivity/venueRegistry";
import { submitOrder } from "../../../execution/executionEngine";
import { MAINNET_ORDER_CONFIRMATION, disableMainnetValidationMode, promptEnableMainnetValidationMode, readMainnetValidationMode, validateMainnetOrderReadiness } from "../../../execution/mainnetValidationMode";
import { getBybitRuntimeStatusViaApi, runExchangeAccountDiagnosticsViaApi, type BybitRuntimeStatusPayload, type PortfolioOrderDraft } from "../../../portfolio/portfolioApiClient";
import type { ExchangeConnectionDraft, PortfolioAccount, PortfolioSnapshot } from "../../../portfolio/types";
import { getPortfolioSnapshot } from "../../../portfolio/portfolioStore";
import { defaultRiskControls } from "../../../risk/types";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { ExchangeId } from "../../../market-data/types";
import { blackCorePositionManager } from "../../../positions/positionManager";
import type { ManagedPosition, PortfolioPosition } from "../../../positions/types";
import { canCreateInvestmentGroup, listInvestmentGroups } from "../../profile/professionalNetworkStore";

type PortfolioManagerTab =
  | "Overview"
  | "Performance"
  | "Risk"
  | "Investment Groups"
  | "Managed Capital"
  | "Followers"
  | "Execution Matrix"
  | "Audit"
  | "Permissions";
type VenueKind = "cex" | "dex";
type VenueSelectorKind = VenueKind | "wallet";
type DexVenueId = "hyperliquid" | "gmx" | "dydx" | "vertex" | "drift" | "uniswap" | "jupiter" | "raydium" | "pancakeswap";
type WalletProviderId = "metamask" | "phantom";
type TradeMode = "spot" | "convert" | "futures";
type ExecutionSide = "buy" | "sell";
type TicketOrderType = "limit" | "market" | "tpSl";

type ExecutionVenue = {
  id: string;
  kind: VenueKind;
  category: ConnectionDiagnostics["category"];
  label: string;
  detail: string;
  accountId?: string;
  exchange?: ExchangeId;
  walletAddress?: string;
  provider: string;
  capabilities: ConnectionCapability[];
  health: ConnectionDiagnostics["health"];
  unsupportedReason?: string;
  executionReady?: boolean;
  readinessReason?: string;
  network?: "testnet" | "mainnet";
  mainnetConfirmed?: boolean;
  executionMode?: string;
  readiness?: string;
  mainnetValidated?: boolean;
  limitations?: string[];
};

type PositionOrderRow = {
  orderId?: string;
  symbol: string;
  status: string;
  side?: string;
  type?: string;
  exchange?: string;
  filledQuantity?: number;
  averageFillPrice?: number;
  reason?: string;
  time?: number;
};

const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const dexVenues: Array<{ id: DexVenueId; label: string; chain: string; defaultProvider: WalletProviderId }> = [
  { id: "hyperliquid", label: "Hyperliquid", chain: "Arbitrum / Hyperliquid", defaultProvider: "metamask" },
  { id: "gmx", label: "GMX", chain: "Arbitrum / Avalanche", defaultProvider: "metamask" },
  { id: "dydx", label: "dYdX", chain: "dYdX Chain", defaultProvider: "metamask" },
  { id: "vertex", label: "Vertex", chain: "Arbitrum", defaultProvider: "metamask" },
  { id: "drift", label: "Drift", chain: "Solana", defaultProvider: "phantom" },
  { id: "uniswap", label: "Uniswap", chain: "Ethereum", defaultProvider: "metamask" },
  { id: "jupiter", label: "Jupiter", chain: "Solana", defaultProvider: "phantom" },
  { id: "raydium", label: "Raydium", chain: "Solana", defaultProvider: "phantom" },
  { id: "pancakeswap", label: "PancakeSwap", chain: "BNB Chain", defaultProvider: "metamask" }
];

const walletProviders: Array<{ id: WalletProviderId; label: string; chainHint: string; defaultDex: DexVenueId }> = [
  { id: "metamask", label: "MetaMask", chainHint: "Ethereum / Hyperliquid", defaultDex: "hyperliquid" },
  { id: "phantom", label: "Phantom", chainHint: "Solana", defaultDex: "jupiter" }
];

export function PortfolioPositionsPanel({ positions }: { positions: PortfolioPosition[] }) {
  const [managedPositions, setManagedPositions] = useState<ManagedPosition[]>(() => blackCorePositionManager.listActivePositions());
  const [positionMenu, setPositionMenu] = useState<{ x: number; y: number; position: ManagedPosition } | null>(null);
  const [positionActionStatus, setPositionActionStatus] = useState("");

  useEffect(() => blackCorePositionManager.subscribe(setManagedPositions), []);

  useEffect(() => {
    blackCorePositionManager.syncExternalPositions(positions, "portfolio-manager");
  }, [positions]);

  useEffect(() => {
    const closeMenu = () => setPositionMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPositionMenu(null);
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  function openPositionMenu(event: MouseEvent<HTMLDivElement>, position: ManagedPosition) {
    event.preventDefault();
    event.stopPropagation();
    setPositionMenu({ x: event.clientX, y: event.clientY, position });
  }

  async function submitPositionAction(
    position: ManagedPosition,
    action: "close" | "reverse" | "takeProfit" | "stopLoss" | "bracket" | "scaleIn" | "scaleOut" | "breakEven" | "note" | "tags" | "timeline" | "stats"
  ) {
    const exitSide = position.direction === "long" ? "sell" : "buy";
    const referencePrice = position.currentPrice || position.averagePrice;
    setPositionMenu(null);
    setPositionActionStatus("SUBMITTING POSITION ACTION");

    const submitPositionOrder = async (draft: PortfolioOrderDraft) => {
      const update = await submitOrder({
            accountId: draft.accountId,
            exchange: draft.exchange,
            symbol: draft.symbol,
            marketKind: draft.marketKind,
            side: draft.side,
            type: draft.orderType,
            quantity: draft.quantity,
            sizingMethod: draft.sizingMethod ?? "quantity",
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
            source: "positions",
            destinations: ["personal-portfolio"]
          }, buildPositionExecutionAccount(position), referencePrice);
      if (update.status === "rejected") throw new Error(update.reason || "ORDER REJECTED");
      return update;
    };

    try {
      if (action === "stats") {
        setPositionActionStatus(`RR ${position.health.riskReward?.toFixed(2) ?? "-"} | RISK ${money.format(position.health.currentRisk)} | TIME ${Math.round(position.health.timeInTradeMs / 60000)}M`);
        return;
      }

      if (action === "timeline") {
        setPositionActionStatus(position.timeline.slice(0, 3).map((event) => event.message).join(" | ") || "NO POSITION TIMELINE EVENTS");
        return;
      }

      if (action === "note") {
        const note = window.prompt(`Add note for ${position.symbol}`, "");
        if (note) {
          blackCorePositionManager.addNote(position.id, note);
          setPositionActionStatus(`NOTE ADDED TO ${position.symbol}`);
        } else {
          setPositionActionStatus("NOTE CANCELLED");
        }
        return;
      }

      if (action === "tags") {
        const tags = window.prompt(`Tags for ${position.symbol}`, position.tags.join(", "));
        if (tags !== null) {
          blackCorePositionManager.setTags(position.id, tags.split(","));
          setPositionActionStatus(`TAGS UPDATED FOR ${position.symbol}`);
        }
        return;
      }

      if (action === "breakEven") {
        blackCorePositionManager.setProtection(position.id, "break-even", { price: position.averagePrice, metadata: { source: "positions-panel" } });
        setPositionActionStatus(`BREAK EVEN SET FOR ${position.symbol}`);
        return;
      }

      if (action === "scaleIn" || action === "scaleOut") {
        const amount = Number(window.prompt(`${action === "scaleIn" ? "Scale in" : "Scale out"} quantity for ${position.symbol}`, String(position.quantity / 2)));
        if (!amount || amount <= 0) {
          setPositionActionStatus("SCALE ACTION CANCELLED");
          return;
        }
        if (action === "scaleIn") blackCorePositionManager.scaleIn(position.id, amount, referencePrice);
        if (action === "scaleOut") blackCorePositionManager.scaleOut(position.id, amount);
        setPositionActionStatus(`${action === "scaleIn" ? "SCALE IN" : "SCALE OUT"} RECORDED FOR ${position.symbol}`);
        return;
      }

      if (action === "close") {
        await submitPositionOrder({
          accountId: position.accountId,
          exchange: position.exchange,
          symbol: position.symbol,
          marketKind: "perpetual",
          side: exitSide,
          orderType: "market",
          quantity: position.quantity,
          quantityMode: "quantity",
          referencePrice,
          reduceOnly: true,
          timeInForce: "ioc"
        });
        blackCorePositionManager.closePosition(position.id);
        setPositionActionStatus(`CLOSE ORDER SUBMITTED FOR ${position.symbol}`);
        return;
      }

      if (action === "reverse") {
        await submitPositionOrder({
          accountId: position.accountId,
          exchange: position.exchange,
          symbol: position.symbol,
          marketKind: "perpetual",
          side: exitSide,
          orderType: "market",
          quantity: position.quantity * 2,
          quantityMode: "quantity",
          referencePrice,
          reduceOnly: false,
          timeInForce: "ioc"
        });
        blackCorePositionManager.reversePosition(position.id);
        setPositionActionStatus(`REVERSE ORDER SUBMITTED FOR ${position.symbol}`);
        return;
      }

      const takeProfit = action === "takeProfit" || action === "bracket"
        ? Number(window.prompt(`Take profit price for ${position.symbol}`, position.takeProfit ? String(position.takeProfit) : ""))
        : undefined;
      const stopLoss = action === "stopLoss" || action === "bracket"
        ? Number(window.prompt(`Stop loss price for ${position.symbol}`, position.stopLoss ? String(position.stopLoss) : ""))
        : undefined;

      if ((action === "takeProfit" || action === "bracket") && (!takeProfit || takeProfit <= 0)) {
        setPositionActionStatus("TAKE PROFIT UPDATE CANCELLED");
        return;
      }
      if ((action === "stopLoss" || action === "bracket") && (!stopLoss || stopLoss <= 0)) {
        setPositionActionStatus("STOP LOSS UPDATE CANCELLED");
        return;
      }

      if (takeProfit) {
        blackCorePositionManager.setProtection(position.id, "take-profit", { price: takeProfit, metadata: { source: "positions-panel" } });
        await submitPositionOrder({
          accountId: position.accountId,
          exchange: position.exchange,
          symbol: position.symbol,
          marketKind: "perpetual",
          side: exitSide,
          orderType: "limit",
          quantity: position.quantity,
          quantityMode: "quantity",
          referencePrice,
          limitPrice: takeProfit,
          takeProfit,
          reduceOnly: true,
          timeInForce: "gtc"
        });
      }

      if (stopLoss) {
        blackCorePositionManager.setProtection(position.id, "stop-loss", { price: stopLoss, metadata: { source: "positions-panel" } });
        await submitPositionOrder({
          accountId: position.accountId,
          exchange: position.exchange,
          symbol: position.symbol,
          marketKind: "perpetual",
          side: exitSide,
          orderType: "stop-market",
          quantity: position.quantity,
          quantityMode: "quantity",
          referencePrice,
          stopPrice: stopLoss,
          stopLoss,
          reduceOnly: true,
          timeInForce: "gtc"
        });
      }

      setPositionActionStatus(action === "bracket" ? `TP/SL ORDERS SUBMITTED FOR ${position.symbol}` : `POSITION PROTECTION UPDATED FOR ${position.symbol}`);
    } catch (error) {
      setPositionActionStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  return (
    <div className="portfolio-positions-panel">
      <div className="pm-table-head pm-positions-grid">
        <span>Symbol</span>
        <span>Dir</span>
        <span>Qty</span>
        <span>Avg</span>
        <span>Mark</span>
        <span>Unrealized</span>
        <span>Realized</span>
        <span>Margin</span>
        <span>Lev</span>
        <span>Liq</span>
        <span>SL</span>
        <span>TP</span>
        <span>Open</span>
        <span>Exchange</span>
      </div>
      {managedPositions.map((position) => (
        <div className="pm-table-row pm-positions-grid position-row-actionable" key={position.id} onContextMenu={(event) => openPositionMenu(event, position)}>
          <b>{position.symbol}</b>
          <span className={position.direction === "long" ? "green" : "red"}>{position.direction.toUpperCase()}</span>
          <span>{compact.format(position.quantity)}</span>
          <span>{money.format(position.averagePrice)}</span>
          <span>{money.format(position.currentPrice)}</span>
          <span className={position.unrealizedPnl >= 0 ? "green" : "red"}>{money.format(position.unrealizedPnl)}</span>
          <span>{money.format(position.realizedPnl)}</span>
          <span>{money.format(position.margin)}</span>
          <span>{position.leverage}x</span>
          <span>{position.liquidationPrice ? money.format(position.liquidationPrice) : "-"}</span>
          <span>{position.stopLoss ? money.format(position.stopLoss) : "-"}</span>
          <span>{position.takeProfit ? money.format(position.takeProfit) : "-"}</span>
          <span>{Math.max(1, Math.round((Date.now() - position.openedAt) / 60000))}m</span>
          <span>{position.exchange.toUpperCase()}</span>
        </div>
      ))}
      {positionActionStatus && <div className="positions-action-status">{positionActionStatus}</div>}
      {managedPositions.length === 0 && (
        <div className="positions-empty-state">
          NO LIVE POSITIONS. CONNECT A BROKER OR DEX WALLET TO SYNC REAL ACCOUNT EXPOSURE.
        </div>
      )}
      {positionMenu && (
        <div
          className="position-context-menu"
          style={{ left: positionMenu.x, top: positionMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="position-context-head">
            <b>{positionMenu.position.symbol}</b>
            <span>{positionMenu.position.direction.toUpperCase()} {compact.format(positionMenu.position.quantity)}</span>
          </div>
          <button onClick={() => submitPositionAction(positionMenu.position, "close")}>Close Position</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "reverse")}>Reverse Position</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "scaleIn")}>Scale In</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "scaleOut")}>Scale Out / Partial Close</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "breakEven")}>Move Stop To Break Even</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "takeProfit")}>Change Take Profit</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "stopLoss")}>Change Stop Loss</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "bracket")}>Change TP/SL Bracket</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "stats")}>Position Statistics</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "timeline")}>Trade Timeline</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "note")}>Trade Notes</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "tags")}>Trade Tags</button>
        </div>
      )}
    </div>
  );
}

export function PositionsWorkspace({
  positions,
  orders = []
}: {
  positions: PortfolioPosition[];
  orders?: PositionOrderRow[];
}) {
  const [showConnection, setShowConnection] = useState(false);
  const [venueKind, setVenueKind] = useState<VenueKind>("cex");
  const [selectedCex, setSelectedCex] = useState<ExchangeId>("bybit");
  const [selectedDex, setSelectedDex] = useState<DexVenueId>("uniswap");
  const [walletProvider, setWalletProvider] = useState<WalletProviderId>("metamask");
  const [connection, setConnection] = useState<ExchangeConnectionDraft>({
    exchange: "bybit",
    accountName: "",
    apiKey: "",
    apiSecret: "",
    passphrase: ""
  });
  const [hyperliquidNetwork, setHyperliquidNetwork] = useState<"testnet" | "mainnet">("testnet");
  const [hyperliquidAgentPrivateKey, setHyperliquidAgentPrivateKey] = useState("");
  const [hyperliquidMainnetConfirmed, setHyperliquidMainnetConfirmed] = useState(false);
  const [connectStatus, setConnectStatus] = useState("");
  const [connectionDiagnostics, setConnectionDiagnostics] = useState<ConnectionDiagnostics[]>(() => blackCoreConnectionManager.listDiagnostics());
  const [activeVenueId, setActiveVenueId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return readActiveExecutionVenueId();
  });

  useEffect(() => blackCoreConnectionManager.subscribe(setConnectionDiagnostics), []);

  const executionVenues: ExecutionVenue[] = useMemo(() => connectionDiagnostics
    .filter((connection) => !["disconnected", "offline", "unsupported"].includes(connection.status))
    .map((connection) => {
      const isProtocol = connection.category === "protocol";
      const isWallet = connection.category === "wallet" || isProtocol;
      const venueLabel = String(connection.metadata.venueLabel || connection.metadata.venue || connection.provider);
      const address = connection.walletAddress;
      return {
        id: connection.id,
        kind: isWallet ? "dex" as const : "cex" as const,
        category: connection.category,
        label: isWallet ? `${venueLabel.toUpperCase()} / ${connection.provider.toUpperCase()}` : connection.label,
        detail: isWallet && address
          ? `${connection.provider.toUpperCase()} ${address.slice(0, 6)}...${address.slice(-4)}`
          : `${connection.provider.toUpperCase()} ${connection.status.toUpperCase()} ${connection.health.latencyMs}ms`,
        accountId: connection.accountId,
        exchange: isProtocol ? "hyperliquid" as ExchangeId : isWallet ? undefined : connection.provider as ExchangeId,
        walletAddress: address,
        provider: connection.provider,
        capabilities: connection.capabilities,
        health: connection.health,
        unsupportedReason: typeof connection.metadata.futuresUnsupportedReason === "string"
          ? connection.metadata.futuresUnsupportedReason
          : typeof connection.metadata.readinessReason === "string"
            ? connection.metadata.readinessReason
            : undefined,
        executionReady: connection.metadata.executionReady === true,
        readinessReason: typeof connection.metadata.readinessReason === "string" ? connection.metadata.readinessReason : undefined,
        network: connection.metadata.network === "mainnet" ? "mainnet" : connection.metadata.network === "testnet" ? "testnet" : undefined,
        mainnetConfirmed: connection.metadata.mainnetConfirmed === true,
        executionMode: typeof connection.metadata.executionMode === "string" ? connection.metadata.executionMode : undefined,
        readiness: typeof connection.metadata.readiness === "string" ? connection.metadata.readiness : undefined,
        mainnetValidated: connection.metadata.mainnetValidated === true,
        limitations: Array.isArray(connection.metadata.limitations) ? connection.metadata.limitations.map(String) : undefined
      };
    }), [connectionDiagnostics]);
  const activeExecutionVenue = executionVenues.find((venue) => venue.id === activeVenueId) ?? executionVenues[0] ?? null;

  useEffect(() => {
    setActiveExecutionVenueId(activeVenueId);
  }, [activeVenueId]);

  useEffect(() => {
    if (!activeVenueId && executionVenues[0]) setActiveVenueId(executionVenues[0].id);
    if (activeVenueId && executionVenues.length > 0 && !executionVenues.some((venue) => venue.id === activeVenueId)) {
      setActiveVenueId(executionVenues[0].id);
    }
  }, [activeVenueId, executionVenues]);

  const selectedDexVenue = dexVenues.find((venue) => venue.id === selectedDex) ?? dexVenues[0];
  const selectedCexCertification = getVenueCertification(selectedCex);
  const selectedDexCertification = getVenueCertification(selectedDex);
  const venueValue = `${venueKind}:${venueKind === "cex" ? selectedCex : selectedDex}`;
  const centralizedConnectionCount = connectionDiagnostics.filter((connection) => connection.category === "centralized-exchange").length;
  const walletConnectionCount = connectionDiagnostics.filter((connection) => connection.category === "wallet").length;
  const walletDiagnostics = connectionDiagnostics.filter((connection) => connection.category === "wallet");

  function updateVenue(value: string) {
    const [kind, id] = value.split(":") as [VenueSelectorKind, string];
    setConnectStatus("");

    if (kind === "cex") {
      setVenueKind("cex");
      setSelectedCex(id as ExchangeId);
      setConnection((current) => ({ ...current, exchange: id as ExchangeId }));
      return;
    }

    if (kind === "wallet") {
      const wallet = walletProviders.find((provider) => provider.id === id) ?? walletProviders[0];
      const dex = dexVenues.find((venue) => venue.id === wallet.defaultDex) ?? dexVenues[0];
      setVenueKind("dex");
      setSelectedDex(dex.id);
      setWalletProvider(wallet.id);
      return;
    }

    const dex = dexVenues.find((venue) => venue.id === id) ?? dexVenues[0];
    setVenueKind("dex");
    setSelectedDex(dex.id);
    setWalletProvider(dex.defaultProvider);
  }

  async function handleConnectCex() {
    if (!selectedCexCertification?.authReady) {
      setConnectStatus((selectedCexCertification?.limitations[0] || `${selectedCex.toUpperCase()} credential validation is not certified yet.`).toUpperCase());
      return;
    }
    const accountName = connection.accountName.trim() || marketCatalog.find((exchange) => exchange.id === selectedCex)?.label || selectedCex;
    if (!connection.apiKey.trim() || !connection.apiSecret.trim()) {
      setConnectStatus("API KEY AND SECRET REQUIRED");
      return;
    }

    try {
      const nextConnection = await blackCoreConnectionManager.connect({
        adapterId: `cex:${selectedCex}`,
        category: "centralized-exchange",
        provider: selectedCex,
        label: accountName,
        credentials: {
          ...connection,
          exchange: selectedCex,
          accountName
        },
        metadata: {
          accountName
        }
      });
      setActiveVenueId(nextConnection.id);
      setConnection({ exchange: selectedCex, accountName: "", apiKey: "", apiSecret: "", passphrase: "" });
      setConnectStatus("BROKER LINK STORED");
      setShowConnection(false);
    } catch (error) {
      setConnectStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  async function handleConnectDex() {
    try {
      const isHyperliquid = selectedDex === "hyperliquid";
      if (selectedDexCertification?.connectorVisible === false) {
        setConnectStatus((selectedDexCertification.limitations[0] || `${selectedDexVenue.label} is deferred.`).toUpperCase());
        return;
      }
      const hasHyperliquidAgentKey = hyperliquidAgentPrivateKey.trim().length > 0;
      if (isHyperliquid && hasHyperliquidAgentKey && hyperliquidNetwork === "mainnet" && !hyperliquidMainnetConfirmed) {
        setConnectStatus("MAINNET REQUIRES EXPLICIT CONFIRMATION");
        return;
      }
      const nextConnection = await blackCoreConnectionManager.connect({
        adapterId: isHyperliquid ? "protocol:hyperliquid" : `wallet:${walletProvider}`,
        category: isHyperliquid ? "protocol" : "wallet",
        provider: isHyperliquid ? "hyperliquid" : walletProvider,
        label: `${selectedDexVenue.label} / ${walletProvider === "metamask" ? "MetaMask" : "Phantom"}`,
        credentials: isHyperliquid
          ? {
              agentPrivateKey: hasHyperliquidAgentKey ? hyperliquidAgentPrivateKey : undefined,
              network: hyperliquidNetwork,
              accountName: `${selectedDexVenue.label} ${hyperliquidNetwork}`,
              mainnetConfirmed: hasHyperliquidAgentKey ? hyperliquidMainnetConfirmed : undefined
            }
          : undefined,
        metadata: {
          protocol: isHyperliquid ? "hyperliquid" : undefined,
          signer: walletProvider,
          venue: selectedDex,
          venueLabel: selectedDexVenue.label,
          chain: selectedDexVenue.chain,
          network: isHyperliquid ? hyperliquidNetwork : undefined,
          mainnetConfirmed: isHyperliquid && hasHyperliquidAgentKey ? hyperliquidMainnetConfirmed : undefined
        }
      });
      setActiveVenueId(nextConnection.id);
      setHyperliquidAgentPrivateKey("");
      setConnectStatus(isHyperliquid
        ? nextConnection.metadata.executionReady === true
          ? "HYPERLIQUID RELAY READY"
          : String(nextConnection.metadata.readinessReason || "HYPERLIQUID RELAY LINKED BUT NOT READY").toUpperCase()
        : "WALLET LINKED");
      setShowConnection(false);
    } catch (error) {
      setConnectStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function handleSwitchExecutionVenue() {
    if (executionVenues.length <= 1) {
      setShowConnection(true);
      return;
    }

    const currentIndex = executionVenues.findIndex((venue) => venue.id === activeExecutionVenue?.id);
    const nextVenue = executionVenues[(currentIndex + 1) % executionVenues.length];
    setActiveVenueId(nextVenue.id);
  }

  function handleDisconnectExecutionVenue() {
    if (!activeExecutionVenue) return;

    const nextVenue = executionVenues.find((venue) => venue.id !== activeExecutionVenue.id);
    void blackCoreConnectionManager.disconnect(activeExecutionVenue.id);
    setActiveVenueId(nextVenue?.id ?? null);
  }

  return (
    <div className="positions-workspace">
      <div className="positions-left-stack">
        <PortfolioPositionsPanel positions={positions} />
        <div className="positions-orders-panel">
          <div className="positions-orders-title">Orders</div>
          <div className="positions-orders-head">
            <span>Symbol</span>
            <span>Side</span>
            <span>Type</span>
            <span>Status</span>
            <span>Filled</span>
            <span>Avg</span>
            <span>Exchange</span>
          </div>
          {orders.length > 0 ? (
            orders.map((order) => (
              <div className="positions-orders-row" key={order.orderId ?? `${order.symbol}-${order.time}`}>
                <b>{order.symbol}</b>
                <span>{order.side ?? "-"}</span>
                <span>{order.type ?? "-"}</span>
                <span>{order.status}</span>
                <span>{order.filledQuantity ?? 0}</span>
                <span>{order.averageFillPrice ? money.format(order.averageFillPrice) : "-"}</span>
                <span>{order.exchange?.toUpperCase() ?? "-"}</span>
              </div>
            ))
          ) : (
            <div className="positions-orders-empty">NO OPEN ORDERS</div>
          )}
        </div>
      </div>

      <aside className={activeExecutionVenue ? "positions-execution-dock" : "positions-connect-dock"}>
        {activeExecutionVenue ? (
          <ExecutionDock
            venue={activeExecutionVenue}
            venues={executionVenues}
            activeVenueId={activeExecutionVenue.id}
            onVenueChange={setActiveVenueId}
            onAddConnection={() => setShowConnection(true)}
            onSwitchVenue={handleSwitchExecutionVenue}
            onDisconnectVenue={handleDisconnectExecutionVenue}
          />
        ) : (
          <>
            <button className="positions-connect-button" onClick={() => setShowConnection(true)}>
              <Plus size={15} /> Connect Broker or DEX
            </button>
            <div className="positions-connect-summary">
              <span>Broker Links</span>
              <b>{centralizedConnectionCount}</b>
              <span>Wallet Links</span>
              <b>{walletConnectionCount}</b>
            </div>
            <div className="positions-wallet-list">
              {walletDiagnostics.map((connection) => (
                <div className="positions-wallet-link" key={connection.id}>
                  <b>{String(connection.metadata.venue || connection.provider).toUpperCase()}</b>
                  <span>{connection.provider.toUpperCase()}</span>
                  <em>{connection.walletAddress ? `${connection.walletAddress.slice(0, 6)}...${connection.walletAddress.slice(-4)}` : connection.status.toUpperCase()}</em>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {showConnection && (
        <div className="pm-floating">
          <div className={venueKind === "dex" ? "pm-ticket dex-ticket" : "pm-ticket"}>
            <div className="pm-ticket-head">
              <KeyRound size={15} />
              {venueKind === "cex" ? "Connect Broker" : "Link DEX Wallet"}
              <button onClick={() => setShowConnection(false)}><X size={14} /></button>
            </div>
            <select value={venueValue} onChange={(event) => updateVenue(event.target.value)}>
              <optgroup label="Centralized Exchanges">
                {marketCatalog
                  .filter((exchange) => getVenueCertification(exchange.id)?.category === "centralized-exchange")
                  .map((exchange) => {
                    const certification = getVenueCertification(exchange.id);
                    return (
                      <option key={exchange.id} value={`cex:${exchange.id}`} disabled={!certification?.authReady}>
                        {exchange.label} - {certification?.authReady ? "Secure account auth" : "Market data only"}
                      </option>
                    );
                  })}
              </optgroup>
              <optgroup label="DEX">
                {dexVenues.map((venue) => {
                  const certification = getVenueCertification(venue.id);
                  return (
                    <option key={venue.id} value={`dex:${venue.id}`} disabled={certification?.connectorVisible === false}>
                      {venue.label} / {venue.defaultProvider === "metamask" ? "MetaMask" : "Phantom"} - {certification ? formatExecutionMode(certification.executionMode) : "UNAVAILABLE"}
                    </option>
                  );
                })}
              </optgroup>
              <optgroup label="Wallet Connectors">
                {walletProviders.map((provider) => (
                  <option key={provider.id} value={`wallet:${provider.id}`}>
                    {provider.label} Wallet ({provider.chainHint})
                  </option>
                ))}
              </optgroup>
            </select>

            {venueKind === "cex" ? (
              <>
                <ConnectionSupportCard certification={selectedCexCertification} />
                <input placeholder="Account name" value={connection.accountName} onChange={(event) => setConnection((current) => ({ ...current, accountName: event.target.value }))} />
                <input placeholder="API key" value={connection.apiKey} onChange={(event) => setConnection((current) => ({ ...current, apiKey: event.target.value }))} />
                <input placeholder="API secret" type="password" value={connection.apiSecret} onChange={(event) => setConnection((current) => ({ ...current, apiSecret: event.target.value }))} />
                <input placeholder="Passphrase, if required" type="password" value={connection.passphrase} onChange={(event) => setConnection((current) => ({ ...current, passphrase: event.target.value }))} />
                {connectStatus && <div className="positions-connect-status">{connectStatus}</div>}
                <button className="primary" disabled={!selectedCexCertification?.authReady} onClick={handleConnectCex}>
                  {selectedCexCertification?.authReady ? "Connect Account" : "Adapter Not Certified"}
                </button>
              </>
            ) : (
              <>
                <div className="pm-segment">
                  <button className={walletProvider === "metamask" ? "active" : ""} onClick={() => { setWalletProvider("metamask"); setSelectedDex("hyperliquid"); }}>MetaMask</button>
                  <button className={walletProvider === "phantom" ? "active" : ""} onClick={() => { setWalletProvider("phantom"); setSelectedDex("jupiter"); }}>Phantom</button>
                </div>
                <div className="positions-dex-card">
                  <span>{selectedDexVenue.label}</span>
                  <b>{selectedDexVenue.chain}</b>
                </div>
                <ConnectionSupportCard certification={selectedDexCertification} />
                {selectedDex === "hyperliquid" && (
                  <>
                    <select value={hyperliquidNetwork} onChange={(event) => setHyperliquidNetwork(event.target.value as "testnet" | "mainnet")}>
                      <option value="testnet">Hyperliquid Testnet</option>
                      <option value="mainnet">Hyperliquid Mainnet</option>
                    </select>
                    <input
                      placeholder="Agent wallet private key"
                      type="password"
                      value={hyperliquidAgentPrivateKey}
                      onChange={(event) => setHyperliquidAgentPrivateKey(event.target.value)}
                    />
                    {hyperliquidNetwork === "mainnet" && (
                      <label className="positions-confirm-line">
                        <input type="checkbox" checked={hyperliquidMainnetConfirmed} onChange={(event) => setHyperliquidMainnetConfirmed(event.target.checked)} />
                        Confirm mainnet live execution
                      </label>
                    )}
                  </>
                )}
                {connectStatus && <div className="positions-connect-status">{connectStatus}</div>}
                <button className="primary" onClick={handleConnectDex}>
                  {selectedDex === "hyperliquid"
                    ? hyperliquidAgentPrivateKey.trim() ? "Link Relay" : "Connect MetaMask / Hyperliquid"
                    : "Link Wallet"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionSupportCard({ certification }: { certification?: VenueCertificationRecord }) {
  if (!certification) {
    return (
      <div className="connection-support-card blocked">
        <div><span>Certification</span><b>Unknown</b></div>
        <p>This venue is not registered in the Black Terminal certification matrix.</p>
      </div>
    );
  }

  return (
    <div className={`connection-support-card ${certification.executionMode}`}>
      <div>
        <span>{certification.label}</span>
        <b>{formatExecutionMode(certification.executionMode)}</b>
      </div>
      <div>
        <span>Readiness</span>
        <b>{certification.readiness.replace(/-/g, " ").toUpperCase()}</b>
      </div>
      <div>
        <span>Products</span>
        <b>{certification.supportedProducts.length ? certification.supportedProducts.join(", ").toUpperCase() : "NONE"}</b>
      </div>
      <p>{certification.limitations[0]}</p>
      {!certification.mainnetValidated && <em>MAINNET CERTIFICATION NOT RECORDED</em>}
    </div>
  );
}

function ExecutionDock({
  venue,
  venues,
  activeVenueId,
  onVenueChange,
  onAddConnection,
  onSwitchVenue,
  onDisconnectVenue
}: {
  venue: ExecutionVenue;
  venues: ExecutionVenue[];
  activeVenueId: string;
  onVenueChange: (venueId: string) => void;
  onAddConnection: () => void;
  onSwitchVenue: () => void;
  onDisconnectVenue: () => void;
}) {
  const [mode, setMode] = useState<TradeMode>("spot");
  const [side, setSide] = useState<ExecutionSide>("buy");
  const [orderType, setOrderType] = useState<TicketOrderType>("limit");
  const [marginEnabled, setMarginEnabled] = useState(false);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [leverage, setLeverage] = useState(5);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [orderValue, setOrderValue] = useState("");
  const [sizePercent, setSizePercent] = useState(0);
  const [takeProfitStopLoss, setTakeProfitStopLoss] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [timeInForce, setTimeInForce] = useState<"gtc" | "ioc" | "fok">("gtc");
  const [submitStatus, setSubmitStatus] = useState("");
  const [mainnetValidation, setMainnetValidation] = useState(() => readMainnetValidationMode());
  const [bybitRuntimeStatus, setBybitRuntimeStatus] = useState<BybitRuntimeStatusPayload | null>(null);

  const isDex = venue.kind === "dex";
  const isProtocol = venue.category === "protocol";
  const isBybit = venue.category === "centralized-exchange" && venue.exchange === "bybit" && Boolean(venue.accountId);
  const executionReady = !isProtocol || venue.executionReady === true;
  const mainnetReadiness = useMemo(() => validateMainnetOrderReadiness(venue), [venue, mainnetValidation]);
  const supportsSpot = !isDex || venue.capabilities.includes("spot-orders") || venue.capabilities.includes("market-orders");
  const supportsConvert = !isDex || venue.capabilities.includes("swap");
  const supportsFutures = venue.capabilities.includes("perpetual-orders") || venue.capabilities.includes("leverage");
  const modeSupported = (item: TradeMode) => {
    if (item === "spot") return supportsSpot;
    if (item === "convert") return supportsConvert;
    return supportsFutures;
  };
  const selectedMode = modeSupported(mode) ? mode : supportsSpot ? "spot" : supportsConvert ? "convert" : supportsFutures ? "futures" : "spot";

  useEffect(() => {
    if (!modeSupported(mode)) setMode(supportsSpot ? "spot" : supportsConvert ? "convert" : supportsFutures ? "futures" : "spot");
  }, [mode, supportsSpot, supportsConvert, supportsFutures]);

  const submitLabel = selectedMode === "convert"
    ? "Preview Convert"
    : side === "buy"
      ? selectedMode === "futures" ? "Long" : "Buy"
      : selectedMode === "futures" ? "Short" : "Sell";

  async function runDiagnostics() {
    const items = [
      `MODE ${String(venue.executionMode || "unknown").toUpperCase()}`,
      `READY ${String(venue.readiness || (executionReady ? "execution-ready" : "execution-blocked")).toUpperCase()}`,
      `AUTH ${venue.health.authentication.toUpperCase()}`,
      `STREAM ${venue.health.privateStream.toUpperCase()}`,
      `TRADING ${venue.health.permissions.trading ? "YES" : "NO"}`,
      venue.limitations?.[0] ? `LIMIT ${venue.limitations[0]}` : ""
    ].filter(Boolean);
    setSubmitStatus(items.join(" | "));

    if (venue.category !== "centralized-exchange" || !venue.accountId) return;

    try {
      setSubmitStatus("RUNNING SERVER DIAGNOSTICS");
      const diagnostics = await runExchangeAccountDiagnosticsViaApi(venue.accountId);
      if (!diagnostics) {
        setSubmitStatus("SUPABASE SESSION REQUIRED FOR SERVER DIAGNOSTICS");
        return;
      }
      setSubmitStatus([        
        `READY ${diagnostics.readiness.toUpperCase()}`,
        `LATENCY ${diagnostics.latencyMs}MS`,
        `CLOCK ${diagnostics.time?.clockSkewMs ?? "?"}MS`,
        `BAL ${diagnostics.balances?.length ?? 0}`,
        `POS ${diagnostics.positions?.length ?? 0}`,
        `ORD ${diagnostics.openOrders?.length ?? 0}`,
        diagnostics.permissions.warnings[0] || ""
      ].filter(Boolean).join(" | "));
      if (venue.exchange === "bybit" && venue.accountId) {
        await refreshBybitRuntimeStatus();
      }
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  async function refreshBybitRuntimeStatus() {
    if (!venue.accountId) return;
    try {
      const status = await getBybitRuntimeStatusViaApi(venue.accountId);
      setBybitRuntimeStatus(status);
      if (status) {
        setSubmitStatus(status.readiness.executionReady
          ? "BYBIT RUNTIME READY FOR CONTROLLED VALIDATION"
          : status.readiness.readinessReason.toUpperCase());
      }
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message.toUpperCase() : String(error));
    }
  }

  async function handleSubmitOrder() {
    setSubmitStatus("");

    if (isProtocol && !executionReady) {
      setSubmitStatus((venue.readinessReason || "HYPERLIQUID RELAY IS NOT READY").toUpperCase());
      return;
    }
    if (isProtocol && !mainnetReadiness.allowed) {
      setSubmitStatus((mainnetReadiness.reason || "MAINNET VALIDATION BLOCKED").toUpperCase());
      return;
    }

    if (venue.kind === "dex" && !isProtocol) {
      setSubmitStatus(isProtocol
        ? `${venue.label.toUpperCase()} CONNECTED. LIVE ORDERS REQUIRE SERVER-SIDE SIGNING RELAY.`
        : venue.capabilities.includes("swap")
        ? "DEX QUOTE / SIGN FLOW IS NEXT"
        : "WALLET CONNECTED. EXECUTION REQUIRES A DEX ROUTING ADAPTER.");
      return;
    }

    if (!venue.accountId || !venue.exchange) {
      setSubmitStatus("NO BROKER ACCOUNT SELECTED");
      return;
    }
    const accountId = venue.accountId;
    const exchange = venue.exchange;

    const parsedQuantity = Number(quantity || orderValue || 0);
    const parsedPrice = Number(price || 0);
    if (!parsedQuantity || parsedQuantity <= 0) {
      setSubmitStatus("ENTER QUANTITY OR ORDER VALUE");
      return;
    }

    try {
      const draft: PortfolioOrderDraft = {
        accountId,
        exchange,
        symbol: "BTCUSDT",
        marketKind: selectedMode === "spot" ? "spot" : "perpetual",
        side,
        orderType: orderType === "tpSl" ? "stop-limit" : orderType,
        quantity: parsedQuantity,
        quantityMode: orderValue ? "usd" : "quantity",
        sizingMethod: orderValue ? "usd" : "quantity",
        referencePrice: parsedPrice || undefined,
        limitPrice: orderType === "limit" ? parsedPrice : undefined,
        leverage: selectedMode === "futures" ? leverage : undefined,
        marginMode: selectedMode === "futures" ? marginMode : undefined,
        postOnly,
        reduceOnly,
        timeInForce,
        mainnetConfirmed: mainnetReadiness.mainnet && mainnetReadiness.allowed,
        liveConfirmation: mainnetReadiness.mainnet && mainnetReadiness.allowed ? MAINNET_ORDER_CONFIRMATION : undefined
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
            referencePrice: draft.referencePrice,
            limitPrice: draft.limitPrice,
            stopPrice: draft.stopPrice,
            takeProfit: draft.takeProfit,
            stopLoss: draft.stopLoss,
            leverage: draft.leverage,
            marginMode: draft.marginMode,
            postOnly: draft.postOnly,
            reduceOnly: draft.reduceOnly,
            timeInForce: draft.timeInForce,
            source: "order-ticket",
            destinations: ["personal-portfolio"]
          }, buildVenueExecutionAccount(venue), parsedPrice || 1);

      setSubmitStatus(update ? `${update.status.toUpperCase()}: ${update.reason || update.orderId}` : "NO SUPABASE SESSION");
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="execution-dock">
      <div className="execution-head">
        <div>
          <span>Trade</span>
          <b>{venue.network ? `${venue.label} ${venue.network.toUpperCase()}` : venue.label}</b>
        </div>
        <button onClick={onAddConnection}><Plus size={14} /></button>
      </div>

      <div className="execution-connection-actions">
        <button onClick={onSwitchVenue}>Switch</button>
        <button className="danger" onClick={onDisconnectVenue}>Disconnect</button>
        <button className="wide" onClick={runDiagnostics}>Run Diagnostics</button>
      </div>

      <select className="execution-venue-select" value={activeVenueId} onChange={(event) => onVenueChange(event.target.value)}>
        {venues.map((item) => (
          <option key={item.id} value={item.id}>{item.label} / {item.detail}</option>
        ))}
      </select>

      <div className="execution-diagnostics-strip">
        <span>Status <b>{venue.health.status.toUpperCase()}</b></span>
        <span>Latency <b>{venue.health.latencyMs}ms</b></span>
        <span>Auth <b>{venue.health.authentication.toUpperCase()}</b></span>
        <span>Heartbeat <b>{venue.health.heartbeat.toUpperCase()}</b></span>
        <span>Mode <b>{String(venue.executionMode || "UNKNOWN").replace(/-/g, " ").toUpperCase()}</b></span>
        <span>Ready <b>{String(venue.readiness || (executionReady ? "execution-ready" : "execution-blocked")).replace(/-/g, " ").toUpperCase()}</b></span>
        {isProtocol && <span>Relay <b>{executionReady ? "READY" : "BLOCKED"}</b></span>}
        <span>Subs <b>{venue.health.subscriptionCount}</b></span>
        <span>Reconnects <b>{venue.health.reconnectCount}</b></span>
        {venue.health.permissions.withdrawal && <em>WITHDRAWAL API PERMISSION DETECTED. USE TRADING-ONLY KEYS.</em>}
      </div>

      {(isBybit || (mainnetReadiness.mainnet && !isBybit)) && (
        <details className="connection-runtime-panel">
          <summary>Runtime &amp; Certification</summary>
          {isBybit && (
            <div className={bybitRuntimeStatus?.readiness.executionReady ? "bybit-cert-panel ready" : "bybit-cert-panel"}>
              <div className="bybit-cert-head">
                <span>Bybit Certification</span>
                <b>{bybitRuntimeStatus?.certification.decision || "NOT CHECKED"}</b>
              </div>
              <div className="bybit-cert-grid">
                <span>Worker <b>{bybitRuntimeStatus?.runtime.privateStreamAuthenticated ? "AUTH" : "BLOCKED"}</b></span>
                <span>Clock <b>{bybitRuntimeStatus?.runtime.clockSkewMs ?? "?"}ms</b></span>
                <span>Allowlist <b>{bybitRuntimeStatus?.safety.accountAllowlisted ? "YES" : "NO"}</b></span>
                <span>Max Notional <b>{bybitRuntimeStatus?.safety.maxNotionalUsd || "?"}</b></span>
              </div>
              {bybitRuntimeStatus?.readiness.blockers?.[0] && <p>{bybitRuntimeStatus.readiness.blockers[0]}</p>}
              <div className="bybit-cert-actions">
                <button type="button" onClick={refreshBybitRuntimeStatus}>Refresh Runtime Status</button>
                <button type="button" onClick={runDiagnostics}>Run Pre-flight</button>
              </div>
            </div>
          )}
          {mainnetReadiness.mainnet && !isBybit && (
            <div className={mainnetValidation.enabled ? "mainnet-validation-panel active compact" : "mainnet-validation-panel compact"}>
              <div><span>Protocol Mainnet Validation</span><b>{mainnetValidation.enabled ? "ENABLED" : "OFF"}</b></div>
              <button type="button" onClick={() => setMainnetValidation(mainnetValidation.enabled ? disableMainnetValidationMode() : promptEnableMainnetValidationMode())}>{mainnetValidation.enabled ? "Disable" : "Enable"}</button>
            </div>
          )}
        </details>
      )}

      <div className="execution-mode-row">
        {(["spot", "convert", "futures"] as TradeMode[]).map((item) => (
          <button
            key={item}
            className={selectedMode === item ? "active" : ""}
            disabled={!modeSupported(item)}
            title={!modeSupported(item) ? capabilityReason(item, venue) : undefined}
            onClick={() => setMode(item)}
          >
            {item.toUpperCase()}
          </button>
        ))}
        <label className={marginEnabled ? "execution-switch active" : "execution-switch"}>
          <input type="checkbox" checked={marginEnabled} onChange={(event) => setMarginEnabled(event.target.checked)} />
          Margin
        </label>
      </div>
      {isDex && (!supportsSpot || !supportsConvert || !supportsFutures) && (
        <div className="execution-capability-note">
          {venue.capabilities.length > 0
            ? venue.unsupportedReason || "This connection only enables features advertised by its adapter."
            : "No executable trading capabilities reported by this connection."}
        </div>
      )}
      {isProtocol && venue.readinessReason && !executionReady && (
        <div className="execution-capability-note">{venue.readinessReason}</div>
      )}

      {selectedMode === "futures" && (
        <div className="execution-futures-box">
          <div className="execution-leverage-line">
            <span>{marginMode.toUpperCase()}</span>
            <select value={marginMode} onChange={(event) => setMarginMode(event.target.value as "cross" | "isolated")}>
              <option value="cross">Cross</option>
              <option value="isolated">Isolated</option>
            </select>
            <b>{leverage}x</b>
          </div>
          <input type="range" min="1" max="50" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} />
        </div>
      )}

      {selectedMode !== "convert" && (
        <div className="execution-side-row">
          <button className={side === "buy" ? "buy active" : "buy"} onClick={() => setSide("buy")}>
            {selectedMode === "futures" ? "Long" : "Buy"}
          </button>
          <button className={side === "sell" ? "sell active" : "sell"} onClick={() => setSide("sell")}>
            {selectedMode === "futures" ? "Short" : "Sell"}
          </button>
        </div>
      )}

      <div className="execution-order-tabs">
        {(["limit", "market", "tpSl"] as TicketOrderType[]).map((item) => (
          <button key={item} className={orderType === item ? "active" : ""} onClick={() => setOrderType(item)}>
            {item === "tpSl" ? "TP/SL" : item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      <div className="execution-balance">
        <span>Available Balance</span>
        <b>******** USDT</b>
      </div>

      <label className="execution-field">
        <span>{selectedMode === "convert" ? "From" : "Price"}</span>
        <input value={price} disabled={orderType === "market"} onChange={(event) => setPrice(event.target.value)} />
        <b>USDT</b>
      </label>
      <label className="execution-field">
        <span>{selectedMode === "convert" ? "To" : "Quantity"}</span>
        <input value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        <b>{selectedMode === "convert" ? "BTC" : "BTC"}</b>
      </label>

      <div className="execution-slider-row">
        <input type="range" min="0" max="100" step="25" value={sizePercent} onChange={(event) => setSizePercent(Number(event.target.value))} />
        <div><span>0</span><span>{sizePercent}%</span></div>
      </div>

      <label className="execution-field">
        <span>Order Value</span>
        <input value={orderValue} onChange={(event) => setOrderValue(event.target.value)} />
        <b>USDT</b>
      </label>

      <div className="execution-max-line">
        <span>Max. buying amount</span>
        <b>******** BTC</b>
      </div>

      <div className="execution-checks">
        <label><input type="checkbox" checked={takeProfitStopLoss} onChange={(event) => setTakeProfitStopLoss(event.target.checked)} /> TP/SL</label>
        <label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} /> Post-Only</label>
        {selectedMode === "futures" && <label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> Reduce-Only</label>}
        <select value={timeInForce} onChange={(event) => setTimeInForce(event.target.value as "gtc" | "ioc" | "fok")}>
          <option value="gtc">Good-Till-Canceled</option>
          <option value="ioc">IOC</option>
          <option value="fok">FOK</option>
        </select>
      </div>

      {submitStatus && <div className="execution-submit-status">{submitStatus}</div>}
      <button className={side === "buy" ? "execution-submit buy" : "execution-submit sell"} onClick={handleSubmitOrder}>
        {submitLabel}
      </button>
      <div className="execution-fee-line">
        Fee Rate <b>{isDex ? "network + route" : "maker/taker"}</b>
      </div>
    </div>
  );
}

function capabilityReason(mode: TradeMode, venue: ExecutionVenue) {
  if (mode === "futures") {
    return venue.unsupportedReason || "Futures require a perpetual DEX or broker adapter with leverage/perpetual capability.";
  }
  if (mode === "convert") {
    return "Convert requires a DEX swap routing adapter. Wallet signing alone is not enough.";
  }
  return "Spot trading requires an executable broker or DEX routing adapter.";
}

function buildVenueExecutionAccount(venue: ExecutionVenue): PortfolioAccount {
  return {
    id: venue.accountId || venue.id,
    exchange: (venue.exchange || venue.provider) as ExchangeId,
    label: venue.label,
    accountName: venue.label,
    permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
    isPaper: false,
    connectedAt: Date.now(),
    lastValidatedAt: Date.now(),
    status: venue.health.status === "connected" ? "connected" : "degraded",
    apiHealth: venue.executionReady === true || venue.category !== "protocol" ? "healthy" : "warning",
    latencyMs: venue.health.latencyMs,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: 0,
    availableMargin: 0,
    buyingPower: 0,
    leverage: 1,
    dailyPnl: 0,
    monthlyPnl: 0,
    openPositions: 0,
    openOrders: 0,
    riskControls: defaultRiskControls
  };
}

function buildPositionExecutionAccount(position: ManagedPosition): PortfolioAccount {
  return {
    id: position.accountId,
    exchange: position.exchange,
    label: `${position.exchange.toUpperCase()} ${position.symbol}`,
    accountName: `${position.exchange.toUpperCase()} ${position.symbol}`,
    permissions: ["read-account", "read-orders", "read-positions", "place-orders", "cancel-orders", "modify-orders", "withdraw-disabled"],
    isPaper: false,
    connectedAt: position.openedAt,
    lastValidatedAt: Date.now(),
    status: "connected",
    apiHealth: "healthy",
    latencyMs: 0,
    balanceUsd: 0,
    equityUsd: 0,
    marginUsed: position.margin,
    availableMargin: 0,
    buyingPower: 0,
    leverage: position.leverage,
    dailyPnl: position.unrealizedPnl,
    monthlyPnl: 0,
    openPositions: 1,
    openOrders: 0,
    riskControls: defaultRiskControls
  };
}

export default function PortfolioManagerPage({ onClose, currentUser }: { onClose: () => void; currentUser?: CapabilityUser | null }) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PortfolioManagerTab>("Overview");
  const capabilities = useMemo(() => getCapabilities(currentUser), [currentUser]);
  const productTier = resolveProductTier(currentUser);
  const networkGroups = useMemo(() => listInvestmentGroups(currentUser), [currentUser]);
  const canCreateGroup = canCreateInvestmentGroup(currentUser);
  const portfolioTabs = useMemo<PortfolioManagerTab[]>(() => {
    const tabs: PortfolioManagerTab[] = ["Overview", "Performance", "Risk", "Investment Groups"];
    if (capabilities.has("portfolio.enterpriseCapital")) {
      tabs.push("Managed Capital", "Followers", "Execution Matrix", "Audit", "Permissions");
    }
    return tabs;
  }, [capabilities]);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      const next = await getPortfolioSnapshot();
      if (alive) setSnapshot(next);
    };

    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!portfolioTabs.includes(activeTab)) setActiveTab("Overview");
  }, [activeTab, portfolioTabs]);

  if (!snapshot) return <div className="portfolio-manager loading">LOADING PORTFOLIO MANAGER</div>;

  const { summary } = snapshot;
  const hasPortfolioData = snapshot.accounts.length > 0 || snapshot.balances.length > 0 || snapshot.positions.length > 0 || snapshot.orders.length > 0;
  const retailMetrics = [
    ["Total Equity", money.format(summary.totalEquity)],
    ["Daily Return", money.format(summary.dailyPnl)],
    ["Weekly Return", money.format(summary.weeklyPnl)],
    ["Monthly Return", money.format(summary.monthlyPnl)],
    ["Yearly Return", "AWAITING HISTORY"],
    ["Drawdown", `${summary.drawdownPct}%`],
    ["Unrealized PnL", money.format(summary.unrealizedPnl)],
    ["Realized PnL", money.format(summary.realizedPnl)],
    ["Margin Used", money.format(summary.marginUsed)],
    ["Available Margin", money.format(summary.availableMargin)],
    ["Buying Power", money.format(summary.buyingPower)],
    ["Risk Score", `${summary.riskScore}/100`]
  ];

  return (
    <div className="portfolio-manager">
      <header className="pm-header">
        <div>
          <span>PORTFOLIO MANAGER</span>
          <strong>{productTier.toUpperCase()} capital management and performance analytics</strong>
        </div>
        <div className="pm-actions">
          <button onClick={onClose}><X size={14} /></button>
        </div>
      </header>

      <nav className="pm-tabs">
        {portfolioTabs.map((tab) => (
          <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === "Overview" && (
        <section className="pm-workspace">
          <div className="pm-metrics">
            {retailMetrics.map(([label, value]) => (
              <div className="pm-metric" key={label}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
          {!hasPortfolioData && (
            <div className="pm-empty">
              NO LIVE PORTFOLIO DATA CONNECTED. LINK A BROKER ACCOUNT OR WALLET TO START SYNCING BALANCES, POSITIONS, ORDERS, AND RISK.
            </div>
          )}
          <div className="pm-chart-grid">
            <MiniCurve title="Equity Curve" points={snapshot.curves.equity} icon={CircleDollarSign} />
            <MiniCurve title="Drawdown Curve" points={snapshot.curves.drawdown} icon={AlertTriangle} />
            <MiniCurve title="Daily Returns" points={snapshot.curves.dailyReturns} icon={Activity} />
            <div className="pm-panel">
              <div className="pm-panel-title"><Layers3 size={15} /> Portfolio Exposure</div>
              {snapshot.curves.exposure.length > 0 ? (
                snapshot.curves.exposure.map((item) => (
                  <div className="pm-exposure" key={item.label}>
                    <span>{item.label}</span>
                    <i><b style={{ width: `${item.value}%` }} /></i>
                    <em>{item.value}%</em>
                  </div>
                ))
              ) : (
                <div className="pm-panel-empty">AWAITING LIVE EXPOSURE DATA</div>
              )}
            </div>
          </div>
        </section>
      )}

      {activeTab === "Performance" && (
        <section className="pm-workspace">
          <div className="pm-panel">
            <div className="pm-panel-title"><Activity size={15} /> Trade Analytics</div>
            <div className="pm-panel-empty">AWAITING LIVE ORDER HISTORY, FILLS, WIN RATE, EXPECTANCY, AND SESSION PERFORMANCE.</div>
          </div>
          <div className="pm-panel">
            <div className="pm-panel-title"><CircleDollarSign size={15} /> Performance Statistics</div>
            <div className="pm-panel-empty">EQUITY HISTORY WILL POPULATE AFTER SYNCHRONIZED PORTFOLIO SNAPSHOTS ARE AVAILABLE.</div>
          </div>
        </section>
      )}

      {activeTab === "Risk" && (
        <section className="pm-workspace split">
          <div className="pm-panel">
            <div className="pm-panel-title"><ShieldCheck size={15} /> Risk Statistics</div>
            <div className="pm-risk-list">
              <span>Risk Score <b>{summary.riskScore}/100</b></span>
              <span>Drawdown <b>{summary.drawdownPct}%</b></span>
              <span>Leverage <b>{compact.format(summary.leverage)}x</b></span>
              <span>Margin Used <b>{money.format(summary.marginUsed)}</b></span>
            </div>
          </div>
          <div className="pm-panel">
            <div className="pm-panel-title"><Layers3 size={15} /> Exposure Controls</div>
            <div className="pm-panel-empty">ENTERPRISE RISK LIMITS ARE ENFORCED SERVER-SIDE BY THE EXECUTION ENGINE.</div>
          </div>
        </section>
      )}

      {activeTab === "Investment Groups" && (
        <section className="pm-workspace">
          <div className="pm-panel">
            <div className="pm-panel-title"><Layers3 size={15} /> Investment Group Discovery</div>
            {networkGroups.myGroups.length === 0 && networkGroups.publicGroups.length === 0 ? (
              <div className="pm-panel-empty">NO VERIFIED INVESTMENT GROUPS ARE PUBLISHED YET. DISCOVERY WILL SHOW HISTORICAL PERFORMANCE, DRAWDOWN, FOLLOWERS, RISK SCORE, AUM, AND SUPPORTED EXCHANGES.</div>
            ) : (
              <div className="pm-table">
                <div className="pm-table-head">
                  <span>GROUP</span>
                  <span>ROLE</span>
                  <span>VISIBILITY</span>
                  <span>FOLLOWERS</span>
                  <span>VERIFICATION</span>
                </div>
                {[...new Map([...networkGroups.myGroups, ...networkGroups.publicGroups].map((group) => [group.id, group])).values()].map((group) => (
                  <div className="pm-table-row" key={group.id}>
                    <span>{group.firmName}</span>
                    <b>{group.ownerUsername === currentUser?.username ? "OWNER" : "DISCOVERY"}</b>
                    <span>{group.visibility.toUpperCase()}</span>
                    <span>{group.stats.followerCount}</span>
                    <em>{group.stats.verified ? "VERIFIED" : "UNVERIFIED"}</em>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pm-panel">
            <div className="pm-panel-title"><ShieldCheck size={15} /> Role-Based Group Tools</div>
            <div className="pm-risk-list">
              <span>Account Tier <b>{productTier.toUpperCase()}</b></span>
              <span>Create Groups <b>{canCreateGroup ? "ENABLED" : "ENTERPRISE / ADMIN ONLY"}</b></span>
              <span>Capital Control <b>{capabilities.has("can_view_enterprise_portfolio_tools") ? "ENTERPRISE TOOLS" : "NOT AVAILABLE"}</b></span>
              <span>Retail Mode <b>PERSONAL STATS AND JOINED GROUPS ONLY</b></span>
            </div>
          </div>
        </section>
      )}

      {activeTab === "Managed Capital" && (
        <EnterprisePanel icon={CircleDollarSign} title="Managed Capital" message="CAPITAL ALLOCATION PROFILES, MANAGED AUM, AND GROUP-LEVEL EQUITY CONTROLS REQUIRE ENTERPRISE PERMISSIONS AND SERVER-SIDE POLICY TABLES." />
      )}

      {activeTab === "Followers" && (
        <EnterprisePanel icon={Copy} title="Followers" message="NO MANAGED FOLLOWERS CONNECTED. FOLLOWER ACCOUNTS ARE CAPITAL-MANAGEMENT ENTITIES, NOT BROKER CONNECTIONS." />
      )}

      {activeTab === "Execution Matrix" && (
        <EnterprisePanel icon={ShieldCheck} title="Execution Matrix" message="THE EXECUTION MATRIX WILL CONSUME CAPITAL ALLOCATION RULES AND ROUTE ORDERS THROUGH POSITIONS / EXECUTION ENGINE ONLY." />
      )}

      {activeTab === "Audit" && (
        <EnterprisePanel icon={Activity} title="Audit" message="EXECUTION, ALLOCATION, PERMISSION, AND INVESTMENT GROUP EVENTS WILL STREAM HERE FROM SERVER-SIDE AUDIT LOGS." />
      )}

      {activeTab === "Permissions" && (
        <EnterprisePanel icon={ShieldCheck} title="Permissions" message="PERMISSION MANAGEMENT IS AVAILABLE ONLY TO ENTERPRISE OR ADMIN ACCOUNTS AND MUST BE ENFORCED BY SERVER AUTHORIZATION." />
      )}
    </div>
  );
}

function EnterprisePanel({ title, message, icon: Icon }: { title: string; message: string; icon: typeof Activity }) {
  return (
    <section className="pm-workspace">
      <div className="pm-panel">
        <div className="pm-panel-title"><Icon size={15} /> {title}</div>
        <div className="pm-panel-empty">{message}</div>
      </div>
    </section>
  );
}

function MiniCurve({ title, points, icon: Icon }: { title: string; points: { time: string; value: number }[]; icon: typeof Activity }) {
  if (points.length === 0) {
    return (
      <div className="pm-panel">
        <div className="pm-panel-title"><Icon size={15} /> {title}</div>
        <div className="pm-panel-empty">AWAITING LIVE DATA</div>
      </div>
    );
  }

  const max = Math.max(...points.map((point) => point.value));
  return (
    <div className="pm-panel">
      <div className="pm-panel-title"><Icon size={15} /> {title}</div>
      <div className="pm-bars">
        {points.map((point) => (
          <i key={point.time} style={{ height: `${Math.max(8, (point.value / max) * 86)}%` }} title={`${point.time}: ${point.value}`} />
        ))}
      </div>
    </div>
  );
}
