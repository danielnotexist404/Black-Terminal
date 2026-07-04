import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  KeyRound,
  Layers3,
  Play,
  Plus,
  ShieldCheck,
  X
} from "lucide-react";
import { buildExecutionMatrix } from "../../../copyTrading/allocationEngine";
import type { CopyTradingFollower } from "../../../copyTrading/types";
import { submitPortfolioOrderViaApi } from "../../../portfolio/portfolioApiClient";
import type { ExchangeConnectionDraft, PortfolioSnapshot } from "../../../portfolio/types";
import { connectExchangeAccount, getPortfolioSnapshot } from "../../../portfolio/portfolioStore";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { ExchangeId } from "../../../market-data/types";
import type { OrderTicketDraft } from "../../../orders/types";
import type { PortfolioPosition } from "../../../positions/types";

type PortfolioManagerTab = "Overview" | "Accounts" | "Copy Trading" | "Orders";
type VenueKind = "cex" | "dex";
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

const defaultTicket: OrderTicketDraft = {
  orderType: "market",
  side: "buy",
  symbol: "BTCUSDT",
  quantityMode: "usd",
  quantity: 5000,
  postOnly: false,
  reduceOnly: false,
  timeInForce: "gtc"
};

const dexVenues: Array<{ id: DexVenueId; label: string; chain: string; defaultProvider: WalletProviderId }> = [
  { id: "uniswap", label: "Uniswap", chain: "Ethereum", defaultProvider: "metamask" },
  { id: "jupiter", label: "Jupiter", chain: "Solana", defaultProvider: "phantom" },
  { id: "raydium", label: "Raydium", chain: "Solana", defaultProvider: "phantom" },
  { id: "pancakeswap", label: "PancakeSwap", chain: "BNB Chain", defaultProvider: "metamask" }
];

const walletLinksStorageKey = "bt_wallet_links_v1";
const brokerLinksStorageKey = "bt_broker_links_v1";
const activeExecutionVenueStorageKey = "bt_active_execution_venue_v1";

const followersSeed: CopyTradingFollower[] = [
  {
    id: "follower-01",
    displayName: "Atlas Follower 01",
    status: "active",
    equity: 48_250,
    dailyPnl: 312,
    monthlyPnl: 1_904,
    connectedExchange: "bybit",
    positions: [],
    drawdownPct: 1.8,
    allocationProfile: { id: "ap-01", name: "Risk 1%", method: "riskPercentage", value: 1, maxExposureUsd: 12_000 },
    connectionHealth: "healthy"
  },
  {
    id: "follower-02",
    displayName: "Momentum Vault",
    status: "paused",
    equity: 112_800,
    dailyPnl: -84,
    monthlyPnl: 3_180,
    connectedExchange: "binance",
    positions: [],
    drawdownPct: 2.4,
    allocationProfile: { id: "ap-02", name: "Equity 4%", method: "equityPercentage", value: 4, maxExposureUsd: 20_000 },
    connectionHealth: "warning"
  }
];

export function PortfolioPositionsPanel({ positions }: { positions: PortfolioPosition[] }) {
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
        <div className="pm-table-row pm-positions-grid" key={position.id}>
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
    const [kind, id] = value.split(":") as [VenueKind, string];
    setVenueKind(kind);
    setConnectStatus("");

    if (kind === "cex") {
      setSelectedCex(id as ExchangeId);
      setConnection((current) => ({ ...current, exchange: id as ExchangeId }));
      return;
    }

    const dex = dexVenues.find((venue) => venue.id === id) ?? dexVenues[0];
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
                  <option key={venue.id} value={`dex:${venue.id}`}>{venue.label}</option>
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
  const [price, setPrice] = useState("62551.2");
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

export default function PortfolioManagerPage({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PortfolioManagerTab>("Overview");
  const [showTicket, setShowTicket] = useState(false);
  const [ticket, setTicket] = useState<OrderTicketDraft>(defaultTicket);

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

  const executionMatrix = useMemo(() => buildExecutionMatrix(followersSeed, ticket, 66_610), [ticket]);

  if (!snapshot) return <div className="portfolio-manager loading">LOADING PORTFOLIO MANAGER</div>;

  const { summary } = snapshot;

  return (
    <div className="portfolio-manager">
      <header className="pm-header">
        <div>
          <span>PORTFOLIO MANAGER</span>
          <strong>Execution, risk, accounts, and copy allocation</strong>
        </div>
        <div className="pm-actions">
          <button onClick={() => setShowTicket(true)}><Play size={14} /> Order Ticket</button>
          <button onClick={onClose}><X size={14} /></button>
        </div>
      </header>

      <nav className="pm-tabs">
        {(["Overview", "Accounts", "Copy Trading", "Orders"] as PortfolioManagerTab[]).map((tab) => (
          <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === "Overview" && (
        <section className="pm-workspace">
          <div className="pm-metrics">
            {[
              ["Total Equity", money.format(summary.totalEquity)],
              ["Total Balance", money.format(summary.totalBalance)],
              ["Unrealized PnL", money.format(summary.unrealizedPnl)],
              ["Realized PnL", money.format(summary.realizedPnl)],
              ["Daily PnL", money.format(summary.dailyPnl)],
              ["Weekly PnL", money.format(summary.weeklyPnl)],
              ["Monthly PnL", money.format(summary.monthlyPnl)],
              ["Drawdown", `${summary.drawdownPct}%`],
              ["Margin Used", money.format(summary.marginUsed)],
              ["Available Margin", money.format(summary.availableMargin)],
              ["Buying Power", money.format(summary.buyingPower)],
              ["Risk Score", `${summary.riskScore}/100`]
            ].map(([label, value]) => (
              <div className="pm-metric" key={label}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
          <div className="pm-chart-grid">
            <MiniCurve title="Equity Curve" points={snapshot.curves.equity} icon={CircleDollarSign} />
            <MiniCurve title="Drawdown Curve" points={snapshot.curves.drawdown} icon={AlertTriangle} />
            <MiniCurve title="Daily Returns" points={snapshot.curves.dailyReturns} icon={Activity} />
            <div className="pm-panel">
              <div className="pm-panel-title"><Layers3 size={15} /> Portfolio Exposure</div>
              {snapshot.curves.exposure.map((item) => (
                <div className="pm-exposure" key={item.label}>
                  <span>{item.label}</span>
                  <i><b style={{ width: `${item.value}%` }} /></i>
                  <em>{item.value}%</em>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {activeTab === "Accounts" && (
        <section className="pm-workspace">
          <div className="pm-table-head pm-account-grid">
            <span>Exchange</span><span>Account</span><span>Status</span><span>API</span><span>Latency</span><span>Balance</span><span>Equity</span><span>Margin</span><span>Positions</span><span>Orders</span>
          </div>
          {snapshot.accounts.map((account) => (
            <div className="pm-table-row pm-account-grid" key={account.id}>
              <b>{account.exchange.toUpperCase()}</b>
              <span>{account.accountName}</span>
              <span>{account.status}</span>
              <span className={account.apiHealth === "healthy" ? "green" : "red"}>{account.apiHealth}</span>
              <span>{account.latencyMs}ms</span>
              <span>{money.format(account.balanceUsd)}</span>
              <span>{money.format(account.equityUsd)}</span>
              <span>{money.format(account.marginUsed)}</span>
              <span>{account.openPositions}</span>
              <span>{account.openOrders}</span>
            </div>
          ))}
        </section>
      )}

      {activeTab === "Copy Trading" && (
        <section className="pm-workspace split">
          <div className="pm-panel">
            <div className="pm-panel-title"><Copy size={15} /> Authorized Followers</div>
            {followersSeed.map((follower) => (
              <div className="pm-follower" key={follower.id}>
                <b>{follower.displayName}</b>
                <span>{follower.connectedExchange.toUpperCase()} / {follower.allocationProfile.name}</span>
                <em className={follower.status === "active" ? "green" : "red"}>{follower.status}</em>
                <strong>{money.format(follower.equity)}</strong>
              </div>
            ))}
          </div>
          <div className="pm-panel">
            <div className="pm-panel-title"><ShieldCheck size={15} /> Execution Matrix</div>
            {executionMatrix.map((row) => (
              <div className="pm-matrix-row" key={row.accountId}>
                <span>{row.accountName}</span>
                <b>{row.exchange.toUpperCase()}</b>
                <span>{row.allocationMethod}</span>
                <strong>{compact.format(row.calculatedQuantity)}</strong>
                <em>{money.format(row.estimatedExposure)}</em>
                {row.riskCheck.status === "approved" ? <CheckCircle2 className="green" size={15} /> : <AlertTriangle className="red" size={15} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "Orders" && (
        <section className="pm-workspace">
          <div className="pm-empty">OPEN, FILLED, CANCELLED, REJECTED, AND PENDING ORDERS WILL STREAM THROUGH THE EXECUTION ENGINE.</div>
        </section>
      )}
      {showTicket && (
        <div className="pm-floating">
          <div className="pm-ticket">
            <div className="pm-ticket-head"><Play size={15} /> Institutional Order Ticket <button onClick={() => setShowTicket(false)}><X size={14} /></button></div>
            <select value={ticket.orderType} onChange={(event) => setTicket((current) => ({ ...current, orderType: event.target.value as OrderTicketDraft["orderType"] }))}>
              {["market", "limit", "stop-market", "stop-limit", "bracket", "twap", "iceberg"].map((type) => <option key={type}>{type}</option>)}
            </select>
            <div className="pm-segment">
              <button className={ticket.side === "buy" ? "active" : ""} onClick={() => setTicket((current) => ({ ...current, side: "buy" }))}>BUY</button>
              <button className={ticket.side === "sell" ? "active" : ""} onClick={() => setTicket((current) => ({ ...current, side: "sell" }))}>SELL</button>
            </div>
            <input value={ticket.symbol} onChange={(event) => setTicket((current) => ({ ...current, symbol: event.target.value.toUpperCase() }))} />
            <input type="number" value={ticket.quantity} onChange={(event) => setTicket((current) => ({ ...current, quantity: Number(event.target.value) }))} />
            <label><input type="checkbox" checked={ticket.postOnly} onChange={(event) => setTicket((current) => ({ ...current, postOnly: event.target.checked }))} /> Post Only</label>
            <label><input type="checkbox" checked={ticket.reduceOnly} onChange={(event) => setTicket((current) => ({ ...current, reduceOnly: event.target.checked }))} /> Reduce Only</label>
            <div className="pm-estimates">
              <span>Fees {money.format(ticket.quantity * 0.0004)}</span>
              <span>Margin {money.format(ticket.quantity / 5)}</span>
              <span>Slippage 0.03%</span>
            </div>
            <button className="primary">Confirm Through Execution Engine</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniCurve({ title, points, icon: Icon }: { title: string; points: { time: string; value: number }[]; icon: typeof Activity }) {
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
