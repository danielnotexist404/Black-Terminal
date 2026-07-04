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
import { submitPortfolioOrderViaApi } from "../../../portfolio/portfolioApiClient";
import type { ExchangeConnectionDraft, PortfolioSnapshot } from "../../../portfolio/types";
import { connectExchangeAccount, getPortfolioSnapshot } from "../../../portfolio/portfolioStore";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { ExchangeId } from "../../../market-data/types";
import type { PortfolioPosition } from "../../../positions/types";

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
type DexVenueId = "uniswap" | "jupiter" | "raydium" | "pancakeswap";
type WalletProviderId = "metamask" | "phantom";
type TradeMode = "spot" | "convert" | "futures";
type ExecutionSide = "buy" | "sell";
type TicketOrderType = "limit" | "market" | "tpSl";

type BrokerLink = {
  id: string;
  accountId: string;
  exchange: ExchangeId;
  accountName: string;
  status: "read-only" | "connected";
  linkedAt: number;
};

type ExecutionVenue = {
  id: string;
  kind: VenueKind;
  label: string;
  detail: string;
  accountId?: string;
  exchange?: ExchangeId;
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

type WalletLink = {
  id: string;
  venue: DexVenueId;
  provider: WalletProviderId;
  address: string;
  chain: string;
  linkedAt: number;
};

const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const dexVenues: Array<{ id: DexVenueId; label: string; chain: string; defaultProvider: WalletProviderId }> = [
  { id: "uniswap", label: "Uniswap", chain: "Ethereum", defaultProvider: "metamask" },
  { id: "jupiter", label: "Jupiter", chain: "Solana", defaultProvider: "phantom" },
  { id: "raydium", label: "Raydium", chain: "Solana", defaultProvider: "phantom" },
  { id: "pancakeswap", label: "PancakeSwap", chain: "BNB Chain", defaultProvider: "metamask" }
];

const walletProviders: Array<{ id: WalletProviderId; label: string; chainHint: string; defaultDex: DexVenueId }> = [
  { id: "metamask", label: "MetaMask", chainHint: "Ethereum / BNB Chain", defaultDex: "uniswap" },
  { id: "phantom", label: "Phantom", chainHint: "Solana", defaultDex: "jupiter" }
];

const walletLinksStorageKey = "bt_wallet_links_v1";
const brokerLinksStorageKey = "bt_broker_links_v1";
const activeExecutionVenueStorageKey = "bt_active_execution_venue_v1";

export function PortfolioPositionsPanel({ positions }: { positions: PortfolioPosition[] }) {
  const [positionMenu, setPositionMenu] = useState<{ x: number; y: number; position: PortfolioPosition } | null>(null);
  const [positionActionStatus, setPositionActionStatus] = useState("");

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

  function openPositionMenu(event: MouseEvent<HTMLDivElement>, position: PortfolioPosition) {
    event.preventDefault();
    event.stopPropagation();
    setPositionMenu({ x: event.clientX, y: event.clientY, position });
  }

  async function submitPositionAction(
    position: PortfolioPosition,
    action: "close" | "reverse" | "takeProfit" | "stopLoss" | "bracket"
  ) {
    const exitSide = position.direction === "long" ? "sell" : "buy";
    const referencePrice = position.currentPrice || position.averagePrice;
    setPositionMenu(null);
    setPositionActionStatus("SUBMITTING POSITION ACTION");

    const submitOrder = async (draft: Parameters<typeof submitPortfolioOrderViaApi>[0]) => {
      const update = await submitPortfolioOrderViaApi(draft);
      if (!update) throw new Error("AUTHENTICATED BROKER SESSION REQUIRED");
      if (update.status === "rejected") throw new Error(update.reason || "ORDER REJECTED");
      return update;
    };

    try {
      if (action === "close") {
        await submitOrder({
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
        setPositionActionStatus(`CLOSE ORDER SUBMITTED FOR ${position.symbol}`);
        return;
      }

      if (action === "reverse") {
        await submitOrder({
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
        await submitOrder({
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
        await submitOrder({
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
      {positions.map((position) => (
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
      {positions.length === 0 && (
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
          <button onClick={() => submitPositionAction(positionMenu.position, "takeProfit")}>Change Take Profit</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "stopLoss")}>Change Stop Loss</button>
          <button onClick={() => submitPositionAction(positionMenu.position, "bracket")}>Change TP/SL Bracket</button>
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
  const [connectStatus, setConnectStatus] = useState("");
  const [brokerLinks, setBrokerLinks] = useState<BrokerLink[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(brokerLinksStorageKey);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [walletLinks, setWalletLinks] = useState<WalletLink[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(walletLinksStorageKey);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [activeVenueId, setActiveVenueId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(activeExecutionVenueStorageKey);
  });

  const executionVenues: ExecutionVenue[] = useMemo(() => [
    ...brokerLinks.map((link) => ({
      id: link.id,
      kind: "cex" as const,
      label: link.accountName,
      detail: `${link.exchange.toUpperCase()} ${link.status.toUpperCase()}`,
      accountId: link.accountId,
      exchange: link.exchange
    })),
    ...walletLinks.map((link) => ({
      id: link.id,
      kind: "dex" as const,
      label: link.venue.toUpperCase(),
      detail: `${link.provider.toUpperCase()} ${link.address.slice(0, 6)}...${link.address.slice(-4)}`
    }))
  ], [brokerLinks, walletLinks]);
  const activeExecutionVenue = executionVenues.find((venue) => venue.id === activeVenueId) ?? executionVenues[0] ?? null;

  useEffect(() => {
    localStorage.setItem(brokerLinksStorageKey, JSON.stringify(brokerLinks));
  }, [brokerLinks]);

  useEffect(() => {
    localStorage.setItem(walletLinksStorageKey, JSON.stringify(walletLinks));
  }, [walletLinks]);

  useEffect(() => {
    if (activeVenueId) {
      localStorage.setItem(activeExecutionVenueStorageKey, activeVenueId);
    } else {
      localStorage.removeItem(activeExecutionVenueStorageKey);
    }
  }, [activeVenueId]);

  useEffect(() => {
    if (!activeVenueId && executionVenues[0]) setActiveVenueId(executionVenues[0].id);
  }, [activeVenueId, executionVenues]);

  const selectedDexVenue = dexVenues.find((venue) => venue.id === selectedDex) ?? dexVenues[0];
  const venueValue = `${venueKind}:${venueKind === "cex" ? selectedCex : selectedDex}`;

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
    const accountName = connection.accountName.trim() || marketCatalog.find((exchange) => exchange.id === selectedCex)?.label || selectedCex;
    if (!connection.apiKey.trim() || !connection.apiSecret.trim()) {
      setConnectStatus("API KEY AND SECRET REQUIRED");
      return;
    }

    const account = await connectExchangeAccount({
      ...connection,
      exchange: selectedCex,
      accountName
    });
    const link: BrokerLink = {
      id: `cex-${account.id}`,
      accountId: account.id,
      exchange: selectedCex,
      accountName,
      status: account.status === "connected" ? "connected" : "read-only",
      linkedAt: Date.now()
    };
    setBrokerLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
    setActiveVenueId(link.id);
    setConnection({ exchange: selectedCex, accountName: "", apiKey: "", apiSecret: "", passphrase: "" });
    setConnectStatus("BROKER LINK STORED");
    setShowConnection(false);
  }

  async function handleConnectDex() {
    try {
      let address = "";
      let chain = selectedDexVenue.chain;

      if (walletProvider === "metamask") {
        const ethereum = (window as any).ethereum;
        if (!ethereum?.request) throw new Error("METAMASK NOT DETECTED");
        const accounts = await ethereum.request({ method: "eth_requestAccounts" });
        const chainId = await ethereum.request({ method: "eth_chainId" });
        address = accounts?.[0] || "";
        chain = chainId || selectedDexVenue.chain;
      } else {
        const solana = (window as any).solana;
        if (!solana?.connect) throw new Error("PHANTOM NOT DETECTED");
        const response = await solana.connect();
        address = response?.publicKey?.toString() || "";
      }

      if (!address) throw new Error("NO WALLET ADDRESS RETURNED");

      const link: WalletLink = {
        id: `dex-${selectedDex}-${address}`,
        venue: selectedDex,
        provider: walletProvider,
        address,
        chain,
        linkedAt: Date.now()
      };
      setWalletLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
      setActiveVenueId(link.id);
      setConnectStatus("WALLET LINKED");
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
    if (activeExecutionVenue.kind === "cex") {
      setBrokerLinks((current) => current.filter((link) => link.id !== activeExecutionVenue.id));
    } else {
      setWalletLinks((current) => current.filter((link) => link.id !== activeExecutionVenue.id));
    }
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
              <b>{brokerLinks.length}</b>
              <span>Wallet Links</span>
              <b>{walletLinks.length}</b>
            </div>
            <div className="positions-wallet-list">
              {walletLinks.map((link) => (
                <div className="positions-wallet-link" key={link.id}>
                  <b>{link.venue.toUpperCase()}</b>
                  <span>{link.provider.toUpperCase()}</span>
                  <em>{link.address.slice(0, 6)}...{link.address.slice(-4)}</em>
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
                {marketCatalog.map((exchange) => (
                  <option key={exchange.id} value={`cex:${exchange.id}`}>{exchange.label}</option>
                ))}
              </optgroup>
              <optgroup label="DEX">
                {dexVenues.map((venue) => (
                  <option key={venue.id} value={`dex:${venue.id}`}>
                    {venue.label} / {venue.defaultProvider === "metamask" ? "MetaMask" : "Phantom"}
                  </option>
                ))}
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
                <input placeholder="Account name" value={connection.accountName} onChange={(event) => setConnection((current) => ({ ...current, accountName: event.target.value }))} />
                <input placeholder="API key" value={connection.apiKey} onChange={(event) => setConnection((current) => ({ ...current, apiKey: event.target.value }))} />
                <input placeholder="API secret" type="password" value={connection.apiSecret} onChange={(event) => setConnection((current) => ({ ...current, apiSecret: event.target.value }))} />
                <input placeholder="Passphrase, if required" type="password" value={connection.passphrase} onChange={(event) => setConnection((current) => ({ ...current, passphrase: event.target.value }))} />
                {connectStatus && <div className="positions-connect-status">{connectStatus}</div>}
                <button className="primary" onClick={handleConnectCex}>Store Secure Reference</button>
              </>
            ) : (
              <>
                <div className="pm-segment">
                  <button className={walletProvider === "metamask" ? "active" : ""} onClick={() => setWalletProvider("metamask")}>MetaMask</button>
                  <button className={walletProvider === "phantom" ? "active" : ""} onClick={() => setWalletProvider("phantom")}>Phantom</button>
                </div>
                <div className="positions-dex-card">
                  <span>{selectedDexVenue.label}</span>
                  <b>{selectedDexVenue.chain}</b>
                </div>
                {connectStatus && <div className="positions-connect-status">{connectStatus}</div>}
                <button className="primary" onClick={handleConnectDex}>Link Wallet</button>
              </>
            )}
          </div>
        </div>
      )}
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

  const isDex = venue.kind === "dex";
  const selectedMode = isDex && mode === "futures" ? "spot" : mode;

  useEffect(() => {
    if (isDex && mode === "futures") setMode("spot");
  }, [isDex, mode]);

  const submitLabel = selectedMode === "convert"
    ? "Preview Convert"
    : side === "buy"
      ? selectedMode === "futures" ? "Long" : "Buy"
      : selectedMode === "futures" ? "Short" : "Sell";

  async function handleSubmitOrder() {
    setSubmitStatus("");

    if (venue.kind === "dex") {
      setSubmitStatus("DEX QUOTE / SIGN FLOW IS NEXT");
      return;
    }

    if (!venue.accountId || !venue.exchange) {
      setSubmitStatus("NO BROKER ACCOUNT SELECTED");
      return;
    }

    const parsedQuantity = Number(quantity || orderValue || 0);
    const parsedPrice = Number(price || 0);
    if (!parsedQuantity || parsedQuantity <= 0) {
      setSubmitStatus("ENTER QUANTITY OR ORDER VALUE");
      return;
    }

    try {
      const update = await submitPortfolioOrderViaApi({
        accountId: venue.accountId,
        exchange: venue.exchange,
        symbol: "BTCUSDT",
        marketKind: selectedMode === "spot" ? "spot" : "perpetual",
        side,
        orderType: orderType === "tpSl" ? "stop-limit" : orderType,
        quantity: parsedQuantity,
        quantityMode: orderValue ? "usd" : "quantity",
        referencePrice: parsedPrice || undefined,
        limitPrice: orderType === "limit" ? parsedPrice : undefined,
        postOnly,
        reduceOnly,
        timeInForce
      });

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
          <b>{venue.label}</b>
        </div>
        <button onClick={onAddConnection}><Plus size={14} /></button>
      </div>

      <div className="execution-connection-actions">
        <button onClick={onSwitchVenue}>Switch</button>
        <button className="danger" onClick={onDisconnectVenue}>Disconnect</button>
      </div>

      <select className="execution-venue-select" value={activeVenueId} onChange={(event) => onVenueChange(event.target.value)}>
        {venues.map((item) => (
          <option key={item.id} value={item.id}>{item.label} / {item.detail}</option>
        ))}
      </select>

      <div className="execution-mode-row">
        {(["spot", "convert", "futures"] as TradeMode[]).map((item) => (
          <button
            key={item}
            className={selectedMode === item ? "active" : ""}
            disabled={isDex && item === "futures"}
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

export default function PortfolioManagerPage({ onClose, currentUser }: { onClose: () => void; currentUser?: CapabilityUser | null }) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PortfolioManagerTab>("Overview");
  const capabilities = useMemo(() => getCapabilities(currentUser), [currentUser]);
  const productTier = resolveProductTier(currentUser);
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
            <div className="pm-panel-empty">NO VERIFIED INVESTMENT GROUPS ARE PUBLISHED YET. DISCOVERY WILL SHOW PERFORMANCE, DRAWDOWN, FOLLOWERS, RISK SCORE, AUM, AND SUPPORTED EXCHANGES.</div>
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
