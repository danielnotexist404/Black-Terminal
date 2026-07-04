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
  Wallet,
  X
} from "lucide-react";
import { buildExecutionMatrix } from "../../../copyTrading/allocationEngine";
import type { CopyTradingFollower } from "../../../copyTrading/types";
import type { ExchangeConnectionDraft, PortfolioSnapshot } from "../../../portfolio/types";
import { connectExchangeAccount, getPortfolioSnapshot } from "../../../portfolio/portfolioStore";
import { marketCatalog } from "../../../market-data/marketCatalog";
import type { ExchangeId } from "../../../market-data/types";
import type { OrderTicketDraft } from "../../../orders/types";
import type { PortfolioPosition } from "../../../positions/types";

type PortfolioTab = "Overview" | "Accounts" | "Copy Trading" | "Orders" | "Positions" | "Wallets";

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

export default function PortfolioManagerPage({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<PortfolioTab>("Overview");
  const [showConnection, setShowConnection] = useState(false);
  const [showTicket, setShowTicket] = useState(false);
  const [ticket, setTicket] = useState<OrderTicketDraft>(defaultTicket);
  const [connection, setConnection] = useState<ExchangeConnectionDraft>({
    exchange: "bybit",
    accountName: "",
    apiKey: "",
    apiSecret: "",
    passphrase: ""
  });

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

  async function handleConnectAccount() {
    if (!connection.accountName.trim() || !connection.apiKey.trim() || !connection.apiSecret.trim()) return;
    await connectExchangeAccount(connection);
    setConnection({ exchange: "bybit", accountName: "", apiKey: "", apiSecret: "", passphrase: "" });
    setShowConnection(false);
    setSnapshot(await getPortfolioSnapshot());
  }

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
          <button onClick={() => setShowConnection(true)}><Plus size={14} /> Connect</button>
          <button onClick={onClose}><X size={14} /></button>
        </div>
      </header>

      <nav className="pm-tabs">
        {(["Overview", "Accounts", "Copy Trading", "Orders", "Positions", "Wallets"] as PortfolioTab[]).map((tab) => (
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

      {activeTab === "Positions" && <PortfolioPositionsPanel positions={snapshot.positions} />}

      {activeTab === "Wallets" && (
        <section className="pm-workspace split">
          <div className="pm-panel">
            <div className="pm-panel-title"><Wallet size={15} /> Browser Wallet Connectors</div>
            <button className="pm-wallet">MetaMask</button>
            <button className="pm-wallet">Phantom</button>
          </div>
          <div className="pm-empty">Wallet adapters are isolated from centralized exchange adapters and ready for DEX signing flows.</div>
        </section>
      )}

      {showConnection && (
        <div className="pm-floating">
          <div className="pm-ticket">
            <div className="pm-ticket-head"><KeyRound size={15} /> Secure Exchange Connection <button onClick={() => setShowConnection(false)}><X size={14} /></button></div>
            <select value={connection.exchange} onChange={(event) => setConnection((current) => ({ ...current, exchange: event.target.value as ExchangeId }))}>
              {marketCatalog.map((exchange) => <option key={exchange.id} value={exchange.id}>{exchange.label}</option>)}
            </select>
            <input placeholder="Account name" value={connection.accountName} onChange={(event) => setConnection((current) => ({ ...current, accountName: event.target.value }))} />
            <input placeholder="API key" value={connection.apiKey} onChange={(event) => setConnection((current) => ({ ...current, apiKey: event.target.value }))} />
            <input placeholder="API secret" type="password" value={connection.apiSecret} onChange={(event) => setConnection((current) => ({ ...current, apiSecret: event.target.value }))} />
            <input placeholder="Passphrase, if required" type="password" value={connection.passphrase} onChange={(event) => setConnection((current) => ({ ...current, passphrase: event.target.value }))} />
            <button className="primary" onClick={handleConnectAccount}>Store Secure Reference</button>
          </div>
        </div>
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
